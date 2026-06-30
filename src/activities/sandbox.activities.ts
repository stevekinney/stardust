import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { db } from '@src/lib/server/db';
import { getSandboxProvider } from '@src/lib/server/sandbox';
import type {
	SandboxCommandInput,
	SandboxCommandResult,
	SandboxEphemeralCommandInput,
	SandboxFileInput,
	SandboxProcessKillInput,
	SandboxProcessKillResult,
	SandboxProcessStartInput,
	SandboxProcessStartResult,
	SandboxSnapshotInput,
	SandboxSnapshotResult,
	SandboxWriteFileInput
} from '@src/lib/server/sandbox';

const sandboxProvider = getSandboxProvider({ database: db });

export async function ensureSandboxWorkspace(sessionKey: string): Promise<string> {
	return sandboxProvider.ensureWorkspace(sessionKey);
}

export async function readSandboxFile(input: SandboxFileInput): Promise<string> {
	return sandboxProvider.readFile(input);
}

export async function writeSandboxFile(input: SandboxWriteFileInput): Promise<void> {
	await sandboxProvider.writeFile(input);
}

/**
 * How often (in milliseconds) the activity heartbeats while a sandbox command is running.
 * Temporal needs periodic heartbeats to detect a stalled or cancelled activity; this value
 * should be well under the `heartbeatTimeout` configured on the activity schedule.
 */
const SANDBOX_HEARTBEAT_INTERVAL_MS = 5_000;

export async function runSandboxCommand(input: SandboxCommandInput): Promise<SandboxCommandResult> {
	// Pass the Temporal cancellation signal so that Activity cancellation kills only
	// this command's process. Other processes tracked for the same session (e.g. a
	// background process started by process.start) are left running. Whole-session
	// cleanup on run/session cancellation is the responsibility of a dedicated cancel
	// activity, not this per-command invocation.
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	try {
		return await sandboxProvider.runCommand(input, {
			signal: cancellationSignal(),
			onStart: ({ id, pid }) => {
				// Fire one heartbeat immediately so Temporal knows the activity is alive
				// and which subprocess to diagnose if the worker crashes.
				heartbeat({ sessionKey: input.sessionKey, commandId: id, command: input.command, pid });

				// Continue heartbeating on a fixed interval for as long as the subprocess
				// runs. This ensures Temporal can deliver cancellation reliably even for
				// commands that take longer than heartbeatTimeout to complete.
				heartbeatTimer = setInterval(() => {
					heartbeat({
						sessionKey: input.sessionKey,
						commandId: id,
						command: input.command,
						pid
					});
				}, SANDBOX_HEARTBEAT_INTERVAL_MS);

				// Do not keep the Node process alive if the activity exits for any reason
				// while the interval is still registered.
				heartbeatTimer.unref();
			}
		});
	} finally {
		clearInterval(heartbeatTimer);
	}
}

export async function startSandboxProcess(
	input: SandboxProcessStartInput
): Promise<SandboxProcessStartResult> {
	return sandboxProvider.startProcess(input);
}

export async function killSandboxProcess(
	input: SandboxProcessKillInput
): Promise<SandboxProcessKillResult> {
	return sandboxProvider.killProcess(input);
}

interface RunEphemeralSandboxCommandInput {
	sessionKey: string;
	input: SandboxEphemeralCommandInput;
}

export async function runEphemeralSandboxCommand({
	sessionKey,
	input
}: RunEphemeralSandboxCommandInput): Promise<SandboxCommandResult> {
	const sandbox = await sandboxProvider.createEphemeralSandbox(sessionKey);

	try {
		heartbeat({ sessionKey, command: input.command });
		return await sandbox.runCommand(input);
	} finally {
		await sandbox.terminate();
	}
}

export async function snapshotSandbox(input: SandboxSnapshotInput): Promise<SandboxSnapshotResult> {
	return sandboxProvider.snapshot(input);
}

interface RestoreSandboxInput {
	sessionKey: string;
	gitCommitSha: string;
}

export async function restoreSandbox(input: RestoreSandboxInput): Promise<void> {
	await sandboxProvider.restore(input.sessionKey, input.gitCommitSha);
}

/**
 * Kills all tracked processes for the given session key. Call this from a
 * Temporal workflow `finally` block (inside a `CancellationScope.nonCancellable`
 * wrapper) to guarantee that session processes are cleaned up whether the run
 * completed normally, failed, or was cancelled.
 */
export async function cancelSandboxSession(sessionKey: string): Promise<void> {
	await sandboxProvider.cancelSession(sessionKey);
}
