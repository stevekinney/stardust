import { mkdtemp, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../db';
import { sandboxSnapshots } from '../db';
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
		const result = await provider.runCommand({
			sessionKey: 'session-a',
			runId: 'run-a',
			command: 'bun',
			args: ['-e', "console.log('started'); await new Promise(() => {})"],
			timeoutMs: 100
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

	it('removes ephemeral directories after use', async () => {
		expect.assertions(2);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
		const ephemeralDirectory = await provider.createEphemeralDirectory('session-a');

		await expect(stat(ephemeralDirectory.path)).resolves.toMatchObject({
			isDirectory: expect.any(Function)
		});
		await ephemeralDirectory.remove();
		await expect(stat(ephemeralDirectory.path)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('does not preserve still-running tracked processes across provider instances', async () => {
		expect.assertions(1);

		const provider = new LocalSubprocessSandboxProvider({ workspaceRoot: temporaryRoot });
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
