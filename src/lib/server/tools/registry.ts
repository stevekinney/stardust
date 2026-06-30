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
	BROWSER_ACTION_TOOL,
	BROWSER_INSPECT_TOOL,
	DELEGATE_TOOL,
	LOW_RISK_TOOL,
	MEMORY_WRITE_CANDIDATE_TOOL,
	MUTATING_WORKSPACE_TOOL,
	PROCESS_KILL_TOOL,
	PROCESS_START_TOOL,
	REPOSITORY_INSPECT_TOOL,
	SAFE_ARTIFACT_TOOL,
	SANDBOX_RESTORE_TOOL,
	SANDBOX_SNAPSHOT_TOOL,
	SHELL_EXEC_TOOL,
	TEMPORAL_MCP_TOOL,
	VERIFICATION_TOOL
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
import { TAVILY_API_KEY } from '../config';
import type { MemoryCandidate, MemoryLayer, MemorySearchResult } from '../memory';
import { persistToolArtifact } from './artifact-output';
import { actInBrowser, inspectBrowser } from './browser-agent';
import { inspectRepository } from './repository-inspection';
import { callTemporalMcpTool, inspectTemporal, isTemporalMcpToolAllowed } from './temporal-mcp';
import type {
	SandboxCommandInput,
	SandboxCommandResult,
	SandboxProcessKillInput,
	SandboxProcessKillResult,
	SandboxProcessStartInput,
	SandboxProcessStartResult,
	SandboxProvider
} from '../sandbox/sandbox-provider';

const webFetchInput = z.object({
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).optional(),
	maxBytes: z.number().int().positive().max(256_000).optional()
});

function readTavilyApiKey(): string {
	return process.env.TAVILY_API_KEY ?? TAVILY_API_KEY;
}

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
	layers: z.array(z.enum(['session', 'durable', 'action-sensitive'])).optional(),
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

const workspaceDiffInput = z.object({
	base: z.string().min(1).optional(),
	head: z.string().min(1).optional(),
	path: z.string().min(1).optional(),
	contextLines: z.number().int().min(0).max(20).default(3)
});

const sandboxRestoreInput = z.object({
	snapshotId: z.string().min(1),
	reason: z.string().min(1).optional()
});

const verificationRunInput = z.object({
	check: z.enum(['format:check', 'lint', 'typecheck', 'test:unit', 'test:e2e', 'test', 'build']),
	args: z.array(z.string()).default([]),
	timeoutMs: z.number().int().positive().max(120_000).optional()
});

const browserInspectInput = z.object({
	url: z.string().url(),
	waitForSelector: z.string().min(1).optional(),
	waitForLoadState: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
	includeScreenshot: z.boolean().default(true),
	includeAccessibilitySnapshot: z.boolean().default(true)
});

const browserActionInput = browserInspectInput.extend({
	actions: z
		.array(
			z.discriminatedUnion('type', [
				z.object({ type: z.literal('goto'), url: z.string().url() }),
				z.object({ type: z.literal('click'), selector: z.string().min(1) }),
				z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
				z.object({ type: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
				z.object({ type: z.literal('waitForSelector'), selector: z.string().min(1) }),
				z.object({
					type: z.literal('waitForLoadState'),
					state: z.enum(['load', 'domcontentloaded', 'networkidle'])
				})
			])
		)
		.min(1)
		.max(20)
});

const repositoryInspectInput = z.object({
	path: z.string().min(1).optional(),
	includePackageScripts: z.boolean().default(true),
	includeRoutes: z.boolean().default(true),
	includeTests: z.boolean().default(true),
	includeGitStatus: z.boolean().default(true)
});

const temporalInspectInput = z.object({
	workflowId: z.string().min(1).optional(),
	runId: z.string().min(1).optional(),
	taskQueue: z.string().min(1).optional(),
	namespace: z.string().min(1).optional()
});

const temporalMcpCallInput = z.object({
	toolName: z.string().min(1).refine(isTemporalMcpToolAllowed, {
		message: 'Temporal MCP tool is not exposed by Stardust policy'
	}),
	arguments: z.record(z.string(), z.unknown()).default({})
});

const delegateParallelInput = z.object({
	tasks: z
		.array(
			z.object({
				kind: z.enum(['research', 'code', 'critic']),
				label: z.string().min(1),
				prompt: z.string().min(1),
				maxTokens: z.number().int().positive().max(8_000).optional()
			})
		)
		.min(2)
		.max(6)
});

const reportArtifactInput = z.object({
	title: z.string().min(1),
	summary: z.string().min(1).optional(),
	sections: z
		.array(
			z.object({
				heading: z.string().min(1),
				body: z.string().min(1)
			})
		)
		.default([]),
	includeToolResults: z.boolean().default(true)
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
			name: 'workspace.diff',
			description:
				'Generate a read-only git diff between sandbox snapshots, commits, or the working tree.',
			schema: workspaceDiffInput,
			metadata: REPOSITORY_INSPECT_TOOL
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
			name: 'sandbox.restore',
			description:
				'Restore the sandbox workspace to a previous snapshot commit. Requires approval.',
			schema: sandboxRestoreInput,
			metadata: SANDBOX_RESTORE_TOOL
		}),
		defineStardustTool({
			name: 'verification.run',
			description:
				'Run a structured verification command such as format:check, lint, typecheck, test, or build.',
			schema: verificationRunInput,
			metadata: VERIFICATION_TOOL
		}),
		defineStardustTool({
			name: 'browser.inspect',
			description:
				'Inspect a page with Playwright and capture console, request, accessibility, and screenshot evidence.',
			schema: browserInspectInput,
			metadata: BROWSER_INSPECT_TOOL
		}),
		defineStardustTool({
			name: 'browser.act',
			description:
				'Perform approved browser interactions with Playwright, then capture inspection evidence.',
			schema: browserActionInput,
			metadata: BROWSER_ACTION_TOOL
		}),
		defineStardustTool({
			name: 'repository.inspect',
			description:
				'Read a compact project map: package scripts, dependencies, routes, nearby tests, and git status.',
			schema: repositoryInspectInput,
			metadata: REPOSITORY_INSPECT_TOOL
		}),
		defineStardustTool({
			name: 'temporal.inspect',
			description:
				'Run a read-only Temporal MCP triage for connection, workflow, history, and task queue state.',
			schema: temporalInspectInput,
			metadata: TEMPORAL_MCP_TOOL
		}),
		defineStardustTool({
			name: 'temporal.mcp.call',
			description: 'Call an allowed read-only temporal-mcp tool through Stardust policy.',
			schema: temporalMcpCallInput,
			metadata: TEMPORAL_MCP_TOOL
		}),
		defineStardustTool({
			name: 'artifact.createReport',
			description:
				'Create a local Markdown report artifact from summaries, tool evidence, verification output, and links.',
			schema: reportArtifactInput,
			metadata: SAFE_ARTIFACT_TOOL
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
		}),
		defineStardustTool({
			name: 'delegate.parallel',
			description: 'Launch multiple approved child workflow delegate tasks in parallel.',
			schema: delegateParallelInput,
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
	return tool.name !== 'web.search' || readTavilyApiKey().length > 0;
}

export function getConfiguredTools(): RegisteredTool[] {
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

function requireCommandRunner(
	commandRunner: ((input: SandboxCommandInput) => Promise<SandboxCommandResult>) | undefined
): (input: SandboxCommandInput) => Promise<SandboxCommandResult> {
	if (!commandRunner) {
		throw new Error('runSandboxCommand is required for command-backed tools but was not provided');
	}
	return commandRunner;
}

function requireSessionRun(input: { sessionKey?: string; runId?: string }): {
	sessionKey: string;
	runId: string;
} {
	if (!input.sessionKey) {
		throw new Error('sessionKey is required for session-scoped tools but was not provided');
	}
	if (!input.runId) {
		throw new Error('runId is required for run-scoped tools but was not provided');
	}
	return { sessionKey: input.sessionKey, runId: input.runId };
}

function toMemoryLayer(layer: 'session' | 'durable' | 'action-sensitive'): MemoryLayer {
	return layer === 'action-sensitive' ? 'action_sensitive' : layer;
}

async function searchWebWithTavily(input: {
	query: string;
	maxResults: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	fetcher?: typeof fetch;
}) {
	const apiKey = readTavilyApiKey();
	if (!apiKey) throw new Error('TAVILY_API_KEY is required for web.search');
	const response = await (input.fetcher ?? fetch)('https://api.tavily.com/search', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			query: input.query,
			max_results: input.maxResults,
			include_domains: input.includeDomains,
			exclude_domains: input.excludeDomains
		})
	});
	if (!response.ok) {
		throw new Error(`web.search failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		results?: Array<{ title?: unknown; url?: unknown; content?: unknown; snippet?: unknown }>;
	};
	return {
		query: input.query,
		results: (payload.results ?? []).slice(0, input.maxResults).map((result) => ({
			title: typeof result.title === 'string' ? result.title : '',
			url: typeof result.url === 'string' ? result.url : '',
			snippet:
				typeof result.snippet === 'string'
					? result.snippet
					: typeof result.content === 'string'
						? result.content
						: ''
		}))
	};
}

function diffCommandArguments(input: z.infer<typeof workspaceDiffInput>): string[] {
	const args = ['diff', `--unified=${input.contextLines}`];
	if (input.base && input.head) args.push(input.base, input.head);
	else if (input.base) args.push(input.base);
	else if (input.head) args.push('HEAD', input.head);
	if (input.path) args.push('--', input.path);
	return args;
}

function verificationCommand(input: z.infer<typeof verificationRunInput>): {
	command: string;
	args: string[];
} {
	return { command: 'bun', args: ['run', input.check, ...input.args] };
}

function createReportMarkdown(input: {
	title: string;
	summary?: string;
	sections: Array<{ heading: string; body: string }>;
	toolRows: Array<typeof toolInvocations.$inferSelect>;
	includeToolResults: boolean;
}): string {
	const lines = [`# ${input.title}`, ''];
	if (input.summary) lines.push(input.summary, '');
	for (const section of input.sections) {
		lines.push(`## ${section.heading}`, '', section.body, '');
	}
	if (input.includeToolResults) {
		lines.push('## Tool Evidence', '');
		for (const tool of input.toolRows) {
			lines.push(`### ${tool.toolName}`, '');
			lines.push(`- Status: ${tool.status}`);
			lines.push(`- Risk: ${tool.risk}`);
			lines.push(`- Task queue: ${tool.taskQueue}`);
			if (tool.resultRef) lines.push(`- Artifact: ${tool.resultRef}`);
			if (tool.resultInline) lines.push('', '```json', tool.resultInline, '```');
			lines.push('');
		}
		if (input.toolRows.length === 0) lines.push('No tool invocations were recorded.', '');
	}
	return `${lines.join('\n').trimEnd()}\n`;
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
	/** Heartbeat-aware Temporal Activity wrapper for sandbox subprocess execution. */
	runSandboxCommand?: (input: SandboxCommandInput) => Promise<SandboxCommandResult>;
	startSandboxProcess?: (input: SandboxProcessStartInput) => Promise<SandboxProcessStartResult>;
	killSandboxProcess?: (input: SandboxProcessKillInput) => Promise<SandboxProcessKillResult>;
	searchMemory?: (input: {
		sessionId: string;
		query: string;
		layers?: MemoryLayer[];
		limit?: number;
	}) => Promise<MemorySearchResult[]>;
	writeMemoryCandidate?: (input: {
		sessionId: string;
		runId: string;
		layer: MemoryLayer;
		content: string;
		tags?: string[];
		reason?: string | null;
	}) => Promise<MemoryCandidate>;
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
			case 'web.search': {
				const args = webSearchInput.parse(input.call.arguments);
				content = await searchWebWithTavily({ ...args, fetcher: input.fetcher });
				break;
			}
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
				const runCommand = requireCommandRunner(input.runSandboxCommand);
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
					const patchResult = await runCommand({
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
						await runCommand({
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
				const runCommand = requireCommandRunner(input.runSandboxCommand);
				const args = shellExecInput.parse(input.call.arguments);
				// Snapshot before arbitrary shell execution so the workspace state is
				// recoverable regardless of what the command does.
				await sandbox.snapshot({
					sessionKey,
					runId: input.runId,
					toolCallId: input.call.id,
					reason: `pre-shell: ${args.command}`
				});
				const result = await runCommand({
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
			case 'process.start': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const startProcess = input.startSandboxProcess ?? sandbox.startProcess.bind(sandbox);
				const args = processStartInput.parse(input.call.arguments);
				content = await startProcess({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: args.command,
					args: args.args,
					cwd: args.workingDirectory,
					timeoutMs: args.timeoutMs,
					toolCallId: input.call.id
				});
				break;
			}
			case 'process.kill': {
				const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const killProcess =
					input.killSandboxProcess ??
					input.sandboxProvider!.killProcess.bind(input.sandboxProvider);
				const args = processKillInput.parse(input.call.arguments);
				content = await killProcess({
					sessionKey,
					processId: args.processId,
					signal: args.signal
				});
				break;
			}
			case 'workspace.searchFiles': {
				const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const runCommand = requireCommandRunner(input.runSandboxCommand);
				const args = searchFilesInput.parse(input.call.arguments);
				const findResult = await runCommand({
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
			case 'workspace.diff': {
				const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const runCommand = requireCommandRunner(input.runSandboxCommand);
				const args = workspaceDiffInput.parse(input.call.arguments);
				const result = await runCommand({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: 'git',
					args: diffCommandArguments(args),
					toolCallId: input.call.id
				});
				const artifact =
					input.artifactStore && input.sessionId && input.sessionKey && input.runId && result.stdout
						? await persistToolArtifact({
								sessionId: input.sessionId,
								sessionKey: input.sessionKey,
								runId: input.runId,
								toolCallId: input.call.id,
								artifactStore: input.artifactStore,
								database: input.database,
								content: result.stdout,
								mimeType: 'text/x-patch',
								extension: 'patch'
							})
						: null;
				content = {
					base: args.base ?? 'working-tree',
					head: args.head ?? null,
					path: args.path ?? null,
					exitCode: result.exitCode,
					status: result.status,
					patch: result.stdout,
					stderr: result.stderr,
					artifact
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
			case 'sandbox.restore': {
				const [sandbox, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const args = sandboxRestoreInput.parse(input.call.arguments);
				await sandbox.restore(sessionKey, args.snapshotId);
				content = {
					snapshotId: args.snapshotId,
					restoredAt: new Date().toISOString(),
					reason: args.reason ?? null
				};
				break;
			}
			case 'verification.run': {
				const [, sessionKey] = requireSandbox(input.sandboxProvider, input.sessionKey);
				const runCommand = requireCommandRunner(input.runSandboxCommand);
				const args = verificationRunInput.parse(input.call.arguments);
				const command = verificationCommand(args);
				const result = await runCommand({
					sessionKey,
					runId: input.runId ?? 'tool',
					command: command.command,
					args: command.args,
					timeoutMs: args.timeoutMs,
					toolCallId: input.call.id
				});
				const log = [
					`$ ${[command.command, ...command.args].join(' ')}`,
					'',
					'## stdout',
					result.stdout || '(empty)',
					'',
					'## stderr',
					result.stderr || '(empty)'
				].join('\n');
				const artifact =
					input.artifactStore && input.sessionId && input.sessionKey && input.runId
						? await persistToolArtifact({
								sessionId: input.sessionId,
								sessionKey: input.sessionKey,
								runId: input.runId,
								toolCallId: input.call.id,
								artifactStore: input.artifactStore,
								database: input.database,
								content: log,
								mimeType: 'text/markdown',
								extension: 'md'
							})
						: null;
				content = {
					check: args.check,
					command: command.command,
					args: command.args,
					status: result.status,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					stdout: result.stdout,
					stderr: result.stderr,
					artifact
				};
				break;
			}
			case 'browser.inspect': {
				const { sessionKey, runId } = requireSessionRun(input);
				if (!input.sessionId)
					throw new Error('sessionId is required for browser.inspect but was not provided');
				const args = browserInspectInput.parse(input.call.arguments);
				content = await inspectBrowser({
					...args,
					sessionId: input.sessionId,
					sessionKey,
					runId,
					toolCallId: input.call.id,
					artifactStore: input.artifactStore,
					database: input.database
				});
				break;
			}
			case 'browser.act': {
				const { sessionKey, runId } = requireSessionRun(input);
				if (!input.sessionId)
					throw new Error('sessionId is required for browser.act but was not provided');
				const args = browserActionInput.parse(input.call.arguments);
				content = await actInBrowser({
					...args,
					sessionId: input.sessionId,
					sessionKey,
					runId,
					toolCallId: input.call.id,
					artifactStore: input.artifactStore,
					database: input.database
				});
				break;
			}
			case 'repository.inspect': {
				const { sessionKey, runId } = requireSessionRun(input);
				const args = repositoryInspectInput.parse(input.call.arguments);
				content = await inspectRepository({
					sessionKey,
					runId,
					workspacePath: input.workspacePath,
					runCommand: input.runSandboxCommand,
					...args
				});
				break;
			}
			case 'temporal.inspect': {
				content = await inspectTemporal(temporalInspectInput.parse(input.call.arguments));
				if (input.artifactStore && input.sessionId && input.sessionKey && input.runId) {
					content = {
						...(content as Record<string, unknown>),
						artifact: await persistToolArtifact({
							sessionId: input.sessionId,
							sessionKey: input.sessionKey,
							runId: input.runId,
							toolCallId: input.call.id,
							artifactStore: input.artifactStore,
							database: input.database,
							content: JSON.stringify(content, null, 2),
							mimeType: 'application/json',
							extension: 'json'
						})
					};
				}
				break;
			}
			case 'temporal.mcp.call': {
				const args = temporalMcpCallInput.parse(input.call.arguments);
				content = await callTemporalMcpTool({ toolName: args.toolName, arguments: args.arguments });
				break;
			}
			case 'artifact.createReport': {
				const { sessionKey, runId } = requireSessionRun(input);
				if (!input.sessionId || !input.artifactStore) {
					throw new Error(
						'sessionId and artifactStore are required for artifact.createReport but were not provided'
					);
				}
				const args = reportArtifactInput.parse(input.call.arguments);
				const toolRows =
					input.database && args.includeToolResults
						? await input.database
								.select()
								.from(toolInvocations)
								.where(eq(toolInvocations.runId, runId))
						: [];
				content = await persistToolArtifact({
					sessionId: input.sessionId,
					sessionKey,
					runId,
					toolCallId: input.call.id,
					artifactStore: input.artifactStore,
					database: input.database,
					content: createReportMarkdown({
						title: args.title,
						summary: args.summary,
						sections: args.sections,
						includeToolResults: args.includeToolResults,
						toolRows
					}),
					mimeType: 'text/markdown',
					extension: 'md'
				});
				break;
			}
			case 'delegate.parallel': {
				const args = delegateParallelInput.parse(input.call.arguments);
				content = {
					tasks: args.tasks,
					message:
						'delegate.parallel is executed by the orchestrator workflow after approval, not inside the tool activity.'
				};
				break;
			}
			case 'memory.search': {
				if (!input.searchMemory) {
					throw new Error('searchMemory is required for memory.search but was not provided');
				}
				const { sessionKey } = requireSessionRun(input);
				const args = memorySearchInput.parse(input.call.arguments);
				content = await input.searchMemory({
					sessionId: sessionKey,
					query: args.query,
					layers: args.layers?.map(toMemoryLayer),
					limit: args.limit
				});
				break;
			}
			case 'memory.writeCandidate': {
				if (!input.writeMemoryCandidate) {
					throw new Error(
						'writeMemoryCandidate is required for memory.writeCandidate but was not provided'
					);
				}
				const { sessionKey, runId } = requireSessionRun(input);
				const args = memoryWriteCandidateInput.parse(input.call.arguments);
				content = await input.writeMemoryCandidate({
					sessionId: sessionKey,
					runId,
					layer: toMemoryLayer(args.layer),
					content: args.content,
					reason: args.rationale ?? null
				});
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
