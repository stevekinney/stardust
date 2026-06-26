import { anthropicConversationAdapter } from 'conversationalist/adapters/anthropic';
import type { AnthropicContentBlock } from 'conversationalist/adapters/anthropic';
import type { NormalizedModelMessage, NormalizedToolCall } from '@src/lib/types';

type AnthropicTextBlock = {
	type: 'text';
	text: string;
};

type AnthropicToolUseBlock = {
	type: 'tool_use';
	id: string;
	name: string;
	input: unknown;
};

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

export type AnthropicMessageResponse = {
	role: 'assistant';
	content: AnthropicResponseBlock[];
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
};

function isTextBlock(block: AnthropicResponseBlock): block is AnthropicTextBlock {
	return block.type === 'text' && 'text' in block && typeof block.text === 'string';
}

function isToolUseBlock(block: AnthropicResponseBlock): block is AnthropicToolUseBlock {
	return block.type === 'tool_use' && 'id' in block && 'name' in block && 'input' in block;
}

export function normalizeAnthropicMessage(
	response: AnthropicMessageResponse
): NormalizedModelMessage {
	const textBlocks: string[] = [];
	const toolCalls: NormalizedToolCall[] = [];

	for (const block of response.content) {
		if (isTextBlock(block)) {
			textBlocks.push(block.text);
		}
		if (isToolUseBlock(block)) {
			toolCalls.push({
				id: block.id,
				name: block.name,
				input: block.input
			});
		}
	}

	anthropicConversationAdapter.import({
		messages: [
			{
				role: response.role,
				content: response.content.filter(
					(block): block is AnthropicContentBlock => isTextBlock(block) || isToolUseBlock(block)
				)
			}
		]
	});

	return {
		text: textBlocks.join(''),
		toolCalls
	};
}

export function readAnthropicUsage(response: AnthropicMessageResponse): {
	inputTokens: number;
	outputTokens: number;
} {
	return {
		inputTokens: response.usage?.input_tokens ?? 0,
		outputTokens: response.usage?.output_tokens ?? 0
	};
}
