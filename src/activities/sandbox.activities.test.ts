/**
 * Regression tests for the runSandboxCommand Activity.
 *
 * Original bug: the implementation had a `finally` block that called
 * `cancelSession(sessionKey)` after EVERY command — normal completion included.
 * `cancelSession` kills ALL tracked processes for the session, so completing a
 * foreground command would kill any concurrently running background process.
 *
 * Fix: remove the `finally` block; pass `cancellationSignal()` to `runCommand`
 * so that only this command's process is killed on Activity cancellation.
 *
 * Heartbeat fix: the original implementation heartbeated only once before the
 * command started. Temporal needs periodic heartbeats to reliably deliver
 * cancellation for long-running commands. The activity now heartbeats once via
 * `onStart` and then at a fixed interval until the command completes or fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { cancellationSignal, heartbeat } from '@temporalio/activity';
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

	it('passes the cancellationSignal and an onStart callback to runCommand', async () => {
		expect.assertions(3);

		const signal = cancellationSignal();
		await runSandboxCommand(commandInput);

		expect(mockProvider.runCommand).toHaveBeenCalledWith(
			commandInput,
			expect.objectContaining({ signal, onStart: expect.any(Function) })
		);
		expect(mockProvider.cancelSession).not.toHaveBeenCalled();
		expect(mockProvider.runCommand).toHaveBeenCalledTimes(1);
	});

	it('returns the result from the provider runCommand', async () => {
		expect.assertions(1);

		const result = await runSandboxCommand(commandInput);

		expect(result).toBe(commandResult);
	});

	describe('periodic heartbeats', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('heartbeats immediately when the subprocess starts, with session key, command id, command text, and pid', async () => {
			expect.assertions(2);

			vi.useFakeTimers();

			const commandId = 'cmd-uuid-1';
			const pid = 12345;

			mockProvider.runCommand.mockImplementation(
				(_input: unknown, options: { onStart: (info: { id: string; pid: number }) => void }) => {
					options.onStart({ id: commandId, pid });
					return Promise.resolve(commandResult);
				}
			);

			await runSandboxCommand(commandInput);

			expect(heartbeat).toHaveBeenCalledTimes(1);
			expect(heartbeat).toHaveBeenCalledWith({
				sessionKey: commandInput.sessionKey,
				commandId,
				command: commandInput.command,
				pid
			});
		});

		it('heartbeats again after each interval while the subprocess is running', async () => {
			expect.assertions(3);

			vi.useFakeTimers();

			const commandId = 'cmd-uuid-2';
			const pid = 54321;

			let resolveRun!: (result: typeof commandResult) => void;
			const runPromise = new Promise<typeof commandResult>((resolve) => {
				resolveRun = resolve;
			});

			mockProvider.runCommand.mockImplementation(
				(_input: unknown, options: { onStart: (info: { id: string; pid: number }) => void }) => {
					options.onStart({ id: commandId, pid });
					return runPromise;
				}
			);

			const activityPromise = runSandboxCommand(commandInput);

			// One heartbeat on start.
			expect(vi.mocked(heartbeat)).toHaveBeenCalledTimes(1);

			// Advance past one interval — another heartbeat fires.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(vi.mocked(heartbeat)).toHaveBeenCalledTimes(2);

			// Advance past a second interval — one more.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(vi.mocked(heartbeat)).toHaveBeenCalledTimes(3);

			// Resolve the command and let the activity clean up.
			resolveRun(commandResult);
			await activityPromise;
		});

		it('stops heartbeating after the command resolves', async () => {
			expect.assertions(2);

			vi.useFakeTimers();

			const commandId = 'cmd-uuid-3';
			const pid = 99999;

			let resolveRun!: (result: typeof commandResult) => void;
			const runPromise = new Promise<typeof commandResult>((resolve) => {
				resolveRun = resolve;
			});

			mockProvider.runCommand.mockImplementation(
				(_input: unknown, options: { onStart: (info: { id: string; pid: number }) => void }) => {
					options.onStart({ id: commandId, pid });
					return runPromise;
				}
			);

			const activityPromise = runSandboxCommand(commandInput);

			// Tick once to get one interval heartbeat.
			await vi.advanceTimersByTimeAsync(5_000);
			const heartbeatCountBeforeResolve = vi.mocked(heartbeat).mock.calls.length;

			// Resolve the command — the interval must be cleared.
			resolveRun(commandResult);
			await activityPromise;

			// Advancing time further must NOT produce more heartbeats.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(vi.mocked(heartbeat)).toHaveBeenCalledTimes(heartbeatCountBeforeResolve);
			expect(heartbeatCountBeforeResolve).toBeGreaterThan(0);
		});

		it('clears the heartbeat interval even when the command rejects', async () => {
			expect.assertions(2);

			vi.useFakeTimers();

			const commandId = 'cmd-uuid-4';
			const pid = 11111;
			const commandError = new Error('command failed unexpectedly');

			let rejectRun!: (error: Error) => void;
			const runPromise = new Promise<typeof commandResult>((_resolve, reject) => {
				rejectRun = reject;
			});

			mockProvider.runCommand.mockImplementation(
				(_input: unknown, options: { onStart: (info: { id: string; pid: number }) => void }) => {
					options.onStart({ id: commandId, pid });
					return runPromise;
				}
			);

			const activityPromise = runSandboxCommand(commandInput);

			// Tick once to get one interval heartbeat.
			await vi.advanceTimersByTimeAsync(5_000);
			const heartbeatCountBeforeReject = vi.mocked(heartbeat).mock.calls.length;

			// Reject the command — the interval must be cleared in the finally block.
			rejectRun(commandError);
			await expect(activityPromise).rejects.toThrow('command failed unexpectedly');

			// Advancing time further must NOT produce more heartbeats.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(vi.mocked(heartbeat)).toHaveBeenCalledTimes(heartbeatCountBeforeReject);
		});
	});
});
