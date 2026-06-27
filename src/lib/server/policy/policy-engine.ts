import { z } from 'zod';
import type {
	ToolCallInput,
	ToolExecutionResult,
	ToolManifestEntry,
	ToolMetadata,
	ToolPolicyDecision
} from '@src/lib/types';
import { TOOL_RESULT_INLINE_LIMIT } from '../config';
import { detectPromptInjection } from './prompt-injection';
import { POLICY_VERSION, riskRequiresApproval } from './risk';

const MAX_INLINE_OUTPUT_CHARACTERS = TOOL_RESULT_INLINE_LIMIT;

export type RegisteredTool = ToolManifestEntry & {
	schema: z.ZodTypeAny;
};

function isToolAllowed(tool: RegisteredTool, allowlist?: Set<string>): boolean {
	return !allowlist || allowlist.has(tool.name);
}

export function filterToolManifest(
	tools: RegisteredTool[],
	input: { allowedToolNames?: string[] } = {}
): ToolManifestEntry[] {
	const allowlist = input.allowedToolNames ? new Set(input.allowedToolNames) : undefined;
	return tools.filter((tool) => isToolAllowed(tool, allowlist)).map(toManifestEntry);
}

function toManifestEntry(tool: RegisteredTool): ToolManifestEntry {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		metadata: tool.metadata
	};
}

export function validateToolCall(tools: RegisteredTool[], call: ToolCallInput): ToolPolicyDecision {
	const tool = tools.find((candidate) => candidate.name === call.name);
	if (!tool) return { status: 'denied', reason: `Unknown tool: ${call.name}` };

	const parsed = tool.schema.safeParse(call.arguments);
	if (!parsed.success) {
		return {
			status: 'denied',
			reason: `Malformed arguments for ${call.name}: ${parsed.error.issues[0]?.message ?? 'invalid input'}`
		};
	}

	// Stage 2: reject prompt-injection-shaped calls before the approval/allowed branch.
	const injectionReason = detectPromptInjection(call);
	if (injectionReason !== null) {
		return { status: 'denied', reason: injectionReason };
	}

	if (tool.metadata.requiresApproval || riskRequiresApproval(tool.metadata.risk)) {
		return { status: 'approval_required', tool, policyVersion: POLICY_VERSION };
	}

	return { status: 'allowed', tool };
}

export function assertSideEffectAllowed(metadata: ToolMetadata): ToolPolicyDecision['status'] {
	return metadata.requiresApproval || riskRequiresApproval(metadata.risk)
		? 'approval_required'
		: 'allowed';
}

export function fenceUntrustedOutput(content: unknown): string {
	const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
	return `\`\`\`text\n${text}\n\`\`\``;
}

export function truncateToolOutput(result: ToolExecutionResult): ToolExecutionResult {
	const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
	if (text.length <= MAX_INLINE_OUTPUT_CHARACTERS) return result;

	const head = text.slice(0, MAX_INLINE_OUTPUT_CHARACTERS / 2);
	const tail = text.slice(-MAX_INLINE_OUTPUT_CHARACTERS / 2);
	return {
		...result,
		content: `${head}\n\n[truncated ${text.length - MAX_INLINE_OUTPUT_CHARACTERS} characters]\n\n${tail}`,
		metadata: {
			...result.metadata,
			truncated: true,
			originalCharacters: text.length
		}
	};
}
