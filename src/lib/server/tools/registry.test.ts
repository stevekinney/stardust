import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_QUEUE_SANDBOX, TASK_QUEUE_TOOLS } from '@src/lib/types';
import {
	executeRegisteredTool,
	getAnthropicToolManifest,
	getToolManifest,
	registeredTools
} from './registry';

let workspacePath: string;

beforeEach(async () => {
	workspacePath = await mkdtemp(join(tmpdir(), 'stardust-tools-'));
});

afterEach(async () => {
	await rm(workspacePath, { recursive: true, force: true });
});

describe('tool registry', () => {
	it('exposes demo-critical tools with Stardust metadata', () => {
		const manifest = getToolManifest();
		expect(manifest.map((tool) => tool.name).sort()).toEqual([
			'shell.exec',
			'web.fetch',
			'workspace.applyPatch',
			'workspace.readFile',
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
