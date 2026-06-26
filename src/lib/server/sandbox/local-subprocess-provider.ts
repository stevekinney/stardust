import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
	SandboxEphemeralDirectory,
	SandboxFileInput,
	SandboxProvider,
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
	child: ChildProcess;
	killed: boolean;
	timedOut: boolean;
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
		await writeFile(filePath, input.contents, 'utf8');
	}

	async runCommand(input: SandboxCommandInput): Promise<SandboxCommandResult> {
		const id = randomUUID();
		const args = input.args ?? [];
		const startedAt = new Date().toISOString();
		const workspacePath = await this.ensureWorkspace(input.sessionKey);
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
				env: this.buildEnvironment(input.env),
				stdio: ['ignore', 'pipe', 'pipe']
			});
			const tracked: TrackedProcess = {
				id,
				sessionKey: input.sessionKey,
				child,
				killed: false,
				timedOut: false
			};
			this.trackedProcesses.set(id, tracked);

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

	async createEphemeralDirectory(sessionKey: string): Promise<SandboxEphemeralDirectory> {
		const workspacePath = await this.ensureWorkspace(sessionKey);
		const ephemeralRoot = resolveWorkspacePath(workspacePath, '.stardust-tmp');
		await mkdir(ephemeralRoot, { recursive: true });
		const ephemeralPath = await mkdtemp(join(ephemeralRoot, 'ephemeral-'));

		return {
			path: ephemeralPath,
			remove: async () => {
				await rm(ephemeralPath, { recursive: true, force: true });
			}
		};
	}

	async killProcess(processId: string): Promise<boolean> {
		const tracked = this.trackedProcesses.get(processId);
		if (!tracked) return false;

		this.killTrackedProcess(tracked);
		return true;
	}

	async cancelSession(sessionKey: string): Promise<void> {
		for (const tracked of this.trackedProcesses.values()) {
			if (tracked.sessionKey === sessionKey) {
				this.killTrackedProcess(tracked);
			}
		}
	}

	private buildEnvironment(inputEnvironment: Record<string, string | undefined> | undefined) {
		const environment: Record<string, string> = {
			HOME: this.workspaceRoot,
			PATH: process.env.PATH ?? ''
		};

		for (const name of this.allowedEnvironmentVariables) {
			const value = inputEnvironment?.[name] ?? process.env[name];
			if (value !== undefined) environment[name] = value;
		}

		return environment;
	}

	private killTrackedProcess(tracked: TrackedProcess): void {
		tracked.killed = true;
		const pid = tracked.child.pid;
		if (pid === undefined) return;

		try {
			process.kill(-pid, 'SIGTERM');
		} catch {
			try {
				tracked.child.kill('SIGTERM');
			} catch {
				// The process may have exited between lookup and kill.
			}
		}
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
