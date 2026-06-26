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
import {
	DELEGATE_TOOL,
	LOW_RISK_TOOL,
	MEMORY_WRITE_CANDIDATE_TOOL,
	MUTATING_WORKSPACE_TOOL,
	PROCESS_KILL_TOOL,
	PROCESS_START_TOOL,
	SANDBOX_SNAPSHOT_TOOL,
	SHELL_EXEC_TOOL
} from '../policy/risk';
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

const webSearchInput = z.object({
	query: z.string().min(1),
	maxResults: z.number().int().positive().max(10).default(5),
	includeDomains: z.array(z.string().min(1)).optional(),
	excludeDomains: z.array(z.string().min(1)).optional()
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

const processStartInput = z.object({
	command: z.string().min(1),
	args: z.array(z.string()).default([]),
	workingDirectory: z.string().min(1).optional(),
	timeoutMs: z.number().int().positive().max(30_000).optional()
});

const processKillInput = z.object({
	processId: z.string().min(1),
	signal: z.enum(['SIGTERM', 'SIGKILL']).default('SIGTERM')
});

const sandboxSnapshotInput = z.object({
	label: z.string().min(1),
	description: z.string().optional()
});

const memoryWriteCandidateInput = z.object({
	layer: z.enum(['session', 'durable', 'action-sensitive']),
	content: z.string().min(1),
	rationale: z.string().optional(),
	expiresAt: z.string().datetime().optional()
});

const delegateInput = z.object({
	prompt: z.string().min(1),
	maxTokens: z.number().int().positive().max(8_000).optional()
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

function defineCoreTools(): RegisteredTool[] {
	return [
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
}

function defineExtendedTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'web.search',
			description: 'Search the web with Tavily.',
			schema: webSearchInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'process.start',
			description: 'Start a long-running process in the current sandbox workspace.',
			schema: processStartInput,
			metadata: PROCESS_START_TOOL
		}),
		defineStardustTool({
			name: 'process.kill',
			description: 'Terminate a tracked sandbox process.',
			schema: processKillInput,
			metadata: PROCESS_KILL_TOOL
		}),
		defineStardustTool({
			name: 'sandbox.snapshot',
			description: 'Create a named snapshot of the current sandbox workspace.',
			schema: sandboxSnapshotInput,
			metadata: SANDBOX_SNAPSHOT_TOOL
		}),
		defineStardustTool({
			name: 'memory.writeCandidate',
			description: 'Propose a memory candidate for user review.',
			schema: memoryWriteCandidateInput,
			metadata: MEMORY_WRITE_CANDIDATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.research',
			description: 'Ask a research delegate to investigate a bounded question.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.code',
			description: 'Ask a code delegate to inspect or implement a bounded coding task.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		}),
		defineStardustTool({
			name: 'delegate.critic',
			description: 'Ask a critic delegate for an advisory review.',
			schema: delegateInput,
			metadata: DELEGATE_TOOL
		})
	];
}

export const registeredTools: RegisteredTool[] = [...defineCoreTools(), ...defineExtendedTools()];

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

function isToolConfigured(tool: RegisteredTool): boolean {
	return tool.name !== 'web.search' || Boolean(process.env.TAVILY_API_KEY);
}

function getConfiguredTools(): RegisteredTool[] {
	return registeredTools.filter(isToolConfigured);
}

export function getToolManifest(input: { allowedToolNames?: string[] } = {}): ToolManifestEntry[] {
	return filterToolManifest(getConfiguredTools(), input);
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

function buildToolStubResult(toolName: string, argumentsValue: unknown) {
	return {
		status: 'registered',
		toolName,
		arguments: argumentsValue,
		message: `${toolName} is registered for policy and manifest routing; execution is handled by a later activity integration.`
	};
}

export async function executeRegisteredTool(input: {
	call: ToolCallInput;
	workspacePath?: string;
	fetcher?: typeof fetch;
	approved?: boolean;
}): Promise<ToolExecutionResult> {
	const decision = validateToolCall(getConfiguredTools(), input.call);
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
			case 'web.search':
				content = buildToolStubResult(input.call.name, webSearchInput.parse(input.call.arguments));
				break;
			case 'process.start':
				content = buildToolStubResult(
					input.call.name,
					processStartInput.parse(input.call.arguments)
				);
				break;
			case 'process.kill':
				content = buildToolStubResult(
					input.call.name,
					processKillInput.parse(input.call.arguments)
				);
				break;
			case 'sandbox.snapshot':
				content = buildToolStubResult(
					input.call.name,
					sandboxSnapshotInput.parse(input.call.arguments)
				);
				break;
			case 'memory.writeCandidate':
				content = buildToolStubResult(
					input.call.name,
					memoryWriteCandidateInput.parse(input.call.arguments)
				);
				break;
			case 'delegate.research':
			case 'delegate.code':
			case 'delegate.critic':
				content = buildToolStubResult(input.call.name, delegateInput.parse(input.call.arguments));
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
