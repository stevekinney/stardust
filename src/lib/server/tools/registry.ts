import { eq } from 'drizzle-orm';
import {
	createRegistry,
	defineTool,
	type AnyToolDefinition,
	type JsonObject,
	type SerializedToolDefinition
} from 'armorer/core';
import { toAnthropicTools } from 'armorer/adapters/anthropic';
import type { ToolExecutionResult, ToolManifestEntry } from '@src/lib/types';
import {
	fenceUntrustedOutput,
	filterToolManifest,
	truncateToolOutput,
	type RegisteredTool,
	validateToolCall
} from '../policy/policy-engine';
import { hashApprovalArguments } from '../policy/arguments-hash';
import { toolInvocations } from '../db/schema';
import { executeWithIdempotency } from '../observability/idempotency';
import { spillLargeOutput } from '../artifacts/spill';
import { isMacOs } from './local-notifications';
import { registeredTools } from './tool-definitions';
import { executeToolCall, type ExecuteToolCallInput } from './execute-tool-call';

export { registeredTools } from './tool-definitions';

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

/** Tool names gated on `isMacOs()` — they shell out to macOS-only AppleScript automation. */
const DARWIN_ONLY_TOOL_NAMES = new Set(['notify.user', 'imessage.send']);

/**
 * Tool names whose output may contain untrusted third-party or user-controlled
 * text (web pages, feeds, wikis, docs, browser DOM state) and must be fenced
 * as a data block before reaching the model context, per
 * ARCHITECTURE.md:354 ("Tool output that may be untrusted is fenced as data").
 */
const UNTRUSTED_OUTPUT_TOOL_NAMES = new Set([
	'web.fetch',
	'workspace.readFile',
	'feed.read',
	'hackernews.read',
	'wikipedia.lookup',
	'docs.lookup',
	'browser.mcp.call'
]);

function isUntrustedOutputTool(toolName: string): boolean {
	return UNTRUSTED_OUTPUT_TOOL_NAMES.has(toolName);
}

function isToolConfigured(tool: RegisteredTool): boolean {
	if (DARWIN_ONLY_TOOL_NAMES.has(tool.name)) return isMacOs();
	return true;
}

/** Returns every tool whose configuration prerequisites (e.g. platform) are met. */
export function getConfiguredTools(): RegisteredTool[] {
	return registeredTools.filter(isToolConfigured);
}

/** Builds the tool manifest exposed to the model, optionally filtered to an allowlist. */
export function getToolManifest(input: { allowedToolNames?: string[] } = {}): ToolManifestEntry[] {
	return filterToolManifest(getConfiguredTools(), input);
}

/** Builds the Anthropic-formatted tool manifest exposed to the model. */
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
 * Validates, gates, executes, and persists a single tool call. Policy
 * validation and approval gating happen here; the actual per-tool dispatch
 * lives in {@link executeToolCall} (`execute-tool-call.ts`).
 */
export async function executeRegisteredTool(
	input: ExecuteToolCallInput
): Promise<ToolExecutionResult> {
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
		const content = await executeToolCall(input);

		const rawResult: ToolExecutionResult = {
			callId: input.call.id,
			toolName: input.call.name,
			outcome: 'success',
			content: isUntrustedOutputTool(input.call.name) ? fenceUntrustedOutput(content) : content
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
