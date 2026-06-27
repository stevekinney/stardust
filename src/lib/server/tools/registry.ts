import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
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
import type { DatabaseClient } from '../db/client';
import { toolInvocations } from '../db/schema';
import { executeWithIdempotency } from '../observability/idempotency';
import {
	fenceUntrustedOutput,
	filterToolManifest,
	truncateToolOutput,
	type RegisteredTool,
	validateToolCall
} from '../policy/policy-engine';
import { fetchWithSsrfGuard } from '../policy/ssrf';
import type { ArtifactStore } from '../artifacts/artifact-store';
import { spillLargeOutput } from '../artifacts/spill';

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

/**
 * Input for `workspace.applyPatch`. The `patch` field must be a valid unified diff
 * (output of `diff -u` or `git diff`). The `path` field is the workspace-relative
 * target file path. The patch is applied with the system `patch` command.
 */
const applyPatchInput = pathInput.extend({
	patch: z.string().min(1)
});

const searchFilesInput = z.object({
	pattern: z.string().min(1),
	path: z.string().optional()
});

const memorySearchInput = z.object({
	query: z.string().min(1),
	sessionId: z.string().min(1),
	limit: z.number().int().positive().max(20).default(10)
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

/** Build a `RegisteredTool` record backed by an armorer definition. */
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
			description:
				'Apply a unified diff patch (from `diff -u` or `git diff`) to a file in the current workspace. Requires approval because it modifies files.',
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
			name: 'workspace.searchFiles',
			description: 'Search for files matching a glob pattern in the current workspace.',
			schema: searchFilesInput,
			metadata: LOW_RISK_TOOL
		}),
		defineStardustTool({
			name: 'memory.search',
			description: 'Search session memory using FTS5 lexical retrieval.',
			schema: memorySearchInput,
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

/**
 * Apply a unified diff patch to a file using the system `patch` command.
 * The target file path is provided explicitly so the diff headers are ignored.
 * Throws if the patch command exits non-zero (patch failed or produced a `.rej` file).
 */
async function applyUnifiedPatch(targetPath: string, patchContent: string): Promise<void> {
	return new Promise((resolvePromise, rejectPromise) => {
		// --no-backup-if-mismatch: do not create .orig backups on success
		// --reject-file=-: write reject hunks to /dev/stderr instead of a .rej file
		const child = spawn('patch', ['--no-backup-if-mismatch', '--reject-file=-', targetPath], {
			stdio: ['pipe', 'pipe', 'pipe']
		});

		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk);
		});

		child.stdin.write(patchContent, 'utf8');
		child.stdin.end();

		child.on('close', (exitCode) => {
			if (exitCode === 0) {
				resolvePromise();
			} else {
				rejectPromise(new Error(`patch failed (exit ${exitCode}): ${stderr || stdout}`.trimEnd()));
			}
		});

		child.on('error', (err) => {
			rejectPromise(new Error(`Failed to spawn patch: ${err.message}`));
		});
	});
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
	sessionId?: string;
	sessionKey?: string;
	runId?: string;
	workspacePath?: string;
	fetcher?: typeof fetch;
	approved?: boolean;
	database?: DatabaseClient;
	artifactStore?: ArtifactStore;
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

	async function executeAllowedTool(): Promise<ToolExecutionResult> {
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
				await applyUnifiedPatch(targetPath, args.patch);
				const patched = await readFile(targetPath, 'utf8');
				content = { path: args.path, bytes: Buffer.byteLength(patched) };
				break;
			}
			case 'shell.exec':
				content = await runShell(shellExecInput.parse(input.call.arguments), input.workspacePath);
				break;
			case 'web.search':
				content = buildToolStubResult(input.call.name, webSearchInput.parse(input.call.arguments));
				break;
			case 'workspace.searchFiles':
				content = buildToolStubResult(
					input.call.name,
					searchFilesInput.parse(input.call.arguments)
				);
				break;
			case 'memory.search':
				content = buildToolStubResult(
					input.call.name,
					memorySearchInput.parse(input.call.arguments)
				);
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

		const rawResult: ToolExecutionResult = {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'success',
			content: input.call.name === 'web.fetch' ? fenceUntrustedOutput(content) : content
		};

		// Spill to artifact when store is available and IDs are known; otherwise fall
		// back to the existing in-memory truncation path.
		if (input.artifactStore && input.sessionId && input.sessionKey && input.runId) {
			return spillLargeOutput(rawResult, {
				sessionId: input.sessionId,
				sessionKey: input.sessionKey,
				runId: input.runId,
				toolCallId: input.call.id,
				artifactStore: input.artifactStore,
				database: input.database
			});
		}

		return truncateToolOutput(rawResult);
	}

	try {
		if (input.database && input.sessionId && input.runId) {
			const createdAt = new Date().toISOString();
			await input.database
				.insert(toolInvocations)
				.values({
					id: `${input.runId}:${input.call.id}`,
					sessionId: input.sessionId,
					runId: input.runId,
					toolCallId: input.call.id,
					toolName: input.call.name,
					args: JSON.stringify(input.call.arguments),
					argsHash: input.call.id,
					idempotencyKey: input.call.idempotencyKey ?? null,
					status: 'running',
					risk: decision.tool.metadata.risk,
					taskQueue: decision.tool.metadata.taskQueue,
					startedAt: createdAt,
					createdAt
				})
				.onConflictDoNothing();
		}

		const result =
			input.call.idempotencyKey && input.database && input.runId
				? await executeWithIdempotency({
						database: input.database,
						idempotencyKey: input.call.idempotencyKey,
						runId: input.runId,
						toolCallId: input.call.id,
						execute: executeAllowedTool
					})
				: await executeAllowedTool();

		if (input.database && input.call.id) {
			await input.database
				.update(toolInvocations)
				.set({
					status: result.outcome === 'success' ? 'complete' : 'failed',
					resultInline: JSON.stringify(result.content),
					completedAt: new Date().toISOString()
				})
				.where(eq(toolInvocations.toolCallId, input.call.id));
		}

		return result;
	} catch (error) {
		if (input.database && input.call.id) {
			await input.database
				.update(toolInvocations)
				.set({
					status: 'failed',
					resultInline: JSON.stringify(error instanceof Error ? error.message : String(error)),
					completedAt: new Date().toISOString()
				})
				.where(eq(toolInvocations.toolCallId, input.call.id));
		}
		return {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'error',
			content: error instanceof Error ? error.message : String(error)
		};
	}
}
