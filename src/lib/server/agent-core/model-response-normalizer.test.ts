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

	it('ignores server_tool_use, web_search_tool_result, and web_fetch_tool_result blocks while still extracting interleaved text', () => {
		const response = {
			role: 'assistant' as const,
			content: [
				{ type: 'text' as const, text: 'Let me check the docs. ' },
				{
					type: 'server_tool_use',
					id: 'srvtoolu_01',
					name: 'web_search',
					input: { query: 'stardust release notes' }
				},
				{
					type: 'web_search_tool_result',
					tool_use_id: 'srvtoolu_01',
					content: [
						{
							type: 'web_search_result',
							url: 'https://example.com',
							title: 'Stardust release notes',
							encrypted_content: 'abc123'
						}
					]
				},
				{
					type: 'server_tool_use',
					id: 'srvtoolu_02',
					name: 'web_fetch',
					input: { url: 'https://example.com' }
				},
				{
					type: 'web_fetch_tool_result',
					tool_use_id: 'srvtoolu_02',
					content: {
						type: 'web_fetch_result',
						url: 'https://example.com',
						content: { type: 'document', source: { type: 'text', data: '...' } }
					}
				},
				{ type: 'text' as const, text: 'Here is what I found.' }
			],
			stop_reason: 'end_turn',
			usage: {
				input_tokens: 40,
				output_tokens: 22
			}
		};

		expect(normalizeAnthropicMessage(response)).toEqual({
			text: 'Let me check the docs. Here is what I found.',
			toolCalls: []
		});

		// The server-tool blocks must not break the conversation adapter's import
		// filter — it should silently drop them rather than throwing.
		expect(() => normalizeAnthropicMessage(response)).not.toThrow();
	});
});
