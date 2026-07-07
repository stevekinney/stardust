/**
 * In-composer `/command` grammar for the chat input (BUG-002 / OPENCLAW-GAPS.md).
 * Pure command definitions and fuzzy filtering — no DOM or Svelte here so this
 * stays trivially unit-testable. The composer-level interception, ARIA wiring,
 * and DOM access live in `conversation-view.svelte`.
 */

/** Context a command needs to decide availability and perform its action. */
export type SlashCommandContext = {
	running: boolean;
	hasRetry: boolean;
	hasPendingApproval: boolean;
	onInterrupt: () => void;
	onRetry: () => void;
	/** Creates a new session and navigates to it. */
	createSession: () => Promise<string>;
	/** Navigates to the approvals inbox. */
	openApprovals: () => void;
	listTools: () => Promise<Array<{ name: string; description: string; risk: string }>>;
	listCommands: () => Array<{ name: string; description: string }>;
};

export type SlashCommandOutcome =
	| { kind: 'close' }
	| { kind: 'info'; title: string; lines: string[] };

export type SlashCommand = {
	/** Stable id used for DOM ids (`aria-activedescendant`) and fuzzy matching — no leading slash. */
	id: string;
	/** Display form, e.g. `/help`. */
	name: string;
	description: string;
	/** Returns a human-readable reason the command can't run right now, or `null` if available. */
	unavailable: (ctx: SlashCommandContext) => string | null;
	run: (ctx: SlashCommandContext) => Promise<SlashCommandOutcome> | SlashCommandOutcome;
};

/** The minimum command set required by BUG-002: help, new, tools, stop, retry, approvals. */
export function createDefaultSlashCommands(): SlashCommand[] {
	return [
		{
			id: 'help',
			name: '/help',
			description: 'List available slash commands',
			unavailable: () => null,
			run: (ctx) => ({
				kind: 'info',
				title: 'Slash commands',
				lines: ctx.listCommands().map((command) => `${command.name} — ${command.description}`)
			})
		},
		{
			id: 'new',
			name: '/new',
			description: 'Start a new session',
			unavailable: () => null,
			run: async (ctx) => {
				await ctx.createSession();
				return { kind: 'close' };
			}
		},
		{
			id: 'tools',
			name: '/tools',
			description: "List the agent's available tools",
			unavailable: () => null,
			run: async (ctx) => {
				const tools = await ctx.listTools();
				if (tools.length === 0) {
					return { kind: 'info', title: 'Available tools', lines: ['No tools are configured.'] };
				}
				return {
					kind: 'info',
					title: `Available tools (${tools.length})`,
					lines: tools.map((tool) => `${tool.name} — ${tool.description}`)
				};
			}
		},
		{
			id: 'stop',
			name: '/stop',
			description: 'Interrupt the current run',
			unavailable: (ctx) => (ctx.running ? null : 'No run in progress to stop.'),
			run: (ctx) => {
				ctx.onInterrupt();
				return { kind: 'close' };
			}
		},
		{
			id: 'retry',
			name: '/retry',
			description: 'Retry the last turn',
			unavailable: (ctx) => (ctx.hasRetry ? null : 'No previous turn to retry.'),
			run: (ctx) => {
				ctx.onRetry();
				return { kind: 'close' };
			}
		},
		{
			id: 'approvals',
			name: '/approvals',
			description: 'Open pending approvals',
			unavailable: () => null,
			run: (ctx) => {
				ctx.openApprovals();
				return { kind: 'close' };
			}
		}
	];
}

/**
 * Subsequence-based fuzzy score against a command's id (e.g. query `"st"` matches
 * `"stop"`). Lower is a tighter match. Returns `null` when the query isn't a
 * subsequence of the target at all.
 */
function fuzzyScore(target: string, query: string): number | null {
	let searchFrom = 0;
	let score = 0;
	let lastMatchIndex = -1;
	for (const character of query) {
		const index = target.indexOf(character, searchFrom);
		if (index === -1) return null;
		score += index - lastMatchIndex;
		lastMatchIndex = index;
		searchFrom = index + 1;
	}
	return score;
}

/** Fuzzy-filters and ranks commands by how tightly their id matches the query. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return commands;
	return commands
		.map((command) => ({ command, score: fuzzyScore(command.id, normalized) }))
		.filter((entry): entry is { command: SlashCommand; score: number } => entry.score !== null)
		.sort((a, b) => a.score - b.score)
		.map((entry) => entry.command);
}
