export type SandboxProviderName = 'local-subprocess';

export type SandboxCommandStatus = 'complete' | 'failed' | 'timeout' | 'killed';

export interface SandboxCommandInput {
	sessionKey: string;
	runId: string;
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	toolCallId?: string;
}

export interface SandboxCommandResult {
	id: string;
	sessionKey: string;
	workspacePath: string;
	command: string;
	args: string[];
	status: SandboxCommandStatus;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	killed: boolean;
	startedAt: string;
	completedAt: string;
}

export interface SandboxFileInput {
	sessionKey: string;
	path: string;
}

export interface SandboxWriteFileInput extends SandboxFileInput {
	contents: string;
}

export interface SandboxSnapshotInput {
	sessionKey: string;
	runId?: string;
	toolCallId?: string;
	reason?: string;
}

export interface SandboxSnapshotResult {
	id: string;
	sessionKey: string;
	workspacePath: string;
	gitCommitSha: string;
	createdAt: string;
}

export type SandboxEphemeralCommandInput = Omit<SandboxCommandInput, 'sessionKey'>;

export interface SandboxEphemeralSandbox {
	readonly workspacePath: string;
	runCommand(input: SandboxEphemeralCommandInput): Promise<SandboxCommandResult>;
	terminate(): Promise<void>;
}

/** Information about a sandbox subprocess that has been spawned. */
export interface SandboxCommandStartInfo {
	/** Internal UUID assigned to this command invocation. */
	id: string;
	/** OS process id of the spawned subprocess, if available. */
	pid: number | undefined;
}

/** Options for running a sandbox command. */
export interface SandboxRunCommandOptions {
	/**
	 * An AbortSignal scoped to this command invocation. When the signal fires, only
	 * this command's process is killed — other processes tracked for the same session
	 * are left untouched. Pass `Context.current().cancellationSignal` (or the
	 * `cancellationSignal()` shorthand) from `@temporalio/activity` to integrate with
	 * Temporal Activity cancellation without tearing down the whole session.
	 */
	signal?: AbortSignal;
	/**
	 * Called once the subprocess has been spawned, before it exits. Use this to start
	 * a heartbeat loop keyed on the command id and pid, so that the caller can detect
	 * and cancel the command even if it runs for a long time.
	 */
	onStart?: (info: SandboxCommandStartInfo) => void;
}

export interface SandboxProvider {
	readonly name: SandboxProviderName;

	ensureWorkspace(sessionKey: string): Promise<string>;
	readFile(input: SandboxFileInput): Promise<string>;
	writeFile(input: SandboxWriteFileInput): Promise<void>;
	runCommand(
		input: SandboxCommandInput,
		options?: SandboxRunCommandOptions
	): Promise<SandboxCommandResult>;
	snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotResult>;
	restore(sessionKey: string, gitCommitSha: string): Promise<void>;
	createEphemeralSandbox(sessionKey: string): Promise<SandboxEphemeralSandbox>;
	killProcess(processId: string): Promise<boolean>;
	cancelSession(sessionKey: string): Promise<void>;
}
