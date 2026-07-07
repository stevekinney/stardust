import { describe, expect, it } from 'vitest';
import { parseSseFrame, readSseStream } from './sse-stream';
import { buildConversation, type StreamEvent } from './stream-to-conversation';

/** Encodes one durable stream event as an SSE frame, mirroring encodeServerSentEvents. */
function encodeFrame(id: number, kind: string, payload: Record<string, unknown>): string {
	return `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Builds a ReadableStream<Uint8Array> that emits the given raw string chunks
 * verbatim — this is what lets tests simulate arbitrary, frame-unaware byte
 * slicing from the network.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index >= chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index]));
			index++;
		}
	});
}

describe('parseSseFrame', () => {
	it('parses id, event, and data lines', () => {
		const parsed = parseSseFrame('id: 5\nevent: assistant.delta\ndata: {"text":"hi"}');
		expect(parsed).toEqual({ id: 5, kind: 'assistant.delta', payload: '{"text":"hi"}' });
	});

	it('returns null when event or data is missing', () => {
		expect(parseSseFrame('id: 5\nevent: assistant.delta')).toBeNull();
		expect(parseSseFrame('id: 5\ndata: {}')).toBeNull();
	});
});

describe('readSseStream', () => {
	it('delivers every frame from a single chunk containing multiple frames', async () => {
		const chunk =
			encodeFrame(1, 'assistant.delta', { text: 'a' }) +
			encodeFrame(2, 'assistant.delta', { text: 'b' }) +
			encodeFrame(3, 'assistant.delta', { text: 'c' });
		const frames: string[] = [];
		await readSseStream(streamFromChunks([chunk]), new AbortController().signal, (frame) =>
			frames.push(frame)
		);
		expect(frames).toHaveLength(3);
		expect(frames.map((f) => parseSseFrame(f)?.payload)).toEqual([
			'{"text":"a"}',
			'{"text":"b"}',
			'{"text":"c"}'
		]);
	});

	it('reconstructs a single frame split arbitrarily across many small chunks', async () => {
		const full = encodeFrame(1, 'assistant.delta', { text: 'hello world' });
		// Split byte-by-byte (as characters) to simulate the worst-case network slicing.
		const chunks = full.split('');
		const frames: string[] = [];
		await readSseStream(streamFromChunks(chunks), new AbortController().signal, (frame) =>
			frames.push(frame)
		);
		expect(frames).toHaveLength(1);
		expect(parseSseFrame(frames[0])).toEqual({
			id: 1,
			kind: 'assistant.delta',
			payload: '{"text":"hello world"}'
		});
	});

	it('reconstructs frames whose boundary lands mid-frame across exactly two chunks', async () => {
		const frameA = encodeFrame(1, 'assistant.delta', { text: 'first' });
		const frameB = encodeFrame(2, 'assistant.delta', { text: 'second' });
		const combined = frameA + frameB;
		// Split partway through frameB's "event:" line — a realistic TCP-segment cut point.
		const splitPoint = frameA.length + 10;
		const chunks = [combined.slice(0, splitPoint), combined.slice(splitPoint)];

		const frames: string[] = [];
		await readSseStream(streamFromChunks(chunks), new AbortController().signal, (frame) =>
			frames.push(frame)
		);
		expect(frames.map((f) => parseSseFrame(f))).toEqual([
			{ id: 1, kind: 'assistant.delta', payload: '{"text":"first"}' },
			{ id: 2, kind: 'assistant.delta', payload: '{"text":"second"}' }
		]);
	});

	it('stops reading once the abort signal fires, without throwing', async () => {
		const controller = new AbortController();
		const frames: string[] = [];
		const chunk = encodeFrame(1, 'assistant.delta', { text: 'a' });
		controller.abort();
		await expect(
			readSseStream(streamFromChunks([chunk]), controller.signal, (frame) => frames.push(frame))
		).resolves.toBeUndefined();
		expect(frames).toHaveLength(0);
	});
});

describe('streaming reconciliation', () => {
	it('reassembles a multi-chunk delta stream into text identical to the fully-assembled persisted transcript', async () => {
		// Simulate the server streaming an assistant reply as many small deltas,
		// arbitrarily sliced across network chunks (including mid-frame cuts).
		const deltaWords = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy dog.'];
		let sequence = 1;
		const rawFrames = deltaWords.map((word) =>
			encodeFrame(sequence++, 'assistant.delta', { text: word })
		);
		const fullStreamBytes = rawFrames.join('');

		// Slice into arbitrary, frame-unaware chunks (every 7 characters).
		const chunkSize = 7;
		const chunks: string[] = [];
		for (let i = 0; i < fullStreamBytes.length; i += chunkSize) {
			chunks.push(fullStreamBytes.slice(i, i + chunkSize));
		}

		const events: StreamEvent[] = [];
		await readSseStream(streamFromChunks(chunks), new AbortController().signal, (frame) => {
			const parsed = parseSseFrame(frame);
			if (parsed) events.push({ ...parsed, id: parsed.id ?? events.length });
		});

		// No frame was dropped or duplicated in transit.
		expect(events).toHaveLength(deltaWords.length);

		const liveConversation = buildConversation('session-1', null, events);
		const liveAssistantMessages = liveConversation.ids
			.map((id) => liveConversation.messages[id])
			.filter((m) => m.role === 'assistant');

		// Exactly one accumulated assistant message — deltas fold into a single
		// bubble, they don't fan out into separate duplicate messages.
		expect(liveAssistantMessages).toHaveLength(1);
		const fullyAssembledText = deltaWords.join('');
		expect(liveAssistantMessages[0].content).toBe(fullyAssembledText);

		// The durable transcript (what the server persists and /transcript
		// returns) stores the completed reply as a single assistant_message
		// event, not the individual deltas. Rebuilding from that canonical
		// source must produce byte-identical text to the live-streamed view.
		const canonicalEvents: StreamEvent[] = [
			{ id: 0, kind: 'assistant.message', payload: JSON.stringify({ text: fullyAssembledText }) }
		];
		const canonicalConversation = buildConversation('session-1', null, canonicalEvents);
		const canonicalAssistantMessages = canonicalConversation.ids
			.map((id) => canonicalConversation.messages[id])
			.filter((m) => m.role === 'assistant');
		expect(canonicalAssistantMessages).toHaveLength(1);
		expect(canonicalAssistantMessages[0].content).toBe(liveAssistantMessages[0].content);
	});
});

describe('stream interrupt and reconnect reconciliation', () => {
	it('discards a partial in-flight message and reconciles to the durable transcript with no duplication or loss', async () => {
		// First connection: the stream dies mid-message (network drop, worker
		// restart, etc.) after only some deltas have arrived — no terminal
		// lifecycle event, the ReadableStream just ends.
		const deadConnectionFrames =
			encodeFrame(1, 'user.message', { text: 'Summarize the incident.' }) +
			encodeFrame(2, 'assistant.delta', { text: 'Investigating the ' }) +
			encodeFrame(3, 'assistant.delta', { text: 'root cause' });
		// Cut mid-frame to simulate a connection that dies mid-write.
		const truncated = deadConnectionFrames.slice(0, deadConnectionFrames.length - 5);

		const partialEvents: StreamEvent[] = [];
		await readSseStream(streamFromChunks([truncated]), new AbortController().signal, (frame) => {
			const parsed = parseSseFrame(frame);
			if (parsed) partialEvents.push({ ...parsed, id: parsed.id ?? partialEvents.length });
		});

		const partialConversation = buildConversation('session-1', null, partialEvents);
		const partialAssistant = partialConversation.ids
			.map((id) => partialConversation.messages[id])
			.find((m) => m.role === 'assistant');
		// Sanity check on the simulated failure: some partial text landed before
		// the connection died.
		expect(partialAssistant?.content).toBe('Investigating the ');

		// Reconnect: the client fetches the durable transcript from scratch
		// (loadTranscript in the session page) rather than resuming the dead
		// connection's accumulator. The durable transcript holds the run's
		// *actual* final state — here, the run completed with a different final
		// answer than what the dead connection had streamed so far.
		const durableTranscript: StreamEvent[] = [
			{ id: 0, kind: 'user.message', payload: JSON.stringify({ text: 'Summarize the incident.' }) },
			{
				id: 1,
				kind: 'assistant.message',
				payload: JSON.stringify({ text: 'Root cause identified: a stale cache entry.' })
			}
		];
		const reconciled = buildConversation('session-1', null, durableTranscript);
		const assistantMessages = reconciled.ids
			.map((id) => reconciled.messages[id])
			.filter((m) => m.role === 'assistant');

		// Exactly one assistant message survives reconciliation — the durable,
		// complete one. No trace of the dead connection's partial text, and no
		// duplicate assistant bubble from the two connections.
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].content).toBe('Root cause identified: a stale cache entry.');
		expect(assistantMessages[0].content).not.toContain('Investigating');
	});
});
