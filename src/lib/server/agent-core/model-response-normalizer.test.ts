import { describe, expect, it } from 'vitest';
import { normalizeAnthropicMessage, readAnthropicUsage } from './model-response-normalizer';

describe('model response normalizer', () => {
	it('normalizes provider content into a serializable Stardust message', () => {
		const response = {
			role: 'assistant' as const,
			content: [
				{ type: 'text' as const, text: 'Use ' },
				{
					type: 'tool_use' as const,
					id: 'tool-call-001',
					name: 'workspace.readFile',
					input: { path: 'README.md' }
				},
				{ type: 'text' as const, text: 'this file.' }
			],
			usage: {
				input_tokens: 12,
				output_tokens: 8
			}
		};

		expect(normalizeAnthropicMessage(response)).toEqual({
			text: 'Use this file.',
			toolCalls: [
				{
					id: 'tool-call-001',
					name: 'workspace.readFile',
					input: { path: 'README.md' }
				}
			]
		});
		expect(readAnthropicUsage(response)).toEqual({
			inputTokens: 12,
			outputTokens: 8
		});
	});
});
