import { randomUUID } from 'node:crypto';
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
import { hashApprovalArguments } from '../policy/arguments-hash';
import { fetchWithSsrfGuard } from '../policy/ssrf';
import type { ArtifactStore } from '../artifacts/artifact-store';
import { spillLargeOutput } from '../artifacts/spill';
import type { SandboxProvider } from '../sandbox/sandbox-provider';

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

/**
 * Tools that are registered for policy/metadata routing but not yet backed by a
 * real implementation. They are hidden from `getToolManifest()` (and therefore
 * from the model) until the backing infrastructure exists. Hiding is preferable to
 * returning a stub result that the model may misinterpret as real output.
 *
 * `memory.search` is intentionally kept hidden: the workflow pre-injects
 * confirmed memory notes into the system prompt via `searchMemory` before each
 * `callModel` invocation (agentRunWorkflow, retrievedMemory path), satisfying
 * ARCHITECTURE.md:293 without exposing an on-demand tool to the model.
 */
const UNIMPLEMENTED_TOOLS = new Set([
	'web.search',
	'memory.search',
	'memory.writeCandidate',
	'process.start',
	'process.kill',
	'delegate.research',
	'delegate.code',
	'delegate.critic'
]);

function isToolConfigured(tool: RegisteredTool): boolean {
	return !UNIMPLEMENTED_TOOLS.has(tool.name);
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

/**
 * Require a sandbox provider and session key for operations that must execute
 * through the provider boundary. Throws with a descriptive error if either is
 * missing — this is a programming error, not a user-facing error.
 *
 * Returns `[provider, sessionKey]` as a typed tuple so callers can destructure
 * and let TypeScript narrow both to non-optional types.
 */
function requireSandbox(
	sandboxProvider: SandboxProvider | undefined,
	sessionKey: string | undefined
): [SandboxProvider, string] {
	if (!sandboxProvider) {
		throw new Error('sandboxProvider is required for this tool but was not provided');
	}
	if (!sessionKey) {
		throw new Error('sessionKey is required for sandbox-routed tools but was not provided');
	}
	return [sandboxProvider, sessionKey];
}

export async function executeRegisteredTool(input: {
	call: ToolCallInput;
	sessionId?: string;
	/** Session key used as the sandbox workspace key (UUIDv4 for normal sessions,
	 *  `sched-{scheduleId}` for scheduled sessions). */
	sessionKey?: string;
	runId?: string;
	/** Retained for callers that still pass the workspace path for system-prompt construction.
	 *  Workspace operations now route through `sandboxProvider` using `sessionKey`. */
	workspacePath?: string;
	fetcher?: typeof fetch;
	approved?: boolean;
	database?: DatabaseClient;
	artifactStore?: ArtifactStore;
	/** Sandbox provider used for all workspace, shell, and snapshot tool operations. */
	sandboxProvider?: SandboxProvider;
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
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = pathInput.parse(input.call.arguments);
				content = await sandbox.readFile({ sessionKey, path: args.path });
				break;
			}
			case 'workspace.writeFile': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = writeFileInput.parse(input.call.arguments);
				// Snapshot the workspace before mutation so it can be restored if needed.
				await sandbox.snapshot({
					sessionKey,
					runId: input.runId,
					toolCallId: input.call.id,
					reason: `pre-write: ${args.path}`
				});
				await sandbox.writeFile({ sessionKey, path: args.path, contents: args.content });
				const written = await sandbox.readFile({ sessionKey, path: args.path });
				content = { path: args.path, bytes: Buffer.byteLength(written) };
				break;
			}
			case 'workspace.applyPatch': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = applyPatchInput.parse(input.call.arguments);
				// Write the patch content to a temp file inside the workspace.  The
				// provider's runCommand has no stdin support, so we use `patch -i
				// <tempfile>` rather than piping to stdin.
				const tempPatchPath = `.stardust-patch-${randomUUID()}.patch`;
				await sandbox.writeFile({ sessionKey, path: tempPatchPath, contents: args.patch });
				// Snapshot before the patch is applied.
				await sandbox.snapshot({
					sessionKey,
					runId: input.runId,
					toolCallId: input.call.id,
					reason: `pre-apply-patch: ${args.path}`
				});
				try {
					const patchResult = await sandbox.runCommand({
						sessionKey,
						runId: input.runId ?? 'tool',
						command: 'patch',
						args: ['--no-backup-if-mismatch', '--reject-file=-', '-i', tempPatchPath, args.path],
						toolCallId: input.call.id
					});
					if (patchResult.exitCode !== 0) {
						throw new Error(
							`patch failed (exit ${patchResult.exitCode}): ${patchResult.stderr || patchResult.stdout}`.trimEnd()
						);
					}
				} finally {
					// Best-effort cleanup of the temporary patch file.
					try {
						await sandbox.runCommand({
							sessionKey,
							runId: input.runId ?? 'tool',
							command: 'rm',
							args: ['-f', tempPatchPath],
							toolCallId: `${input.call.id}-cleanup`
						});
					} catch {
						// Cleanup failures are non-fatal; the sandbox snapshot absorbs the temp file.
					}
				}
				const patched = await sandbox.readFile({ sessionKey, path: args.path });
				content = { path: args.path, bytes: Buffer.byteLength(patched) };
				break;
			}
			case 'shell.exec': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = shellExecInput.parse(input.call.arguments);
				// Snapshot before arbitrary shell execution so the workspace state is
				// recoverable regardless of what the command does.
				await sandbox.snapshot({
					sessionKey,
					runId: input.runId,
					toolCallId: input.call.id,
					reason: `pre-shell: ${args.command}`
				});
				const result = await sandbox.runCommand({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: args.command,
					args: args.args,
					timeoutMs: args.timeoutMs,
					toolCallId: input.call.id
				});
				content = {
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: result.timedOut,
					status: result.status
				};
				break;
			}
			case 'workspace.searchFiles': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = searchFilesInput.parse(input.call.arguments);
				const findResult = await sandbox.runCommand({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: 'find',
					args: [args.path ?? '.', '-name', args.pattern, '-type', 'f'],
					toolCallId: input.call.id
				});
				content = {
					files: findResult.stdout.split('\n').filter(Boolean),
					pattern: args.pattern
				};
				break;
			}
			case 'sandbox.snapshot': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = sandboxSnapshotInput.parse(input.call.arguments);
				const snapshot = await sandbox.snapshot({
					sessionKey,
					runId: input.runId,
					toolCallId: input.call.id,
					reason: args.description ? `${args.label}: ${args.description}` : args.label
				});
				content = {
					id: snapshot.id,
					label: args.label,
					gitCommitSha: snapshot.gitCommitSha,
					createdAt: snapshot.createdAt
				};
				break;
			}
			default:
				throw new Error(`Unknown tool: ${input.call.name}`);
		}

		const rawResult: ToolExecutionResult = {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'success',
			// Both web.fetch and workspace.readFile may contain untrusted content that
			// could inject instructions into model context.  Fence both as data blocks
			// per ARCHITECTURE.md:354 ("Tool output that may be untrusted is fenced as data").
			content:
				input.call.name === 'web.fetch' || input.call.name === 'workspace.readFile'
					? fenceUntrustedOutput(content)
					: content
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
					argsHash: hashApprovalArguments(input.call.arguments),
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
			input.call.idempotencyKey &&
			input.database &&
			input.runId &&
			decision.tool.metadata.idempotencyBehavior === 'key-required'
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
