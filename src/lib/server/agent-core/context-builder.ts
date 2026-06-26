import {
	appendAssistantMessage,
	appendSystemMessage,
	appendUserMessage,
	createConversationHistory
} from 'conversationalist';
import { anthropicConversationAdapter } from 'conversationalist/adapters/anthropic';
import type { AnthropicConversation } from 'conversationalist/adapters/anthropic';
import type { ConversationHistory } from 'conversationalist';
import type { DatabaseClient } from '../db/client';
import { reconstructSessionTranscript } from '../stream';

export type ModelContext = {
	conversation: ConversationHistory;
	anthropic: AnthropicConversation;
};

function readPayloadText(payload: string): string | null {
	const parsed = JSON.parse(payload) as unknown;
	if (!parsed || typeof parsed !== 'object') return null;
	const text = (parsed as { text?: unknown }).text;
	return typeof text === 'string' ? text : null;
}

export async function buildModelContext(
	database: DatabaseClient,
	input: { sessionId: string; systemPrompt?: string; maxMessages?: number }
): Promise<ModelContext> {
	const transcript = await reconstructSessionTranscript(database, input.sessionId);
	const visibleTranscript = transcript
		.filter((event) => event.kind === 'user_message' || event.kind === 'assistant_message')
		.slice(-(input.maxMessages ?? 40));

	let conversation = createConversationHistory();

	if (input.systemPrompt) {
		conversation = appendSystemMessage(conversation, input.systemPrompt);
	}

	for (const event of visibleTranscript) {
		const text = readPayloadText(event.payload);
		if (!text) continue;
		conversation =
			event.kind === 'user_message'
				? appendUserMessage(conversation, text)
				: appendAssistantMessage(conversation, text);
	}

	return {
		conversation,
		anthropic: anthropicConversationAdapter.export(conversation)
	};
}
