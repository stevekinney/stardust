import type { z } from 'zod';
import type { ToolCallInput } from '@src/lib/types';
import type { DatabaseClient } from '../db/client';
import type { ArtifactStore } from '../artifacts/artifact-store';
import type { MemoryCandidate, MemoryLayer, MemorySearchResult } from '../memory';
import type { toolInvocations } from '../db/schema';
import type {
	SandboxCommandInput,
	SandboxCommandResult,
	SandboxProcessKillInput,
	SandboxProcessKillResult,
	SandboxProcessStartInput,
	SandboxProcessStartResult,
	SandboxProvider
} from '../sandbox/sandbox-provider';
import type { verificationRunInput, workspaceDiffInput } from './tool-definitions';

/**
 * Full dependency surface accepted by {@link executeToolCall} and
 * {@link executeNewToolCall} (in `execute-tool-call.ts` and
 * `execute-new-tool-call.ts` respectively). Shared here so both files — and
 * the small helpers below — can agree on one shape without importing from
 * each other.
 */
export type ExecuteToolCallInput = {
	call: ToolCallInput;
	sessionId?: string;
	/** Session key used as the sandbox workspace key (UUIDv4 for normal sessions,
	 *  `sched-{scheduleId}` for scheduled sessions). */
	sessionKey?: string;
	runId?: string;
	/** Retained for callers that still pass the workspace path for system-prompt construction.
	 *  Workspace operations now route through `sandboxProvider` using `sessionKey`. */
	workspacePath?: string;
	fetcher?: typeof fetch;
	approved?: boolean;
	database?: DatabaseClient;
	artifactStore?: ArtifactStore;
	/** Sandbox provider used for all workspace, shell, and snapshot tool operations. */
	sandboxProvider?: SandboxProvider;
	/** Heartbeat-aware Temporal Activity wrapper for sandbox subprocess execution. */
	runSandboxCommand?: (input: SandboxCommandInput) => Promise<SandboxCommandResult>;
	startSandboxProcess?: (input: SandboxProcessStartInput) => Promise<SandboxProcessStartResult>;
	killSandboxProcess?: (input: SandboxProcessKillInput) => Promise<SandboxProcessKillResult>;
	searchMemory?: (input: {
		sessionId: string;
		query: string;
		layers?: MemoryLayer[];
		limit?: number;
	}) => Promise<MemorySearchResult[]>;
	writeMemoryCandidate?: (input: {
		sessionId: string;
		runId: string;
		layer: MemoryLayer;
		content: string;
		tags?: string[];
		reason?: string | null;
	}) => Promise<MemoryCandidate>;
};

/**
 * Require a sandbox provider and session key for operations that must execute
 * through the provider boundary. Throws with a descriptive error if either is
 * missing — this is a programming error, not a user-facing error.
 *
 * Returns `[provider, sessionKey]` as a typed tuple so callers can destructure
 * and let TypeScript narrow both to non-optional types.
 */
export function requireSandbox(
	sandboxProvider: SandboxProvider | undefined,
	sessionKey: string | undefined
): [SandboxProvider, string] {
	if (!sandboxProvider) {
		throw new Error('sandboxProvider is required for this tool but was not provided');
	}
	if (!sessionKey) {
		throw new Error('sessionKey is required for sandbox-routed tools but was not provided');
	}
	return [sandboxProvider, sessionKey];
}

/** Requires an injected sandbox command runner, throwing a descriptive error otherwise. */
export function requireCommandRunner(
	commandRunner: ((input: SandboxCommandInput) => Promise<SandboxCommandResult>) | undefined
): (input: SandboxCommandInput) => Promise<SandboxCommandResult> {
	if (!commandRunner) {
		throw new Error('runSandboxCommand is required for command-backed tools but was not provided');
	}
	return commandRunner;
}

/** Requires both `sessionKey` and `runId` on the execution input, throwing a descriptive error otherwise. */
export function requireSessionRun(input: { sessionKey?: string; runId?: string }): {
	sessionKey: string;
	runId: string;
} {
	if (!input.sessionKey) {
		throw new Error('sessionKey is required for session-scoped tools but was not provided');
	}
	if (!input.runId) {
		throw new Error('runId is required for run-scoped tools but was not provided');
	}
	return { sessionKey: input.sessionKey, runId: input.runId };
}

/** Maps the model-facing memory layer name (hyphenated) to the storage layer name (underscored). */
export function toMemoryLayer(layer: 'session' | 'durable' | 'action-sensitive'): MemoryLayer {
	return layer === 'action-sensitive' ? 'action_sensitive' : layer;
}

/** Builds the `git diff` argv for `workspace.diff` from its parsed input. */
export function diffCommandArguments(input: z.infer<typeof workspaceDiffInput>): string[] {
	const args = ['diff', `--unified=${input.contextLines}`];
	if (input.base && input.head) args.push(input.base, input.head);
	else if (input.base) args.push(input.base);
	else if (input.head) args.push('HEAD', input.head);
	if (input.path) args.push('--', input.path);
	return args;
}

/** Builds the `bun run <check>` argv for `verification.run` from its parsed input. */
export function verificationCommand(input: z.infer<typeof verificationRunInput>): {
	command: string;
	args: string[];
} {
	return { command: 'bun', args: ['run', input.check, ...input.args] };
}

/** Renders the Markdown body persisted by `artifact.createReport`. */
export function createReportMarkdown(input: {
	title: string;
	summary?: string;
	sections: Array<{ heading: string; body: string }>;
	toolRows: Array<typeof toolInvocations.$inferSelect>;
	includeToolResults: boolean;
}): string {
	const lines = [`# ${input.title}`, ''];
	if (input.summary) lines.push(input.summary, '');
	for (const section of input.sections) {
		lines.push(`## ${section.heading}`, '', section.body, '');
	}
	if (input.includeToolResults) {
		lines.push('## Tool Evidence', '');
		for (const tool of input.toolRows) {
			lines.push(`### ${tool.toolName}`, '');
			lines.push(`- Status: ${tool.status}`);
			lines.push(`- Risk: ${tool.risk}`);
			lines.push(`- Task queue: ${tool.taskQueue}`);
			if (tool.resultRef) lines.push(`- Artifact: ${tool.resultRef}`);
			if (tool.resultInline) lines.push('', '```json', tool.resultInline, '```');
			lines.push('');
		}
		if (input.toolRows.length === 0) lines.push('No tool invocations were recorded.', '');
	}
	return `${lines.join('\n').trimEnd()}\n`;
}
