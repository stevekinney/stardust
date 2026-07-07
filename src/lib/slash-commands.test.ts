import { describe, expect, it, vi } from 'vitest';
import {
	createDefaultSlashCommands,
	filterSlashCommands,
	type SlashCommandContext
} from './slash-commands';

function makeContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
	return {
		running: false,
		hasRetry: false,
		hasPendingApproval: false,
		onInterrupt: vi.fn(),
		onRetry: vi.fn(),
		createSession: vi.fn(async () => 'ses_new'),
		openApprovals: vi.fn(),
		listTools: vi.fn(async () => []),
		listCommands: vi.fn(() => []),
		...overrides
	};
}

describe('createDefaultSlashCommands', () => {
	it('includes the minimum required command set', () => {
		const ids = createDefaultSlashCommands().map((command) => command.id);
		expect(ids).toEqual(['help', 'new', 'tools', 'stop', 'retry', 'approvals']);
	});
});

describe('filterSlashCommands', () => {
	it('returns every command for an empty query', () => {
		const commands = createDefaultSlashCommands();
		expect(filterSlashCommands(commands, '')).toHaveLength(commands.length);
	});

	it('fuzzy-matches a subsequence of the command id', () => {
		const commands = createDefaultSlashCommands();
		const results = filterSlashCommands(commands, 'st').map((command) => command.id);
		expect(results).toContain('stop');
	});

	it('ranks tighter matches first', () => {
		const commands = createDefaultSlashCommands();
		// "too" is a tight subsequence of "tools" but a looser one of nothing else.
		const results = filterSlashCommands(commands, 'too').map((command) => command.id);
		expect(results[0]).toBe('tools');
	});

	it('excludes commands that do not contain the query as a subsequence', () => {
		const commands = createDefaultSlashCommands();
		const results = filterSlashCommands(commands, 'zzz');
		expect(results).toHaveLength(0);
	});

	it('is case-insensitive', () => {
		const commands = createDefaultSlashCommands();
		const results = filterSlashCommands(commands, 'HELP').map((command) => command.id);
		expect(results).toContain('help');
	});
});

describe('command availability', () => {
	it('/stop is unavailable when no run is in progress', () => {
		const stop = createDefaultSlashCommands().find((command) => command.id === 'stop')!;
		expect(stop.unavailable(makeContext({ running: false }))).toMatch(/no run in progress/i);
		expect(stop.unavailable(makeContext({ running: true }))).toBeNull();
	});

	it('/retry is unavailable when there is no previous turn to retry', () => {
		const retry = createDefaultSlashCommands().find((command) => command.id === 'retry')!;
		expect(retry.unavailable(makeContext({ hasRetry: false }))).toMatch(/no previous turn/i);
		expect(retry.unavailable(makeContext({ hasRetry: true }))).toBeNull();
	});

	it('/help, /new, /tools, /approvals are always available', () => {
		const ctx = makeContext();
		for (const id of ['help', 'new', 'tools', 'approvals']) {
			const command = createDefaultSlashCommands().find((c) => c.id === id)!;
			expect(command.unavailable(ctx)).toBeNull();
		}
	});
});

describe('command execution', () => {
	it('/stop invokes onInterrupt and closes', async () => {
		const onInterrupt = vi.fn();
		const stop = createDefaultSlashCommands().find((command) => command.id === 'stop')!;
		const outcome = await stop.run(makeContext({ running: true, onInterrupt }));
		expect(onInterrupt).toHaveBeenCalledOnce();
		expect(outcome).toEqual({ kind: 'close' });
	});

	it('/retry invokes onRetry and closes', async () => {
		const onRetry = vi.fn();
		const retry = createDefaultSlashCommands().find((command) => command.id === 'retry')!;
		const outcome = await retry.run(makeContext({ hasRetry: true, onRetry }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(outcome).toEqual({ kind: 'close' });
	});

	it('/new creates a session and closes', async () => {
		const createSession = vi.fn(async () => 'ses_abc');
		const command = createDefaultSlashCommands().find((c) => c.id === 'new')!;
		const outcome = await command.run(makeContext({ createSession }));
		expect(createSession).toHaveBeenCalledOnce();
		expect(outcome).toEqual({ kind: 'close' });
	});

	it('/approvals opens the inbox and closes', () => {
		const openApprovals = vi.fn();
		const command = createDefaultSlashCommands().find((c) => c.id === 'approvals')!;
		const outcome = command.run(makeContext({ openApprovals }));
		expect(openApprovals).toHaveBeenCalledOnce();
		expect(outcome).toEqual({ kind: 'close' });
	});

	it('/help returns an info outcome listing every command', async () => {
		const listCommands = vi.fn(() => [{ name: '/stop', description: 'Interrupt the current run' }]);
		const command = createDefaultSlashCommands().find((c) => c.id === 'help')!;
		const outcome = await command.run(makeContext({ listCommands }));
		expect(outcome.kind).toBe('info');
		if (outcome.kind === 'info') {
			expect(outcome.lines[0]).toContain('/stop');
		}
	});

	it('/tools returns an info outcome listing the tool manifest', async () => {
		const listTools = vi.fn(async () => [
			{ name: 'shell.exec', description: 'Runs a shell command', risk: 'high' }
		]);
		const command = createDefaultSlashCommands().find((c) => c.id === 'tools')!;
		const outcome = await command.run(makeContext({ listTools }));
		expect(outcome.kind).toBe('info');
		if (outcome.kind === 'info') {
			expect(outcome.title).toContain('1');
			expect(outcome.lines[0]).toContain('shell.exec');
		}
	});

	it('/tools reports when no tools are configured', async () => {
		const command = createDefaultSlashCommands().find((c) => c.id === 'tools')!;
		const outcome = await command.run(makeContext({ listTools: vi.fn(async () => []) }));
		expect(outcome).toEqual({
			kind: 'info',
			title: 'Available tools',
			lines: ['No tools are configured.']
		});
	});
});
