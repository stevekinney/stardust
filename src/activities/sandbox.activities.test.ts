/**
 * Regression tests for the runSandboxCommand Activity.
 *
 * The bug: the original implementation had a `finally` block that called
 * `cancelSession(sessionKey)` after EVERY command — normal completion included.
 * `cancelSession` kills ALL tracked processes for the session, so completing a
 * foreground command would kill any concurrently running background process.
 *
 * The fix: remove the `finally` block; pass `cancellationSignal()` to
 * `runCommand` so that only this command's process is killed on Activity
 * cancellation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted() runs before vi.mock() factories, making the variable available
// inside the factory closure without triggering "cannot access before init".
const mockProvider = vi.hoisted(() => ({
	name: 'local-subprocess' as const,
	ensureWorkspace: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	runCommand: vi.fn(),
	snapshot: vi.fn(),
	restore: vi.fn(),
	createEphemeralSandbox: vi.fn(),
	killProcess: vi.fn(),
	cancelSession: vi.fn()
}));

// vi.mock() calls are hoisted by Vitest before static imports below.
vi.mock('@temporalio/activity', () => {
	const controller = new AbortController();
	return {
		heartbeat: vi.fn(),
		cancellationSignal: vi.fn(() => controller.signal)
	};
});

vi.mock('@src/lib/server/db', () => ({
	db: {}
}));

vi.mock('@src/lib/server/sandbox', () => ({
	getSandboxProvider: vi.fn(() => mockProvider)
}));

import { cancellationSignal } from '@temporalio/activity';
import { runSandboxCommand } from './sandbox.activities.ts';

const commandInput = {
	sessionKey: 'session-a',
	runId: 'run-a',
	command: 'echo',
	args: ['hello']
};

const commandResult = {
	id: 'cmd-1',
	sessionKey: 'session-a',
	workspacePath: '/tmp/ws',
	command: 'echo',
	args: ['hello'],
	status: 'complete' as const,
	exitCode: 0,
	stdout: 'hello\n',
	stderr: '',
	timedOut: false,
	killed: false,
	startedAt: '2026-01-01T00:00:00.000Z',
	completedAt: '2026-01-01T00:00:01.000Z'
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProvider.runCommand.mockResolvedValue(commandResult);
});

describe('runSandboxCommand', () => {
	it('does not call cancelSession after normal completion', async () => {
		expect.assertions(1);

		await runSandboxCommand(commandInput);

		expect(mockProvider.cancelSession).not.toHaveBeenCalled();
	});

	it('passes the cancellationSignal to runCommand as the signal option', async () => {
		expect.assertions(2);

		const signal = cancellationSignal();
		await runSandboxCommand(commandInput);

		expect(mockProvider.runCommand).toHaveBeenCalledWith(commandInput, { signal });
		expect(mockProvider.cancelSession).not.toHaveBeenCalled();
	});

	it('returns the result from the provider runCommand', async () => {
		expect.assertions(1);

		const result = await runSandboxCommand(commandInput);

		expect(result).toBe(commandResult);
	});
});
