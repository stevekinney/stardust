import {
	appendAssistantMessage,
	appendSystemMessage,
	appendToolCalls,
	appendToolResult,
	appendUserMessage,
	createConversationHistory
} from 'conversationalist';
import { anthropicConversationAdapter } from 'conversationalist/adapters/anthropic';
import type { AnthropicConversation } from 'conversationalist/adapters/anthropic';
import type { ConversationHistory } from 'conversationalist';
import type { ContextMemoryNote } from '@src/lib/types';
import type { DatabaseClient } from '../db/client';
import { reconstructSessionTranscript } from '../stream';

export type ModelContext = {
	conversation: ConversationHistory;
	anthropic: AnthropicConversation;
};

/** Tool call entry as stored in a `tool_call` transcript event payload. */
type StoredToolCall = {
	id: string;
	name: string;
	input: unknown;
};

/** Payload shape for `tool_call` transcript events. */
type ToolCallPayload = {
	text?: string;
	calls: StoredToolCall[];
};

/** Payload shape for `tool_result` transcript events. */
type ToolResultPayload = {
	callId: string;
	content: unknown;
	isError?: boolean;
};

function readPayloadText(payload: string): string | null {
	const parsed = JSON.parse(payload) as unknown;
	if (!parsed || typeof parsed !== 'object') return null;
	const text = (parsed as { text?: unknown }).text;
	return typeof text === 'string' ? text : null;
}

function parseToolCallPayload(payload: string): ToolCallPayload | null {
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const p = parsed as Record<string, unknown>;
		if (!Array.isArray(p['calls'])) return null;
		return {
			text: typeof p['text'] === 'string' ? p['text'] : undefined,
			calls: p['calls'] as StoredToolCall[]
		};
	} catch {
		return null;
	}
}

function parseToolResultPayload(payload: string): ToolResultPayload | null {
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const p = parsed as Record<string, unknown>;
		if (typeof p['callId'] !== 'string') return null;
		return {
			callId: p['callId'],
			content: p['content'],
			isError: typeof p['isError'] === 'boolean' ? p['isError'] : false
		};
	} catch {
		return null;
	}
}

/**
 * Formats confirmed memory notes as a `<memory>` block for inclusion in the
 * system prompt. Each line carries full provenance: layer, tags, id, and content.
 * Only called when `memoryNotes` is non-empty, so the system prompt stays
 * byte-identical to the original when no memory is present.
 */
function buildMemorySection(notes: ContextMemoryNote[]): string {
	const lines = notes.map((note) => {
		const tagList = note.tags.length > 0 ? `, tags: ${note.tags.join(', ')}` : '';
		return `- [${note.layer}] ${note.content} (id: ${note.id}${tagList})`;
	});
	return `\n\n<memory>\nRelevant confirmed memories for this session:\n${lines.join('\n')}\n</memory>`;
}

/**
 * Rebuilds Anthropic-ready conversation context from durable transcript events.
 *
 * Handles user_message, assistant_message, tool_call, and tool_result events.
 * The Anthropic adapter automatically merges consecutive same-role messages so
 * text + tool_use blocks and multiple tool_result blocks coalesce correctly.
 *
 * When provided:
 * - `memoryNotes`: confirmed session/durable/action-sensitive memory is appended
 *   to the system prompt as a `<memory>` block with full provenance.
 * - `workspacePath`: a workspace-reference line is appended to the system prompt.
 * - `steeringMessages`: each message is appended as a `[Steering] <msg>` user
 *   turn after the transcript, so they reach the model at the next call boundary.
 *
 * Skills injection is not yet implemented for this POC. When the skill manifest
 * is wired up, pass it here so context assembly remains a single call site.
 */
export async function buildModelContext(
	database: DatabaseClient,
	input: {
		sessionId: string;
		systemPrompt?: string;
		maxMessages?: number;
		steeringMessages?: string[];
		memoryNotes?: ContextMemoryNote[];
		workspacePath?: string;
	}
): Promise<ModelContext> {
	const transcript = await reconstructSessionTranscript(database, input.sessionId);
	const visibleTranscript = transcript
		.filter(
			(event) =>
				event.kind === 'user_message' ||
				event.kind === 'assistant_message' ||
				event.kind === 'tool_call' ||
				event.kind === 'tool_result'
		)
		.slice(-(input.maxMessages ?? 40));

	let conversation = createConversationHistory();

	// Build the system prompt, optionally extending it with memory provenance
	// and a workspace reference.  Each extension is gated on non-empty input so
	// the base-case output stays byte-identical to the pre-existing behaviour.
	let systemPrompt = input.systemPrompt ?? '';
	if (input.memoryNotes && input.memoryNotes.length > 0) {
		systemPrompt += buildMemorySection(input.memoryNotes);
	}
	if (input.workspacePath) {
		systemPrompt += `\n\n<workspace>\nCurrent working directory: ${input.workspacePath}\n</workspace>`;
	}
	if (systemPrompt) {
		conversation = appendSystemMessage(conversation, systemPrompt);
	}

	for (const event of visibleTranscript) {
		if (event.kind === 'user_message') {
			const text = readPayloadText(event.payload);
			if (text) conversation = appendUserMessage(conversation, text);
		} else if (event.kind === 'assistant_message') {
			const text = readPayloadText(event.payload);
			if (text) conversation = appendAssistantMessage(conversation, text);
		} else if (event.kind === 'tool_call') {
			const toolCallPayload = parseToolCallPayload(event.payload);
			if (!toolCallPayload) continue;
			// Prepend any reasoning text as an assistant message so the adapter
			// merges it with the subsequent tool_use blocks into one turn.
			if (toolCallPayload.text) {
				conversation = appendAssistantMessage(conversation, toolCallPayload.text);
			}
			if (toolCallPayload.calls.length > 0) {
				conversation = appendToolCalls(
					conversation,
					toolCallPayload.calls.map((call) => ({
						id: call.id,
						name: call.name,
						arguments: call.input
					}))
				);
			}
		} else if (event.kind === 'tool_result') {
			const toolResultPayload = parseToolResultPayload(event.payload);
			if (!toolResultPayload) continue;
			conversation = appendToolResult(conversation, {
				callId: toolResultPayload.callId,
				outcome: toolResultPayload.isError ? 'error' : 'success',
				content: toolResultPayload.content
			});
		}
	}

	// Append steering messages as user turns after the transcript so they reach
	// the model at this call boundary.  The conversationalist adapter merges
	// consecutive same-role messages, so multiple steering messages coalesce into
	// a single user block alongside any open tool-result turns.
	if (input.steeringMessages && input.steeringMessages.length > 0) {
		for (const message of input.steeringMessages) {
			conversation = appendUserMessage(conversation, `[Steering] ${message}`);
		}
	}

	return {
		conversation,
		anthropic: anthropicConversationAdapter.export(conversation)
	};
}
