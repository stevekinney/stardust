import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
	createRegistry,
	defineTool,
	serializeToolDefinition,
	type AnyToolDefinition,
	type JsonObject,
	type SerializedToolDefinition
} from 'armorer/core';
import { toAnthropicTools } from 'armorer/adapters/anthropic';
import { z } from 'zod';
import type {
	ToolCallInput,
	ToolExecutionResult,
	ToolManifestEntry,
	ToolMetadata
} from '@src/lib/types';
import { LOW_RISK_TOOL, MUTATING_WORKSPACE_TOOL, SHELL_EXEC_TOOL } from '../policy/risk';
import {
	assertSideEffectAllowed,
	fenceUntrustedOutput,
	filterToolManifest,
	truncateToolOutput,
	type RegisteredTool,
	validateToolCall
} from '../policy/policy-engine';
import { fetchWithSsrfGuard } from '../policy/ssrf';

const webFetchInput = z.object({
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).optional(),
	maxBytes: z.number().int().positive().max(256_000).optional()
});

const pathInput = z.object({
	path: z.string().min(1)
});

const writeFileInput = pathInput.extend({
	content: z.string()
});

const applyPatchInput = pathInput.extend({
	content: z.string()
});

const shellExecInput = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	timeoutMs: z.number().int().positive().max(30_000).optional()
});

function defineStardustTool(input: {
	name: string;
	description: string;
	schema: z.ZodTypeAny;
	metadata: ToolMetadata;
}): RegisteredTool {
	const definition = defineTool({
		name: input.name,
		description: input.description,
		input: input.schema,
		metadata: input.metadata
	});
	const serialized = serializeToolDefinition(definition as AnyToolDefinition);
	return {
		name: serialized.identity.name,
		description: serialized.display.description,
		inputSchema: serialized.input,
		metadata: input.metadata,
		schema: input.schema
	};
}

export const registeredTools: RegisteredTool[] = [
	defineStardustTool({
		name: 'web.fetch',
		description: 'Fetch an HTTP or HTTPS URL with SSRF protection.',
		schema: webFetchInput,
		metadata: LOW_RISK_TOOL
	}),
	defineStardustTool({
		name: 'workspace.readFile',
		description: 'Read a file from the current workspace.',
		schema: pathInput,
		metadata: LOW_RISK_TOOL
	}),
	defineStardustTool({
		name: 'workspace.writeFile',
		description: 'Write a file in the current workspace.',
		schema: writeFileInput,
		metadata: MUTATING_WORKSPACE_TOOL
	}),
	defineStardustTool({
		name: 'workspace.applyPatch',
		description: 'Replace a workspace file with patched content.',
		schema: applyPatchInput,
		metadata: MUTATING_WORKSPACE_TOOL
	}),
	defineStardustTool({
		name: 'shell.exec',
		description: 'Run a shell command in the current workspace.',
		schema: shellExecInput,
		metadata: SHELL_EXEC_TOOL
	})
];

export const stardustToolRegistry = createRegistry();
for (const tool of registeredTools) {
	stardustToolRegistry.register(
		defineTool({
			name: tool.name,
			description: tool.description,
			input: tool.schema,
			metadata: tool.metadata
		}) as AnyToolDefinition
	);
}

export function getToolManifest(input: { allowedToolNames?: string[] } = {}): ToolManifestEntry[] {
	return filterToolManifest(registeredTools, input);
}

export function getAnthropicToolManifest(input: { allowedToolNames?: string[] } = {}) {
	const definitions: SerializedToolDefinition[] = getToolManifest(input).map((tool) => ({
		schemaVersion: '2020-12' as const,
		id: `default:${tool.name}`,
		identity: { namespace: 'default', name: tool.name },
		display: { description: tool.description },
		name: tool.name,
		description: tool.description,
		aliases: [],
		input: tool.inputSchema as JsonObject
	}));
	return toAnthropicTools(definitions);
}

function resolveWorkspacePath(workspacePath: string | undefined, filePath: string): string {
	const workspaceRoot = resolve(workspacePath ?? process.cwd());
	const targetPath = resolve(workspaceRoot, filePath);
	if (!targetPath.startsWith(workspaceRoot)) {
		throw new Error(`Workspace path escapes root: ${filePath}`);
	}
	return targetPath;
}

async function runShell(input: z.infer<typeof shellExecInput>, workspacePath?: string) {
	return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
		(resolvePromise) => {
			const child = spawn(input.command, input.args, {
				cwd: workspacePath ?? process.cwd(),
				stdio: ['ignore', 'pipe', 'pipe']
			});
			const chunks = { stdout: '', stderr: '' };
			const timeout = setTimeout(() => {
				child.kill('SIGTERM');
			}, input.timeoutMs ?? SHELL_EXEC_TOOL.timeoutMs);

			child.stdout.on('data', (chunk) => {
				chunks.stdout += String(chunk);
			});
			child.stderr.on('data', (chunk) => {
				chunks.stderr += String(chunk);
			});
			child.on('close', (exitCode) => {
				clearTimeout(timeout);
				resolvePromise({ exitCode, ...chunks });
			});
		}
	);
}

export async function executeRegisteredTool(input: {
	call: ToolCallInput;
	workspacePath?: string;
	fetcher?: typeof fetch;
	approved?: boolean;
}): Promise<ToolExecutionResult> {
	const decision = validateToolCall(registeredTools, input.call);
	if (decision.status === 'denied') {
		return {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'denied',
			content: decision.reason
		};
	}
	if (decision.status === 'approval_required' && !input.approved) {
		return {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'approval_required',
			content: { policyVersion: decision.policyVersion, metadata: decision.tool.metadata }
		};
	}
	if (assertSideEffectAllowed(decision.tool.metadata) === 'approval_required' && !input.approved) {
		return {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'approval_required',
			content: { policyVersion: '2026-06-26', metadata: decision.tool.metadata }
		};
	}

	try {
		let content: unknown;
		switch (input.call.name) {
			case 'web.fetch':
				content = await fetchWithSsrfGuard(
					webFetchInput.parse(input.call.arguments),
					input.fetcher
				);
				break;
			case 'workspace.readFile': {
				const args = pathInput.parse(input.call.arguments);
				content = await readFile(resolveWorkspacePath(input.workspacePath, args.path), 'utf8');
				break;
			}
			case 'workspace.writeFile': {
				const args = writeFileInput.parse(input.call.arguments);
				const targetPath = resolveWorkspacePath(input.workspacePath, args.path);
				await mkdir(dirname(targetPath), { recursive: true });
				await writeFile(targetPath, args.content, 'utf8');
				content = { path: args.path, bytes: Buffer.byteLength(args.content) };
				break;
			}
			case 'workspace.applyPatch': {
				const args = applyPatchInput.parse(input.call.arguments);
				const targetPath = resolveWorkspacePath(input.workspacePath, args.path);
				await mkdir(dirname(targetPath), { recursive: true });
				await writeFile(targetPath, args.content, 'utf8');
				content = { path: args.path, bytes: Buffer.byteLength(args.content) };
				break;
			}
			case 'shell.exec':
				content = await runShell(shellExecInput.parse(input.call.arguments), input.workspacePath);
				break;
			default:
				throw new Error(`Unknown tool: ${input.call.name}`);
		}

		return truncateToolOutput({
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'success',
			content: input.call.name === 'web.fetch' ? fenceUntrustedOutput(content) : content
		});
	} catch (error) {
		return {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'error',
			content: error instanceof Error ? error.message : String(error)
		};
	}
}
