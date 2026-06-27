import { cancellationSignal, heartbeat } from '@temporalio/activity';
import { db } from '@src/lib/server/db';
import { getSandboxProvider } from '@src/lib/server/sandbox';
import type {
	SandboxCommandInput,
	SandboxCommandResult,
	SandboxEphemeralCommandInput,
	SandboxFileInput,
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

export async function runSandboxCommand(input: SandboxCommandInput): Promise<SandboxCommandResult> {
	heartbeat({ sessionKey: input.sessionKey, command: input.command });
	// Pass the Temporal cancellation signal so that Activity cancellation kills only
	// this command's process. Other processes tracked for the same session (e.g. a
	// background process started by process.start) are left running. Whole-session
	// cleanup on run/session cancellation is the responsibility of a dedicated cancel
	// activity, not this per-command invocation.
	//
	// Note: the Activity heartbeats only once. Ongoing heartbeats are needed for
	// Temporal to reliably deliver the cancellation signal during long commands.
	// That is a pre-existing gap; adding periodic heartbeats is a separate concern.
	return sandboxProvider.runCommand(input, { signal: cancellationSignal() });
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
