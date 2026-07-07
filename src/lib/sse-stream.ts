/**
 * Client-side SSE byte-stream parsing for the session page's live transcript.
 *
 * The server (`src/lib/server/stream/index.ts`'s `encodeServerSentEvents`)
 * encodes events as classic `id: / event: / data: ...` frames separated by a
 * blank line. `fetch().body` delivers those bytes in arbitrary, frame-unaware
 * chunks — a single frame can straddle two `read()` calls, and a single chunk
 * can contain several frames. This module owns that reassembly so the rest of
 * the app can work with whole frames.
 */

/** A single parsed SSE frame. */
export type ParsedSseFrame = {
	id?: number;
	kind: string;
	payload: string;
};

/** Parses one already-isolated (blank-line-delimited) SSE frame. */
export function parseSseFrame(frame: string): ParsedSseFrame | null {
	const lines = frame.split('\n');
	let id: number | undefined;
	let kind = '';
	let data = '';

	for (const line of lines) {
		if (line.startsWith('id: ')) {
			id = Number(line.slice(4));
		} else if (line.startsWith('event: ')) {
			kind = line.slice(7);
		} else if (line.startsWith('data: ')) {
			data = line.slice(6);
		}
	}

	if (!kind || !data) return null;
	return { id, kind, payload: data };
}

/**
 * Reads a `ReadableStream<Uint8Array>` of `\n\n`-delimited SSE frames,
 * invoking `onFrame` with each complete raw frame as soon as its terminating
 * blank line arrives.
 *
 * A partial frame at the end of a chunk is held in an internal buffer and
 * prefixed onto the next chunk, so a frame boundary that lands mid-write is
 * never dropped, duplicated, or delivered truncated — regardless of how the
 * underlying transport chooses to slice the bytes.
 *
 * Resolves when the stream ends or `signal` aborts. Read errors propagate to
 * the caller except `AbortError`, which is swallowed as an expected
 * disconnect (the caller distinguishes "closed cleanly" from "aborted" via
 * `signal.aborted`, not via a thrown error).
 */
export async function readSseStream(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
	onFrame: (frame: string) => void
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			if (signal.aborted) break;
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const frames = buffer.split('\n\n');
			buffer = frames.pop() ?? '';

			for (const frame of frames) {
				if (frame.trim()) onFrame(frame);
			}
		}
	} catch (caught) {
		if (caught instanceof Error && caught.name !== 'AbortError') {
			throw caught;
		}
	} finally {
		reader.releaseLock();
	}
}
