import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

let workspacePath: string;

beforeEach(async () => {
	vi.stubEnv('TAVILY_API_KEY', '');
	workspacePath = await mkdtemp(join(tmpdir(), 'stardust-tools-'));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(workspacePath, { recursive: true, force: true });
});

describe('tool registry', () => {
	it('exposes demo-critical tools with Stardust metadata', () => {
		const manifest = getToolManifest();
		expect(manifest.map((tool) => tool.name).sort()).toEqual([
			'delegate.code',
			'delegate.critic',
			'delegate.research',
			'memory.search',
			'memory.writeCandidate',
			'process.kill',
			'process.start',
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

	it('exposes extended tools with risk, approval, queue, timeout, retry, and schemas', () => {
		const toolsByName = new Map(getToolManifest().map((tool) => [tool.name, tool]));

		expect(toolsByName.get('process.start')).toMatchObject({
			metadata: {
				risk: 'high',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 30_000,
				retry: { maximumAttempts: 1 }
			},
			inputSchema: expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					command: expect.any(Object)
				})
			})
		});
		// process.kill is Medium per the MVP spec (not High)
		expect(toolsByName.get('process.kill')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 10_000,
				retry: { maximumAttempts: 1 }
			}
		});
		expect(toolsByName.get('sandbox.snapshot')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 20_000,
				retry: { maximumAttempts: 1 }
			}
		});
		expect(toolsByName.get('memory.writeCandidate')).toMatchObject({
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_MEMORY,
				timeoutMs: 10_000,
				retry: { maximumAttempts: 1 }
			}
		});
		for (const name of ['delegate.research', 'delegate.code', 'delegate.critic']) {
			expect(toolsByName.get(name)).toMatchObject({
				metadata: {
					risk: 'medium',
					requiresApproval: true,
					taskQueue: TASK_QUEUE_ORCHESTRATOR,
					timeoutMs: 60_000,
					retry: { maximumAttempts: 1 }
				},
				inputSchema: expect.objectContaining({ type: 'object' })
			});
		}
	});

	it('exposes memory.search and workspace.searchFiles with low risk', () => {
		const toolsByName = new Map(getToolManifest().map((tool) => [tool.name, tool]));

		expect(toolsByName.get('memory.search')).toMatchObject({
			metadata: {
				risk: 'low',
				requiresApproval: false,
				taskQueue: TASK_QUEUE_TOOLS,
				idempotencyBehavior: 'safe'
			},
			inputSchema: expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					query: expect.any(Object),
					sessionId: expect.any(Object)
				})
			})
		});

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

	it('carries idempotencyBehavior on every registered tool', () => {
		for (const tool of registeredTools) {
			expect(
				tool.metadata.idempotencyBehavior,
				`${tool.name} is missing idempotencyBehavior`
			).toMatch(/^(safe|key-required|unsafe)$/);
		}
	});

	it('hides web.search from the manifest when Tavily is not configured', async () => {
		vi.stubEnv('TAVILY_API_KEY', '');

		expect(getToolManifest().map((tool) => tool.name)).not.toContain('web.search');
	});

	it('exposes web.search when Tavily is configured', async () => {
		vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');

		expect(getToolManifest().find((tool) => tool.name === 'web.search')).toMatchObject({
			metadata: {
				risk: 'low',
				requiresApproval: false,
				taskQueue: TASK_QUEUE_TOOLS,
				timeoutMs: 10_000,
				retry: { maximumAttempts: 2 }
			},
			inputSchema: expect.objectContaining({
				type: 'object',
				properties: expect.objectContaining({
					query: expect.any(Object)
				})
			})
		});
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

	it('requires approval before mutating workspace tools execute', async () => {
		const waiting = await executeRegisteredTool({
			workspacePath,
			call: {
				id: 'call-002',
				name: 'workspace.writeFile',
				arguments: { path: 'notes/hello.txt', content: 'hello' }
			}
		});
		expect(waiting.outcome).toBe('approval_required');

		const approved = await executeRegisteredTool({
			workspacePath,
			approved: true,
			call: {
				id: 'call-002',
				name: 'workspace.writeFile',
				arguments: { path: 'notes/hello.txt', content: 'hello' }
			}
		});
		expect(approved.outcome).toBe('success');
		await expect(readFile(join(workspacePath, 'notes/hello.txt'), 'utf8')).resolves.toBe('hello');
	});

	it('applies a real unified diff patch to an existing workspace file', async () => {
		// Write the original file
		const originalContent = 'line one\nline two\nline three\n';
		const targetContent = 'line one\nline TWO\nline three\n';
		const filePath = join(workspacePath, 'patch-target.txt');
		await writeFile(filePath, originalContent, 'utf8');

		// Generate a valid unified diff from the two versions using `diff -u`
		const patchContent = (() => {
			try {
				execSync(`diff -u "${filePath}" -`, {
					input: targetContent,
					stdio: ['pipe', 'pipe', 'pipe']
				});
				return ''; // diff exit 0 means identical — should not happen
			} catch (err: unknown) {
				// diff exits 1 when files differ — that is the expected case
				const spawnErr = err as { stdout?: Buffer | string };
				return String(spawnErr.stdout ?? '');
			}
		})();

		expect(patchContent).toContain('line two');
		expect(patchContent).toContain('line TWO');

		// workspace.applyPatch requires approval
		const waiting = await executeRegisteredTool({
			workspacePath,
			call: {
				id: 'call-patch-01',
				name: 'workspace.applyPatch',
				arguments: { path: 'patch-target.txt', patch: patchContent }
			}
		});
		expect(waiting.outcome).toBe('approval_required');

		// After approval the patch is applied
		const result = await executeRegisteredTool({
			workspacePath,
			approved: true,
			call: {
				id: 'call-patch-01',
				name: 'workspace.applyPatch',
				arguments: { path: 'patch-target.txt', patch: patchContent }
			}
		});
		expect(result.outcome).toBe('success');

		const patched = await readFile(filePath, 'utf8');
		expect(patched).toBe(targetContent);
	});

	it('returns an error outcome when the patch does not apply cleanly', async () => {
		const filePath = join(workspacePath, 'bad-patch.txt');
		await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

		// A patch referencing lines that do not exist in the file
		const badPatch = `--- a/bad-patch.txt\n+++ b/bad-patch.txt\n@@ -1,3 +1,3 @@\n nonexistent\n-line\n+replacement\n`;

		const result = await executeRegisteredTool({
			workspacePath,
			approved: true,
			call: {
				id: 'call-patch-02',
				name: 'workspace.applyPatch',
				arguments: { path: 'bad-patch.txt', patch: badPatch }
			}
		});
		expect(result.outcome).toBe('error');
	});

	it('routes process and snapshot tools through approval policy', async () => {
		await expect(
			executeRegisteredTool({
				workspacePath,
				call: {
					id: 'call-005',
					name: 'process.start',
					arguments: { command: 'bun', args: ['--version'] }
				}
			})
		).resolves.toMatchObject({ outcome: 'approval_required' });

		await expect(
			executeRegisteredTool({
				workspacePath,
				call: {
					id: 'call-006',
					name: 'sandbox.snapshot',
					arguments: { label: 'before-edit' }
				}
			})
		).resolves.toMatchObject({ outcome: 'approval_required' });
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

	it('keeps armorer descriptors queryable through the registry', () => {
		expect(registeredTools.every((tool) => tool.schema)).toBe(true);
		expect(getToolManifest().every((tool) => tool.inputSchema.type === 'object')).toBe(true);
	});
});
