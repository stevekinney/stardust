import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../db';
import { sandboxCommands, sandboxes, sandboxSnapshots } from '../db';
import {
	DEFAULT_ALLOWED_ENVIRONMENT_VARIABLES,
	DEFAULT_COMMAND_TIMEOUT_MS,
	DEFAULT_OUTPUT_CAPTURE_BYTES
} from './sandbox-budget';
import { SandboxError } from './sandbox-errors';
import {
	resolveWorkspacePath,
	sandboxNameForSession,
	workspacePathForSession
} from './sandbox-names';
import type {
	SandboxCommandInput,
	SandboxCommandResult,
	SandboxEphemeralCommandInput,
	SandboxEphemeralSandbox,
	SandboxFileInput,
	SandboxProcessKillInput,
	SandboxProcessKillResult,
	SandboxProcessStartInput,
	SandboxProcessStartResult,
	SandboxProvider,
	SandboxRunCommandOptions,
	SandboxSnapshotInput,
	SandboxSnapshotResult,
	SandboxWriteFileInput
} from './sandbox-provider';

interface LocalSubprocessSandboxProviderOptions {
	workspaceRoot?: string;
	database?: DatabaseClient;
	commandTimeoutMs?: number;
	outputCaptureBytes?: number;
	allowedEnvironmentVariables?: string[];
}

interface TrackedProcess {
	id: string;
	sessionKey: string;
	workspacePath: string;
	child: ChildProcess;
	killed: boolean;
	timedOut: boolean;
	forceKillTimer?: NodeJS.Timeout;
}

interface UtilityCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export class LocalSubprocessSandboxProvider implements SandboxProvider {
	readonly name = 'local-subprocess';

	private readonly workspaceRoot: string;
	private readonly database?: DatabaseClient;
	private readonly commandTimeoutMs: number;
	private readonly outputCaptureBytes: number;
	private readonly allowedEnvironmentVariables: Set<string>;
	private readonly trackedProcesses = new Map<string, TrackedProcess>();

	constructor(options: LocalSubprocessSandboxProviderOptions = {}) {
		this.workspaceRoot = resolve(
			options.workspaceRoot ?? join(homedir(), '.stardust', 'workspaces')
		);
		this.database = options.database;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.outputCaptureBytes = options.outputCaptureBytes ?? DEFAULT_OUTPUT_CAPTURE_BYTES;
		this.allowedEnvironmentVariables = new Set(
			options.allowedEnvironmentVariables ?? DEFAULT_ALLOWED_ENVIRONMENT_VARIABLES
		);
	}

	get trackedProcessCount(): number {
		return this.trackedProcesses.size;
	}

	async ensureWorkspace(sessionKey: string): Promise<string> {
		const name = sandboxNameForSession(sessionKey);
		const workspacePath = workspacePathForSession(this.workspaceRoot, sessionKey);
		await mkdir(workspacePath, { recursive: true });

		if (!(await pathExists(join(workspacePath, '.git')))) {
			await this.runUtilityCommand('git', ['init'], workspacePath);
			await this.runUtilityCommand(
				'git',
				['config', 'user.email', 'stardust@localhost'],
				workspacePath
			);
			await this.runUtilityCommand(
				'git',
				['config', 'user.name', 'Stardust Sandbox'],
				workspacePath
			);
		}

		await this.recordSandbox(sessionKey, name, workspacePath);
		return workspacePath;
	}

	async readFile(input: SandboxFileInput): Promise<string> {
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
		const filePath = resolveWorkspacePath(workspacePath, input.path);
		return readFile(filePath, 'utf8');
	}

	async writeFile(input: SandboxWriteFileInput): Promise<void> {
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
		const filePath = resolveWorkspacePath(workspacePath, input.path);
		await mkdir(dirname(filePath), { recursive: true });
		if (input.encoding === 'base64') {
			await writeFile(filePath, Buffer.from(input.contents, 'base64'));
		} else {
			await writeFile(filePath, input.contents, 'utf8');
		}
	}

	async runCommand(
		input: SandboxCommandInput,
		options?: SandboxRunCommandOptions
	): Promise<SandboxCommandResult> {
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
		return this.runCommandInWorkspace(
			input,
			workspacePath,
			this.workspaceRoot,
			options?.signal,
			options?.onStart
		);
	}

	async startProcess(input: SandboxProcessStartInput): Promise<SandboxProcessStartResult> {
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
		const id = randomUUID();
		const args = input.args ?? [];
		const startedAt = new Date().toISOString();
		const commandCwd = resolveWorkspacePath(workspacePath, input.cwd);
		let stdout = '';
		let stderr = '';

		const child = spawn(input.command, args, {
			cwd: commandCwd,
			detached: true,
			env: this.buildEnvironment(input.env, this.workspaceRoot),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const pid = child.pid ?? null;
		const tracked: TrackedProcess = {
			id,
			sessionKey: input.sessionKey,
			workspacePath,
			child,
			killed: false,
			timedOut: false
		};
		this.trackedProcesses.set(id, tracked);

		await this.recordCommand({
			id,
			input,
			status: 'running',
			startedAt,
			completedAt: null,
			exitCode: null,
			pid,
			processGroupId: pid,
			background: true
		});

		child.stdout.on('data', (chunk: Buffer) => {
			stdout = appendCapturedOutput(stdout, chunk, this.outputCaptureBytes);
		});

		child.stderr.on('data', (chunk: Buffer) => {
			stderr = appendCapturedOutput(stderr, chunk, this.outputCaptureBytes);
		});

		child.on('error', (error) => {
			stderr = appendCapturedOutput(stderr, Buffer.from(error.message), this.outputCaptureBytes);
		});

		child.on('close', (exitCode) => {
			if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
			this.trackedProcesses.delete(id);
			const completedAt = new Date().toISOString();
			const status = tracked.killed ? 'killed' : exitCode === 0 ? 'complete' : 'failed';
			void this.recordCommand({
				id,
				input,
				status,
				startedAt,
				completedAt,
				exitCode: tracked.killed ? null : exitCode,
				stdout,
				stderr,
				pid,
				processGroupId: pid,
				background: true
			});
		});

		return {
			processId: id,
			sessionKey: input.sessionKey,
			workspacePath,
			command: input.command,
			args,
			status: 'running',
			pid,
			processGroupId: pid,
			startedAt
		};
	}

	private async runCommandInWorkspace(
		input: SandboxCommandInput,
		workspacePath: string,
		homePath: string,
		signal?: AbortSignal,
		onStart?: (info: { id: string; pid: number | undefined }) => void
	): Promise<SandboxCommandResult> {
		const id = randomUUID();
		const args = input.args ?? [];
		const startedAt = new Date().toISOString();
		const commandCwd = resolveWorkspacePath(workspacePath, input.cwd);
		const timeoutMs = input.timeoutMs ?? this.commandTimeoutMs;

		await this.recordCommand({
			id,
			input,
			status: 'running',
			startedAt,
			completedAt: null,
			exitCode: null
		});

		return new Promise((resolveCommand) => {
			let stdout = '';
			let stderr = '';
			let spawnError: Error | null = null;
			const child = spawn(input.command, args, {
				cwd: commandCwd,
				detached: true,
				env: this.buildEnvironment(input.env, homePath),
				stdio: ['ignore', 'pipe', 'pipe']
			});
			const tracked: TrackedProcess = {
				id,
				sessionKey: input.sessionKey,
				workspacePath,
				child,
				killed: false,
				timedOut: false
			};
			this.trackedProcesses.set(id, tracked);

			// Notify the caller that the subprocess is alive. This is the earliest point
			// at which the command id and pid are both known, so the caller can begin a
			// heartbeat loop keyed on these values.
			onStart?.({ id, pid: child.pid });

			// Scope cancellation to this specific process. When the caller provides a
			// signal (e.g. Temporal's cancellationSignal()), only this command is killed —
			// other processes tracked for the same session are left running.
			if (signal) {
				if (signal.aborted) {
					// Signal was already aborted before we started; kill immediately.
					this.killTrackedProcess(tracked);
				} else {
					signal.addEventListener('abort', () => this.killTrackedProcess(tracked), {
						once: true
					});
				}
			}

			const timeout = setTimeout(() => {
				tracked.timedOut = true;
				this.killTrackedProcess(tracked);
			}, timeoutMs);

			child.stdout.on('data', (chunk: Buffer) => {
				stdout = appendCapturedOutput(stdout, chunk, this.outputCaptureBytes);
			});

			child.stderr.on('data', (chunk: Buffer) => {
				stderr = appendCapturedOutput(stderr, chunk, this.outputCaptureBytes);
			});

			child.on('error', (error) => {
				spawnError = error;
			});

			child.on('close', (exitCode) => {
				clearTimeout(timeout);
				if (tracked.forceKillTimer) clearTimeout(tracked.forceKillTimer);
				this.trackedProcesses.delete(id);

				if (spawnError) {
					stderr = appendCapturedOutput(
						stderr,
						Buffer.from(spawnError.message),
						this.outputCaptureBytes
					);
				}

				const completedAt = new Date().toISOString();
				const killed = tracked.killed;
				const timedOut = tracked.timedOut;
				const status = timedOut
					? 'timeout'
					: killed
						? 'killed'
						: exitCode === 0
							? 'complete'
							: 'failed';
				const result: SandboxCommandResult = {
					id,
					sessionKey: input.sessionKey,
					workspacePath,
					command: input.command,
					args,
					status,
					exitCode: timedOut || killed ? null : exitCode,
					stdout,
					stderr,
					timedOut,
					killed,
					startedAt,
					completedAt
				};

				void this.recordCommand({
					id,
					input,
					status,
					startedAt,
					completedAt,
					exitCode: result.exitCode,
					stdout,
					stderr
				}).finally(() => resolveCommand(result));
			});
		});
	}

	async snapshot(input: SandboxSnapshotInput): Promise<SandboxSnapshotResult> {
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
		await this.runUtilityCommand('git', ['add', '-A'], workspacePath);
		await this.runUtilityCommand(
			'git',
			['commit', '--allow-empty', '-m', input.reason ?? 'Stardust sandbox snapshot'],
			workspacePath
		);
		const revision = await this.runUtilityCommand('git', ['rev-parse', 'HEAD'], workspacePath);
		const gitCommitSha = revision.stdout.trim();
		const createdAt = new Date().toISOString();
		const snapshot: SandboxSnapshotResult = {
			id: gitCommitSha,
			sessionKey: input.sessionKey,
			workspacePath,
			gitCommitSha,
			createdAt
		};

		await this.recordSnapshot(input, snapshot);
		return snapshot;
	}

	async restore(sessionKey: string, gitCommitSha: string): Promise<void> {
		const workspacePath = await this.ensureWorkspace(sessionKey);
		await this.runUtilityCommand('git', ['reset', '--hard', gitCommitSha], workspacePath);
		await this.runUtilityCommand('git', ['clean', '-fd'], workspacePath);
	}

	async createEphemeralSandbox(sessionKey: string): Promise<SandboxEphemeralSandbox> {
		const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'stardust-ephemeral-')));
		let terminated = false;

		return {
			workspacePath,
			runCommand: async (input: SandboxEphemeralCommandInput) => {
				if (terminated) throw new SandboxError('Ephemeral sandbox has been terminated.');
				return this.runCommandInWorkspace({ ...input, sessionKey }, workspacePath, workspacePath);
			},
			terminate: async () => {
				if (terminated) return;
				terminated = true;
				await this.cancelWorkspace(workspacePath);
				await rm(workspacePath, { recursive: true, force: true });
			}
		};
	}

	async killProcess(input: SandboxProcessKillInput): Promise<SandboxProcessKillResult> {
		const tracked = this.trackedProcesses.get(input.processId);
		if (tracked) {
			this.killTrackedProcess(tracked, input.signal);
			await this.markProcessKilled(input.processId);
			return { processId: input.processId, killed: true, status: 'killed' };
		}

		const persisted = await this.findPersistedProcess(input.sessionKey, input.processId);
		if (!persisted?.processGroupId) {
			return { processId: input.processId, killed: false, status: 'not_found' };
		}

		try {
			process.kill(-persisted.processGroupId, input.signal ?? 'SIGTERM');
			await this.markProcessKilled(input.processId);
			return { processId: input.processId, killed: true, status: 'killed' };
		} catch {
			return { processId: input.processId, killed: false, status: 'not_found' };
		}
	}

	async cancelSession(sessionKey: string): Promise<void> {
		for (const tracked of this.trackedProcesses.values()) {
			if (tracked.sessionKey === sessionKey) {
				this.killTrackedProcess(tracked);
			}
		}
	}

	private async cancelWorkspace(workspacePath: string): Promise<void> {
		for (const tracked of this.trackedProcesses.values()) {
			if (tracked.workspacePath === workspacePath) {
				this.killTrackedProcess(tracked);
			}
		}
	}

	private buildEnvironment(
		inputEnvironment: Record<string, string | undefined> | undefined,
		homePath: string
	) {
		const environment: Record<string, string> = {
			HOME: homePath,
			PATH: process.env.PATH ?? ''
		};

		for (const name of this.allowedEnvironmentVariables) {
			const value = inputEnvironment?.[name] ?? process.env[name];
			if (value !== undefined) environment[name] = value;
		}

		return environment;
	}

	private killTrackedProcess(tracked: TrackedProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
		tracked.killed = true;
		const pid = tracked.child.pid;
		if (pid === undefined) return;

		killProcessGroupOrChild(tracked.child, signal);
		tracked.forceKillTimer ??= setTimeout(() => {
			if (this.trackedProcesses.has(tracked.id)) {
				killProcessGroupOrChild(tracked.child, 'SIGKILL');
			}
		}, 100);
		tracked.forceKillTimer.unref();
	}

	private async findPersistedProcess(
		sessionKey: string,
		processId: string
	): Promise<{ processGroupId: number | null } | null> {
		if (!this.database) return null;
		const rows = await this.database
			.select({ processGroupId: sandboxCommands.processGroupId })
			.from(sandboxCommands)
			.where(and(eq(sandboxCommands.id, processId), eq(sandboxCommands.sessionId, sessionKey)))
			.limit(1);
		return rows[0] ?? null;
	}

	private async markProcessKilled(processId: string): Promise<void> {
		if (!this.database) return;
		await this.database
			.update(sandboxCommands)
			.set({ status: 'killed', completedAt: new Date().toISOString() })
			.where(eq(sandboxCommands.id, processId));
	}

	private async runUtilityCommand(
		command: string,
		args: string[],
		cwd: string
	): Promise<UtilityCommandResult> {
		const result = await new Promise<UtilityCommandResult>((resolveCommand) => {
			let stdout = '';
			let stderr = '';
			const child = spawn(command, args, {
				cwd,
				env: { ...process.env, HOME: this.workspaceRoot },
				stdio: ['ignore', 'pipe', 'pipe']
			});

			child.stdout.on('data', (chunk: Buffer) => {
				stdout = appendCapturedOutput(stdout, chunk, this.outputCaptureBytes);
			});

			child.stderr.on('data', (chunk: Buffer) => {
				stderr = appendCapturedOutput(stderr, chunk, this.outputCaptureBytes);
			});

			child.on('error', (error) => {
				stderr = appendCapturedOutput(stderr, Buffer.from(error.message), this.outputCaptureBytes);
			});

			child.on('close', (exitCode) => {
				resolveCommand({ exitCode, stdout, stderr });
			});
		});

		if (result.exitCode !== 0) {
			throw new SandboxError(
				`Sandbox utility command failed: ${command} ${args.join(' ')}\n${result.stderr}`
			);
		}

		return result;
	}

	private async recordSandbox(
		sessionKey: string,
		name: string,
		workspacePath: string
	): Promise<void> {
		if (!this.database) return;

		const now = new Date().toISOString();
		await this.database
			.insert(sandboxes)
			.values({
				id: name,
				sessionId: sessionKey,
				name,
				provider: this.name,
				workspacePath,
				status: 'active',
				gitInitialized: true,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: sandboxes.name,
				set: {
					status: 'active',
					workspacePath,
					gitInitialized: true,
					updatedAt: now
				}
			});
	}

	private async recordSnapshot(
		input: SandboxSnapshotInput,
		snapshot: SandboxSnapshotResult
	): Promise<void> {
		if (!this.database) return;

		await this.database.insert(sandboxSnapshots).values({
			id: snapshot.id,
			sandboxId: sandboxNameForSession(input.sessionKey),
			sessionId: input.sessionKey,
			runId: input.runId,
			toolCallId: input.toolCallId,
			externalSnapshotId: snapshot.gitCommitSha,
			reason: input.reason,
			createdAt: snapshot.createdAt
		});
	}

	private async recordCommand(input: {
		id: string;
		input: SandboxCommandInput;
		status: 'running' | SandboxCommandResult['status'];
		startedAt: string;
		completedAt: string | null;
		exitCode: number | null;
		stdout?: string;
		stderr?: string;
		pid?: number | null;
		processGroupId?: number | null;
		background?: boolean;
	}): Promise<void> {
		if (!this.database) return;

		await this.database
			.insert(sandboxCommands)
			.values({
				id: input.id,
				sandboxId: sandboxNameForSession(input.input.sessionKey),
				sessionId: input.input.sessionKey,
				runId: input.input.runId,
				toolCallId: input.input.toolCallId,
				command: input.input.command,
				args: JSON.stringify(input.input.args ?? []),
				pid: input.pid,
				processGroupId: input.processGroupId,
				background: input.background ?? false,
				status: input.status,
				exitCode: input.exitCode,
				stdoutRef: input.stdout,
				stderrRef: input.stderr,
				startedAt: input.startedAt,
				completedAt: input.completedAt ?? undefined
			})
			.onConflictDoUpdate({
				target: sandboxCommands.id,
				set: {
					status: input.status,
					exitCode: input.exitCode,
					stdoutRef: input.stdout,
					stderrRef: input.stderr,
					pid: input.pid,
					processGroupId: input.processGroupId,
					background: input.background ?? false,
					completedAt: input.completedAt ?? undefined
				}
			});
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function appendCapturedOutput(existing: string, chunk: Buffer, maxBytes: number): string {
	const combined = `${existing}${chunk.toString('utf8')}`;
	if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
	return combined.slice(combined.length - maxBytes);
}

function killProcessGroupOrChild(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) return;

	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process may have exited between lookup and kill.
		}
	}
}
