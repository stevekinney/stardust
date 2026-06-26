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

export interface SandboxEphemeralDirectory {
	path: string;
	remove(): Promise<void>;
}

export interface SandboxProvider {
	readonly name: SandboxProviderName;

	ensureWorkspace(sessionKey: string): Promise<string>;
	readFile(input: SandboxFileInput): Promise<string>;
	writeFile(input: SandboxWriteFileInput): Promise<void>;
	runCommand(input: SandboxCommandInput): Promise<SandboxCommandResult>;
	snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotResult>;
	restore(sessionKey: string, gitCommitSha: string): Promise<void>;
	createEphemeralDirectory(sessionKey: string): Promise<SandboxEphemeralDirectory>;
	killProcess(processId: string): Promise<boolean>;
	cancelSession(sessionKey: string): Promise<void>;
}
