import { describe, expect, it, vi } from 'vitest';
import { continueAnthropicStream } from './model-runner';
import type { AnthropicMessageResponse } from './model-response-normalizer';

describe('continueAnthropicStream', () => {
	it('returns the response unchanged when the model does not pause', async () => {
		const streamOnce = vi.fn(
			async (): Promise<AnthropicMessageResponse> => ({
				role: 'assistant',
				content: [{ type: 'text', text: 'hello' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 10, output_tokens: 5 }
			})
		);
		const onDelta = vi.fn(async () => {});

		const result = await continueAnthropicStream(
			[{ role: 'user', content: 'hi' }],
			streamOnce,
			onDelta
		);

		expect(streamOnce).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			role: 'assistant',
			content: [{ type: 'text', text: 'hello' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 5 }
		});
	});

	it('continues on pause_turn by appending an assistant turn, not a user turn', async () => {
		const seenMessages: unknown[][] = [];
		const streamOnce = vi.fn(async (messages: unknown[]): Promise<AnthropicMessageResponse> => {
			seenMessages.push(messages);
			if (seenMessages.length === 1) {
				return {
					role: 'assistant',
					content: [{ type: 'text', text: 'Searching...' }],
					stop_reason: 'pause_turn',
					usage: { input_tokens: 100, output_tokens: 20 }
				};
			}
			return {
				role: 'assistant',
				content: [{ type: 'text', text: ' Found it.' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 50, output_tokens: 10 }
			};
		});
		const onDelta = vi.fn(async () => {});

		const result = await continueAnthropicStream(
			[{ role: 'user', content: 'search for something' }],
			streamOnce,
			onDelta
		);

		expect(streamOnce).toHaveBeenCalledTimes(2);

		// Second call's messages = first call's messages + the assistant turn from
		// the first response. No user message is inserted between iterations.
		expect(seenMessages[1]).toEqual([
			{ role: 'user', content: 'search for something' },
			{ role: 'assistant', content: [{ type: 'text', text: 'Searching...' }] }
		]);

		// content and usage are merged across both iterations, in order.
		expect(result).toEqual({
			role: 'assistant',
			content: [
				{ type: 'text', text: 'Searching...' },
				{ type: 'text', text: ' Found it.' }
			],
			stop_reason: 'end_turn',
			usage: { input_tokens: 150, output_tokens: 30 }
		});
	});

	it('caps continuations at 5 and returns the accumulated result with the pause_turn stop_reason intact', async () => {
		const streamOnce = vi.fn(
			async (): Promise<AnthropicMessageResponse> => ({
				role: 'assistant',
				content: [{ type: 'text', text: 'still going' }],
				stop_reason: 'pause_turn',
				usage: { input_tokens: 1, output_tokens: 1 }
			})
		);
		const onDelta = vi.fn(async () => {});

		const result = await continueAnthropicStream(
			[{ role: 'user', content: 'go' }],
			streamOnce,
			onDelta
		);

		// 1 initial call + 5 continuations = 6 total calls, then give up.
		expect(streamOnce).toHaveBeenCalledTimes(6);
		expect(result.stop_reason).toBe('pause_turn');
		expect(result.content).toHaveLength(6);
		expect(result.usage).toEqual({ input_tokens: 6, output_tokens: 6 });
	});

	it('forwards onDelta to every iteration', async () => {
		let call = 0;
		const streamOnce = vi.fn(
			async (_messages: unknown[], onDelta: (delta: string) => Promise<void>) => {
				call++;
				await onDelta(`chunk-${call}`);
				return {
					role: 'assistant' as const,
					content: [{ type: 'text' as const, text: `chunk-${call}` }],
					stop_reason: call === 1 ? 'pause_turn' : 'end_turn',
					usage: { input_tokens: 1, output_tokens: 1 }
				};
			}
		);
		const deltas: string[] = [];
		const onDelta = vi.fn(async (delta: string) => {
			deltas.push(delta);
		});

		await continueAnthropicStream([{ role: 'user', content: 'go' }], streamOnce, onDelta);

		expect(deltas).toEqual(['chunk-1', 'chunk-2']);
	});
});
