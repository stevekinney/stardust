import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS
} from '@src/lib/types';
import {
	executeRegisteredTool,
	getAnthropicToolManifest,
	getToolManifest,
	registeredTools
} from './registry';
import { LocalArtifactStore } from '../artifacts/local-artifact-store';
import { LocalSubprocessSandboxProvider } from '../sandbox';
import * as schema from '../db/schema';

let workspaceRoot: string;
let provider: LocalSubprocessSandboxProvider;

/** Stable session key used across workspace tool tests. Must satisfy SESSION_KEY_RE. */
const TEST_SESSION = 'test-registry-session';

beforeEach(async () => {
	vi.stubEnv('TAVILY_API_KEY', '');
	workspaceRoot = await mkdtemp(join(tmpdir(), 'stardust-tools-'));
	provider = new LocalSubprocessSandboxProvider({ workspaceRoot });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(workspaceRoot, { recursive: true, force: true });
});

// ── Manifest shape ────────────────────────────────────────────────────────────

describe('tool registry', () => {
	it('exposes implemented tools and hides unimplemented stubs from the manifest', () => {
		const manifest = getToolManifest();
		// Only implemented tools appear in the manifest. Stubs (web.search, memory.*,
		// process.*, delegate.*) are hidden until their backing infrastructure exists.
		expect(manifest.map((tool) => tool.name).sort()).toEqual([
			'sandbox.snapshot',
			'shell.exec',
			'web.fetch',
			'workspace.applyPatch',
			'workspace.readFile',
			'workspace.searchFiles',
			'workspace.writeFile'
		]);
		expect(manifest.find((tool) => tool.name === 'shell.exec')?.metadata).toMatchObject({
			risk: 'high',
			requiresApproval: true,
			taskQueue: TASK_QUEUE_SANDBOX
		});
		expect(manifest.find((tool) => tool.name === 'web.fetch')?.metadata).toMatchObject({
			risk: 'low',
			requiresApproval: false,
			taskQueue: TASK_QUEUE_TOOLS
		});
	});

	it('assigns high risk to workspace.writeFile and workspace.applyPatch per the MVP spec', () => {
		const manifest = getToolManifest();
		const toolsByName = new Map(manifest.map((tool) => [tool.name, tool]));

		expect(toolsByName.get('workspace.writeFile')?.metadata).toMatchObject({
			risk: 'high',
			requiresApproval: true,
			taskQueue: TASK_QUEUE_SANDBOX
		});
		expect(toolsByName.get('workspace.applyPatch')?.metadata).toMatchObject({
			risk: 'high',
			requiresApproval: true,
			taskQueue: TASK_QUEUE_SANDBOX
		});
	});

	it('sandbox.snapshot is visible in the manifest and correctly classified', () => {
		const toolsByName = new Map(getToolManifest().map((tool) => [tool.name, tool]));
		expect(toolsByName.get('sandbox.snapshot')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 20_000,
				retry: { maximumAttempts: 1 }
			}
		});
	});

	it('workspace.searchFiles is visible in the manifest with low risk', () => {
		const toolsByName = new Map(getToolManifest().map((tool) => [tool.name, tool]));
		expect(toolsByName.get('workspace.searchFiles')).toMatchObject({
			metadata: {
				risk: 'low',
				requiresApproval: false,
				taskQueue: TASK_QUEUE_TOOLS,
				idempotencyBehavior: 'safe'
			},
			inputSchema: expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					pattern: expect.any(Object)
				})
			})
		});
	});

	it('retains full metadata for hidden tools in registeredTools for policy routing', () => {
		const byName = new Map(registeredTools.map((t) => [t.name, t]));
		const manifestNames = new Set(getToolManifest().map((t) => t.name));

		// Hidden tools still carry correct metadata so policy routing works even when
		// the tool is not exposed to the model.
		expect(byName.get('process.start')).toMatchObject({
			metadata: {
				risk: 'high',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 30_000,
				retry: { maximumAttempts: 1 }
			}
		});
		expect(byName.get('process.kill')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX
			}
		});
		expect(byName.get('memory.writeCandidate')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_MEMORY
			}
		});
		for (const name of ['delegate.research', 'delegate.code', 'delegate.critic']) {
			expect(byName.get(name)).toMatchObject({
				metadata: {
					risk: 'medium',
					requiresApproval: true,
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					timeoutMs: 60_000
				}
			});
		}

		// None of the hidden tools appear in the manifest.
		for (const hidden of [
			'web.search',
			'memory.search',
			'memory.writeCandidate',
			'process.start',
			'process.kill',
			'delegate.research',
			'delegate.code',
			'delegate.critic'
		]) {
			expect(manifestNames.has(hidden), `${hidden} should be hidden from manifest`).toBe(false);
		}
	});

	it('carries idempotencyBehavior on every registered tool', () => {
		for (const tool of registeredTools) {
			expect(
				tool.metadata.idempotencyBehavior,
				`${tool.name} is missing idempotencyBehavior`
			).toMatch(/^(safe|key-required|unsafe)$/);
		}
	});

	it('hides web.search from the manifest regardless of TAVILY_API_KEY', async () => {
		vi.stubEnv('TAVILY_API_KEY', '');
		expect(getToolManifest().map((tool) => tool.name)).not.toContain('web.search');

		vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
		// web.search is still hidden — its Tavily implementation is pending.
		expect(getToolManifest().map((tool) => tool.name)).not.toContain('web.search');
	});

	it('filters denied tools from the model manifest and formats via armorer', () => {
		expect(getToolManifest({ allowedToolNames: ['web.fetch'] }).map((tool) => tool.name)).toEqual([
			'web.fetch'
		]);
		expect(getAnthropicToolManifest({ allowedToolNames: ['web.fetch'] })).toEqual([
			expect.objectContaining({
				name: 'web.fetch',
				input_schema: expect.objectContaining({
					type: 'object',
					properties: expect.objectContaining({
						url: expect.any(Object)
					})
				})
			})
		]);
	});

	it('keeps armorer descriptors queryable through the registry', () => {
		expect(registeredTools.every((tool) => tool.schema)).toBe(true);
		expect(getToolManifest().every((tool) => tool.inputSchema.type === 'object')).toBe(true);
	});

	// ── Policy routing ──────────────────────────────────────────────────────────

	it('executes safe tools and fences web output as untrusted data', async () => {
		const result = await executeRegisteredTool({
			call: {
				id: 'call-001',
				name: 'web.fetch',
				arguments: { url: 'https://example.test' }
			},
			fetcher: async () =>
				new Response('hello from the internet', {
					status: 200,
					headers: { 'content-type': 'text/plain' }
				})
		});

		expect(result.outcome).toBe('success');
		expect(result.content).toContain('```text');
		expect(result.content).toContain('hello from the internet');
	});

	it('denies hallucinated and malformed tool calls before execution', async () => {
		await expect(
			executeRegisteredTool({
				call: { id: 'call-003', name: 'unknown.tool', arguments: {} }
			})
		).resolves.toMatchObject({ outcome: 'denied' });

		await expect(
			executeRegisteredTool({
				call: { id: 'call-004', name: 'web.fetch', arguments: { url: 'not a url' } }
			})
		).resolves.toMatchObject({ outcome: 'denied' });
	});

	it('denies hidden tools (process.start, delegate.*) instead of returning approval_required', async () => {
		// Hidden tools are not in the configured tools list, so they're denied as
		// unknown rather than routed through the approval flow.
		await expect(
			executeRegisteredTool({
				sessionKey: TEST_SESSION,
				sandboxProvider: provider,
				call: { id: 'call-hidden-01', name: 'process.start', arguments: { command: 'bun' } }
			})
		).resolves.toMatchObject({ outcome: 'denied' });

		await expect(
			executeRegisteredTool({
				sessionKey: TEST_SESSION,
				sandboxProvider: provider,
				call: { id: 'call-hidden-02', name: 'delegate.code', arguments: { prompt: 'test' } }
			})
		).resolves.toMatchObject({ outcome: 'denied' });
	});

	it('sandbox.snapshot requires approval before executing', async () => {
		await expect(
			executeRegisteredTool({
				sessionKey: TEST_SESSION,
				sandboxProvider: provider,
				call: {
					id: 'call-snap-01',
					name: 'sandbox.snapshot',
					arguments: { label: 'before-edit' }
				}
			})
		).resolves.toMatchObject({ outcome: 'approval_required' });
	});

	// ── Workspace write via provider ─────────────────────────────────────────────

	it('requires approval before mutating workspace tools execute', async () => {
		const waiting = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			call: {
				id: 'call-002',
				name: 'workspace.writeFile',
				arguments: { path: 'notes/hello.txt', content: 'hello' }
			}
		});
		expect(waiting.outcome).toBe('approval_required');

		const approved = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			call: {
				id: 'call-002',
				name: 'workspace.writeFile',
				arguments: { path: 'notes/hello.txt', content: 'hello' }
			}
		});
		expect(approved.outcome).toBe('success');
		// Read back through the provider to confirm the file landed in the workspace.
		await expect(
			provider.readFile({ sessionKey: TEST_SESSION, path: 'notes/hello.txt' })
		).resolves.toBe('hello');
	});

	it('creates a sandbox snapshot before workspace.writeFile executes', async () => {
		const snapshotSpy = vi.spyOn(provider, 'snapshot');

		await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-snap-write',
			call: {
				id: 'call-snap-write-01',
				name: 'workspace.writeFile',
				arguments: { path: 'snap-test.txt', content: 'snap content' }
			}
		});

		// Exactly one auto-snapshot should have been created before the write.
		expect(snapshotSpy).toHaveBeenCalledTimes(1);
		expect(snapshotSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionKey: TEST_SESSION,
				toolCallId: 'call-snap-write-01',
				reason: 'pre-write: snap-test.txt'
			})
		);
	});

	it('creates a sandbox snapshot before shell.exec executes', async () => {
		const snapshotSpy = vi.spyOn(provider, 'snapshot');

		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-snap-shell',
			call: {
				id: 'call-snap-shell-01',
				name: 'shell.exec',
				arguments: { command: 'echo', args: ['hello'] }
			}
		});

		expect(result.outcome).toBe('success');
		expect(snapshotSpy).toHaveBeenCalledTimes(1);
		expect(snapshotSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionKey: TEST_SESSION,
				toolCallId: 'call-snap-shell-01',
				reason: 'pre-shell: echo'
			})
		);
	});

	// ── workspace.applyPatch via provider ────────────────────────────────────────

	it('applies a real unified diff patch to an existing workspace file', async () => {
		const originalContent = 'line one\nline two\nline three\n';
		const targetContent = 'line one\nline TWO\nline three\n';

		// Write the original file through the provider.
		await provider.ensureWorkspace(TEST_SESSION);
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'patch-target.txt',
			contents: originalContent
		});

		// Generate the diff against the file's absolute path (provider manages the location).
		const absFilePath = join(workspaceRoot, TEST_SESSION, 'patch-target.txt');
		const patchContent = (() => {
			try {
				execSync(`diff -u "${absFilePath}" -`, {
					input: targetContent,
					stdio: ['pipe', 'pipe', 'pipe']
				});
				return '';
			} catch (err: unknown) {
				const spawnErr = err as { stdout?: Buffer | string };
				return String(spawnErr.stdout ?? '');
			}
		})();

		expect(patchContent).toContain('line two');
		expect(patchContent).toContain('line TWO');

		// workspace.applyPatch requires approval.
		const waiting = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			call: {
				id: 'call-patch-01',
				name: 'workspace.applyPatch',
				arguments: { path: 'patch-target.txt', patch: patchContent }
			}
		});
		expect(waiting.outcome).toBe('approval_required');

		// After approval the patch is applied through the sandbox provider.
		const snapshotSpy = vi.spyOn(provider, 'snapshot');
		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-patch-01',
			call: {
				id: 'call-patch-01',
				name: 'workspace.applyPatch',
				arguments: { path: 'patch-target.txt', patch: patchContent }
			}
		});
		expect(result.outcome).toBe('success');

		// Verify the file was patched.
		await expect(
			provider.readFile({ sessionKey: TEST_SESSION, path: 'patch-target.txt' })
		).resolves.toBe(targetContent);

		// Snapshot was taken before applying the patch.
		expect(snapshotSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'pre-apply-patch: patch-target.txt'
			})
		);
	});

	it('returns an error outcome when the patch does not apply cleanly', async () => {
		await provider.ensureWorkspace(TEST_SESSION);
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'bad-patch.txt',
			contents: 'alpha\nbeta\ngamma\n'
		});

		// A patch referencing lines that do not exist in the file.
		const badPatch = `--- a/bad-patch.txt\n+++ b/bad-patch.txt\n@@ -1,3 +1,3 @@\n nonexistent\n-line\n+replacement\n`;

		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-patch-bad',
			call: {
				id: 'call-patch-02',
				name: 'workspace.applyPatch',
				arguments: { path: 'bad-patch.txt', patch: badPatch }
			}
		});
		expect(result.outcome).toBe('error');
	});

	// ── sandbox.snapshot via provider ────────────────────────────────────────────

	it('sandbox.snapshot executes through the provider and returns a git commit sha', async () => {
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'story.txt',
			contents: 'chapter 1'
		});

		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-snap-01',
			call: {
				id: 'call-snap-02',
				name: 'sandbox.snapshot',
				arguments: { label: 'before-chapter-2' }
			}
		});

		expect(result.outcome).toBe('success');
		const content = result.content as { id: string; label: string; gitCommitSha: string };
		expect(content.label).toBe('before-chapter-2');
		expect(content.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);

		// Verify restore works: overwrite the file and restore the snapshot.
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'story.txt',
			contents: 'chapter 2'
		});
		await provider.restore(TEST_SESSION, content.gitCommitSha);
		await expect(provider.readFile({ sessionKey: TEST_SESSION, path: 'story.txt' })).resolves.toBe(
			'chapter 1'
		);
	});

	// ── workspace.searchFiles via provider ───────────────────────────────────────

	it('workspace.searchFiles finds matching files in the workspace', async () => {
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'src/index.ts',
			contents: 'export default 1;'
		});
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'src/utils.ts',
			contents: 'export const x = 1;'
		});
		await provider.writeFile({
			sessionKey: TEST_SESSION,
			path: 'README.md',
			contents: '# docs'
		});

		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-search-01',
			call: {
				id: 'call-search-01',
				name: 'workspace.searchFiles',
				arguments: { pattern: '*.ts' }
			}
		});

		expect(result.outcome).toBe('success');
		const content = result.content as { files: string[]; pattern: string };
		expect(content.pattern).toBe('*.ts');
		expect(content.files.length).toBe(2);
		expect(content.files.some((f) => f.endsWith('index.ts'))).toBe(true);
		expect(content.files.some((f) => f.endsWith('utils.ts'))).toBe(true);
		expect(content.files.some((f) => f.endsWith('README.md'))).toBe(false);
	});

	// ── shell.exec via provider ──────────────────────────────────────────────────

	it('shell.exec routes through the sandbox provider command ledger and captures output', async () => {
		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			approved: true,
			runId: 'run-shell-01',
			call: {
				id: 'call-shell-01',
				name: 'shell.exec',
				arguments: { command: 'echo', args: ['provider-routed'] }
			}
		});

		expect(result.outcome).toBe('success');
		const content = result.content as { stdout: string; exitCode: number; status: string };
		expect(content.stdout).toBe('provider-routed\n');
		expect(content.exitCode).toBe(0);
		expect(content.status).toBe('complete');
	});

	it('shell.exec requires approval before executing', async () => {
		const result = await executeRegisteredTool({
			sessionKey: TEST_SESSION,
			sandboxProvider: provider,
			call: {
				id: 'call-shell-02',
				name: 'shell.exec',
				arguments: { command: 'echo', args: ['hello'] }
			}
		});
		expect(result.outcome).toBe('approval_required');
	});

	// ── Sandbox row persistence ──────────────────────────────────────────────────

	it('sandbox rows are persisted to sandboxCommands when a database is configured', async () => {
		expect.assertions(3);

		const dbDir = mkdtempSync(join(tmpdir(), 'stardust-regtest-db-'));
		const sqlite = new Database(join(dbDir, 'test.db'));
		sqlite.pragma('journal_mode = WAL');
		const database = drizzle(sqlite, { schema });
		migrate(database, { migrationsFolder: './drizzle' });

		const dbProvider = new LocalSubprocessSandboxProvider({
			workspaceRoot,
			database
		});

		try {
			const result = await executeRegisteredTool({
				sessionKey: TEST_SESSION,
				sandboxProvider: dbProvider,
				approved: true,
				runId: 'run-db-shell',
				call: {
					id: 'call-db-shell-01',
					name: 'shell.exec',
					arguments: { command: 'echo', args: ['db-test'] }
				}
			});

			expect(result.outcome).toBe('success');

			// A sandboxCommands row should have been persisted by the provider.
			const rows = sqlite
				.prepare('SELECT * FROM sandbox_commands WHERE session_id = ?')
				.all(TEST_SESSION);
			expect(rows.length).toBeGreaterThanOrEqual(1);
			// At minimum the shell.exec command should be recorded.
			const shellRow = (rows as Array<{ command: string }>).find((r) => r.command === 'echo');
			expect(shellRow).toBeDefined();
		} finally {
			sqlite.close();
			rmSync(dbDir, { recursive: true, force: true });
		}
	});

	// ── Spill path ───────────────────────────────────────────────────────────────

	it('spills large tool output to artifact store when artifactStore and session IDs are provided', async () => {
		const artifactDir = await mkdtemp(join(tmpdir(), 'stardust-spill-test-'));
		try {
			const artifactStore = new LocalArtifactStore({ storageRoot: artifactDir });
			// Produce output above the default TOOL_RESULT_INLINE_LIMIT (8 000 chars).
			const largeContent = 'X'.repeat(9_000);

			const result = await executeRegisteredTool({
				call: {
					id: 'call-spill-001',
					name: 'web.fetch',
					arguments: { url: 'https://example.test' }
				},
				sessionId: 'sess-spill-test',
				sessionKey: 'key-spill-test',
				runId: 'run-spill-test',
				artifactStore,
				fetcher: async () =>
					new Response(largeContent, {
						status: 200,
						headers: { 'content-type': 'text/plain' }
					})
			});

			expect(result.outcome).toBe('success');
			// The spill path should populate these metadata fields.
			expect(result.metadata?.spilledArtifactId).toBeTypeOf('string');
			expect(result.metadata?.spilledBytes).toBeGreaterThan(0);
			// The model receives an excerpt, not the raw large content.
			expect(typeof result.content).toBe('string');
			expect(result.content as string).toContain('Output spilled to artifact');
			expect(result.content as string).toContain('artifact:');
		} finally {
			await rm(artifactDir, { recursive: true, force: true });
		}
	});
});
