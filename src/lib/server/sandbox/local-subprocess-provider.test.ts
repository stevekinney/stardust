import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile as readFileRaw, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DatabaseClient } from '../db';
import { sandboxSnapshots } from '../db';
import * as schema from '../db/schema';
import { getSandboxProvider, LocalSubprocessSandboxProvider } from './index';
import { SandboxPathError } from './sandbox-errors';

let temporaryRoot: string;

beforeEach(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'stardust-sandbox-'));
});

afterEach(async () => {
	await rm(temporaryRoot, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe('getSandboxProvider', () => {
	it('selects the local subprocess provider from SANDBOX_PROVIDER', () => {
		expect.assertions(1);

		vi.stubEnv('SANDBOX_PROVIDER', 'local-subprocess');

		expect(getSandboxProvider({ workspaceRoot: temporaryRoot })).toBeInstanceOf(
			LocalSubprocessSandboxProvider
		);
	});
});

describe('LocalSubprocessSandboxProvider', () => {
	it('creates one git-initialized workspace per session and keeps files across provider instances', async () => {
		expect.assertions(3);

		const firstProvider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		const workspacePath = await firstProvider.ensureWorkspace('session-a');
		await firstProvider.writeFile({
			sessionKey: 'session-a',
			path: 'notes/example.txt',
			contents: 'persisted'
		});

		const secondProvider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });

		await expect(stat(join(workspacePath, '.git'))).resolves.toMatchObject({
			isDirectory: expect.any(Function)
		});
		expect(workspacePath).toBe(join(temporaryRoot, 'session-a'));
		await expect(
			secondProvider.readFile({ sessionKey: 'session-a', path: 'notes/example.txt' })
		).resolves.toBe('persisted');
	});

	it('shields workspace git setup from an inherited GIT_DIR (git hook environments)', async () => {
		expect.assertions(4);

		// Git exports GIT_DIR (but not GIT_WORK_TREE) to hook subprocesses. If the
		// provider's utility git commands inherit it — e.g. the unit suite running
		// under a lefthook pre-push hook — `git init` / `git config` re-target the
		// HOST repository: they reinitialize its .git (setting core.bare=true) and
		// write the sandbox identity into its config, bricking every worktree.
		const victimRoot = await mkdtemp(join(tmpdir(), 'stardust-victim-'));
		try {
			const execFile = promisify(execFileCallback);
			// The suite itself may be running under a git hook (that is the very
			// scenario this test guards), so scrub GIT_* from the victim repo's
			// setup command — otherwise this `git init` reinitializes the host
			// repository instead of creating the victim.
			const cleanEnvironment = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
			) as NodeJS.ProcessEnv;
			await execFile('git', ['init', victimRoot], { env: cleanEnvironment });
			const victimConfigPath = join(victimRoot, '.git', 'config');
			const victimConfigBefore = await readFileRaw(victimConfigPath, 'utf8');

			vi.stubEnv('GIT_DIR', join(victimRoot, '.git'));
			const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
			const workspacePath = await provider.ensureWorkspace('session-hook');

			// The host repository's config is byte-identical — no reinit, no
			// sandbox identity, no core.bare flip.
			await expect(readFileRaw(victimConfigPath, 'utf8')).resolves.toBe(victimConfigBefore);
			expect(victimConfigBefore).not.toContain('Stardust Sandbox');

			// The workspace got its own repository with the sandbox identity.
			await expect(stat(join(workspacePath, '.git'))).resolves.toMatchObject({
				isDirectory: expect.any(Function)
			});
			await expect(readFileRaw(join(workspacePath, '.git', 'config'), 'utf8')).resolves.toContain(
				'Stardust Sandbox'
			);
		} finally {
			await rm(victimRoot, { recursive: true, force: true });
		}
	});

	it('confines file operations to the workspace', async () => {
		expect.assertions(3);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });

		await provider.writeFile({ sessionKey: 'session-a', path: 'inside.txt', contents: 'allowed' });
		await expect(provider.readFile({ sessionKey: 'session-a', path: 'inside.txt' })).resolves.toBe(
			'allowed'
		);
		await expect(
			provider.writeFile({ sessionKey: 'session-a', path: '../outside.txt', contents: 'denied' })
		).rejects.toBeInstanceOf(SandboxPathError);
		await expect(
			provider.readFile({ sessionKey: 'session-a', path: '/tmp/outside.txt' })
		).rejects.toBeInstanceOf(SandboxPathError);
	});

	it('writes base64-encoded contents as raw bytes, round-tripping binary data exactly', async () => {
		expect.assertions(1);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		// A 4x4 transparent PNG — realistic binary attachment bytes, not just
		// arbitrary non-UTF8 data. Any byte sequence that a naive utf8 write
		// would mangle proves the point, but a real image is the honest case.
		const bytes = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x7f
		]);
		const base64 = Buffer.from(bytes).toString('base64');

		await provider.writeFile({
			sessionKey: 'session-a',
			path: 'attachments/pixel.png',
			contents: base64,
			encoding: 'base64'
		});

		const written = await readFileRaw(join(temporaryRoot, 'session-a', 'attachments', 'pixel.png'));
		expect(Buffer.compare(written, Buffer.from(bytes))).toBe(0);
	});

	it('defaults to utf8 encoding when encoding is omitted', async () => {
		expect.assertions(1);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.writeFile({
			sessionKey: 'session-a',
			path: 'notes.txt',
			contents: 'plain text'
		});

		await expect(provider.readFile({ sessionKey: 'session-a', path: 'notes.txt' })).resolves.toBe(
			'plain text'
		);
	});

	it('runs commands with cwd, allowlisted environment, captured output, and exit code', async () => {
		expect.assertions(5);

		const provider = new LocalSubprocessSandboxProvider({
			workspaceRoot: temporaryRoot,
			allowedEnvironmentVariables: ['ALLOWED_VALUE']
		});
		await provider.writeFile({
			sessionKey: 'session-a',
			path: 'project/input.txt',
			contents: 'hello'
		});

		const result = await provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'bun',
			args: [
				'-e',
				[
					"console.log(await Bun.file('input.txt').text())",
					"console.log(process.env.ALLOWED_VALUE ?? 'missing')",
					"console.error(process.env.SECRET_VALUE ?? 'secret-missing')",
					'process.exit(7)'
				].join(';')
			],
			cwd: 'project',
			env: {
				ALLOWED_VALUE: 'visible',
				SECRET_VALUE: 'hidden'
			}
		});

		expect(result.workspacePath).toBe(join(temporaryRoot, 'session-a'));
		expect(result.stdout).toBe('hello\nvisible\n');
		expect(result.stderr).toBe('secret-missing\n');
		expect(result.exitCode).toBe(7);
		expect(result.status).toBe('failed');
	});

	it('kills commands that exceed their timeout and captures partial output', async () => {
		expect.assertions(4);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		// `sh -c 'printf … ; sleep 10'` prints immediately then blocks on sleep.
		// The 500ms timeout is generous enough for sh+printf under heavy CI load
		// while still well below the 10s sleep, so the provider always kills the
		// process mid-sleep and captures the partial stdout.
		const result = await provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'sh',
			args: ['-c', 'printf "started\\n"; sleep 10'],
			timeoutMs: 500
		});

		expect(result.stdout).toBe('started\n');
		expect(result.exitCode).toBeNull();
		expect(result.timedOut).toBe(true);
		expect(result.status).toBe('timeout');
	});

	it('creates git snapshots and restores workspace contents', async () => {
		expect.assertions(4);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.writeFile({ sessionKey: 'session-a', path: 'story.txt', contents: 'first' });
		const snapshot = await provider.snapshot({
			sessionKey: 'session-a',
			runId: 'run-a',
			reason: 'before edit'
		});

		await provider.writeFile({ sessionKey: 'session-a', path: 'story.txt', contents: 'second' });
		await provider.restore('session-a', snapshot.gitCommitSha);

		expect(snapshot.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(snapshot.workspacePath).toBe(join(temporaryRoot, 'session-a'));
		await expect(provider.readFile({ sessionKey: 'session-a', path: 'story.txt' })).resolves.toBe(
			'first'
		);
		expect(snapshot.id).toBe(snapshot.gitCommitSha);
	});

	it('records snapshots in sandbox_snapshots when a database is configured', async () => {
		expect.assertions(2);

		const insertedSnapshots: unknown[] = [];
		const provider = new LocalSubprocessSandboxProvider({
			workspaceRoot: temporaryRoot,
			database: createRecordingDatabase(insertedSnapshots)
		});

		await provider.writeFile({ sessionKey: 'session-a', path: 'story.txt', contents: 'first' });
		const snapshot = await provider.snapshot({ sessionKey: 'session-a', runId: 'run-a' });

		expect(insertedSnapshots).toHaveLength(1);
		expect(insertedSnapshots[0]).toMatchObject({
			sessionId: 'session-a',
			runId: 'run-a',
			externalSnapshotId: snapshot.gitCommitSha
		});
	});

	it('runs ephemeral commands in an isolated temporary directory and removes it on terminate', async () => {
		expect.assertions(6);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.writeFile({
			sessionKey: 'session-a',
			path: 'shared.txt',
			contents: 'persistent'
		});
		const sessionWorkspacePath = await provider.ensureWorkspace('session-a');
		const ephemeralSandbox = await provider.createEphemeralSandbox('session-a');

		expect(ephemeralSandbox.workspacePath).not.toBe(sessionWorkspacePath);
		await expect(stat(ephemeralSandbox.workspacePath)).resolves.toMatchObject({
			isDirectory: expect.any(Function)
		});

		const result = await ephemeralSandbox.runCommand({
			runId: 'run-a',
			command: 'bun',
			args: [
				'-e',
				[
					'console.log(process.cwd())',
					"console.log(await Bun.file('shared.txt').exists())",
					"await Bun.write('ephemeral.txt', 'temporary')"
				].join(';')
			]
		});

		expect(result.status).toBe('complete');
		expect(result.workspacePath).toBe(ephemeralSandbox.workspacePath);
		expect(result.stdout).toBe(`${ephemeralSandbox.workspacePath}\nfalse\n`);
		await ephemeralSandbox.terminate();
		await expect(stat(ephemeralSandbox.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('does not preserve still-running tracked processes across provider instances', async () => {
		expect.assertions(1);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.ensureWorkspace('session-a');
		const command = provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'bun',
			args: ['-e', 'await new Promise(() => {})']
		});

		await waitForTrackedProcesses(provider, 1);

		const resumedProvider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await resumedProvider.cancelSession('session-a');

		const result = await provider.cancelSession('session-a').then(() => command);
		expect(result.status).toBe('killed');
	});

	it('cleans up tracked processes when a session is cancelled', async () => {
		expect.assertions(2);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.ensureWorkspace('session-a');
		const command = provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'bun',
			args: ['-e', "console.log('ready'); await new Promise(() => {})"]
		});

		await waitForTrackedProcesses(provider, 1);
		await provider.cancelSession('session-a');
		const result = await command;

		expect(result.killed).toBe(true);
		expect(result.status).toBe('killed');
	});

	it('startProcess returns while the process is still running and killProcess terminates it', async () => {
		expect.assertions(5);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		const started = await provider.startProcess({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'bun',
			args: ['-e', 'await new Promise(() => {})']
		});

		expect(started.status).toBe('running');
		expect(started.processId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
		expect(provider.trackedProcessCount).toBe(1);

		const killed = await provider.killProcess({
			sessionKey: 'session-a',
			processId: started.processId
		});

		expect(killed).toEqual({ processId: started.processId, killed: true, status: 'killed' });
		await waitForTrackedProcesses(provider, 0);
		expect(provider.trackedProcessCount).toBe(0);
	});

	it('persists background process ids and marks killed rows', async () => {
		expect.assertions(4);

		const dbPath = join(temporaryRoot, 'sandbox-processes.db');
		const sqlite = new Database(dbPath);
		sqlite.pragma('journal_mode = WAL');
		const database = drizzle(sqlite, { schema });
		migrate(database, { migrationsFolder: './drizzle' });
		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot, database });

		try {
			const started = await provider.startProcess({
				sessionKey: 'session-a',
				runId: 'run-a',
				command: 'bun',
				args: ['-e', 'await new Promise(() => {})']
			});
			const runningRow = sqlite
				.prepare(
					'SELECT pid, process_group_id AS processGroupId, background, status FROM sandbox_commands WHERE id = ?'
				)
				.get(started.processId) as {
				pid: number | null;
				processGroupId: number | null;
				background: number;
				status: string;
			};
			expect(runningRow).toMatchObject({
				pid: started.pid,
				processGroupId: started.processGroupId,
				background: 1,
				status: 'running'
			});

			await provider.killProcess({ sessionKey: 'session-a', processId: started.processId });
			await waitForTrackedProcessesOrThrow(provider, 0);
			const killedRow = sqlite
				.prepare('SELECT status FROM sandbox_commands WHERE id = ?')
				.get(started.processId) as { status: string };
			expect(killedRow.status).toBe('killed');
			expect(started.pid).toEqual(expect.any(Number));
			expect(started.processGroupId).toBe(started.pid);
		} finally {
			await provider.cancelSession('session-a');
			sqlite.close();
		}
	});

	it('kills only the specific command when its AbortSignal fires, not other same-session processes', async () => {
		expect.assertions(3);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		await provider.ensureWorkspace('session-a');

		// Start a long-running background command for the same session — must survive.
		const backgroundCommand = provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-bg',
			command: 'bun',
			args: ['-e', 'await new Promise(() => {})']
		});

		// Start a second command with its own AbortSignal.
		const controller = new AbortController();
		const foregroundCommand = provider.runCommand(
			{
				sessionKey: 'session-a',
				runId: 'run-fg',
				command: 'bun',
				args: ['-e', 'await new Promise(() => {})']
			},
			{ signal: controller.signal }
		);

		await waitForTrackedProcesses(provider, 2);

		// Abort only the foreground command.
		controller.abort();
		const foregroundResult = await foregroundCommand;

		expect(foregroundResult.killed).toBe(true);
		expect(foregroundResult.status).toBe('killed');
		// The background process is still tracked — the signal did not kill it.
		expect(provider.trackedProcessCount).toBe(1);

		// Clean up.
		await provider.cancelSession('session-a');
		await backgroundCommand;
	});

	it('kills a running command when the AbortSignal fires', async () => {
		expect.assertions(2);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		const controller = new AbortController();

		const command = provider.runCommand(
			{
				sessionKey: 'session-a',
				runId: 'run-a',
				command: 'bun',
				args: ['-e', 'await new Promise(() => {})']
			},
			{ signal: controller.signal }
		);

		await waitForTrackedProcesses(provider, 1);
		controller.abort();

		const result = await command;

		expect(result.killed).toBe(true);
		expect(result.status).toBe('killed');
	});

	it('kills a command immediately when given an already-aborted AbortSignal', async () => {
		expect.assertions(2);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		const controller = new AbortController();
		controller.abort();

		const result = await provider.runCommand(
			{
				sessionKey: 'session-a',
				runId: 'run-a',
				command: 'bun',
				args: ['-e', 'await new Promise(() => {})']
			},
			{ signal: controller.signal }
		);

		expect(result.killed).toBe(true);
		expect(result.status).toBe('killed');
	});

	it('calls onStart with a UUID command id and numeric pid once the subprocess is spawned', async () => {
		expect.assertions(3);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		let startInfo: { id: string; pid: number | undefined } | undefined;

		await provider.runCommand(
			{
				sessionKey: 'session-a',
				runId: 'run-a',
				command: 'bun',
				args: ['-e', "console.log('hi')"]
			},
			{
				onStart: (info) => {
					startInfo = info;
				}
			}
		);

		expect(startInfo).toBeDefined();
		expect(startInfo!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(typeof startInfo!.pid).toBe('number');
	});

	it('calls onStart before the command exits so a heartbeat loop can track a long-running command', async () => {
		expect.assertions(2);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		// Pre-initialize the workspace so the git-init overhead does not race with the
		// subprocess starting; `runCommand` otherwise initializes it async before spawning.
		await provider.ensureWorkspace('session-a');

		let onStartCalledBeforeCompletion = false;

		const command = provider.runCommand(
			{
				sessionKey: 'session-a',
				runId: 'run-a',
				command: 'bun',
				args: ['-e', 'await new Promise(() => {})']
			},
			{
				onStart: () => {
					onStartCalledBeforeCompletion = true;
				}
			}
		);

		await waitForTrackedProcesses(provider, 1);
		expect(onStartCalledBeforeCompletion).toBe(true);

		// Clean up the long-running process.
		await provider.cancelSession('session-a');
		const result = await command;
		expect(result.status).toBe('killed');
	});
});

async function waitForTrackedProcesses(
	provider: LocalSubprocessSandboxProvider,
	expectedCount: number
): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (provider.trackedProcessCount === expectedCount) return;
		await delay(20);
	}
}

async function waitForTrackedProcessesOrThrow(
	provider: LocalSubprocessSandboxProvider,
	expectedCount: number
): Promise<void> {
	await waitForTrackedProcesses(provider, expectedCount);
	if (provider.trackedProcessCount === expectedCount) return;
	expect(provider.trackedProcessCount).toBe(expectedCount);
}

function createRecordingDatabase(insertedSnapshots: unknown[]): DatabaseClient {
	return {
		insert: (table: unknown) => ({
			values: (row: unknown) => {
				if (table === sandboxSnapshots) {
					insertedSnapshots.push(row);
				}

				return {
					onConflictDoUpdate: async () => undefined
				};
			}
		})
	} as unknown as DatabaseClient;
}
