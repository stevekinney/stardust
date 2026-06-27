import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../../lib/server/db';
import { runs } from '../../../../../../lib/server/db/schema';
import {
	encodeServerSentEvents,
	readStreamEventsAfterCursor
} from '../../../../../../lib/server/stream';
import type { RequestHandler } from './$types';

/** Terminal run statuses — once reached, the stream closes after a final drain. */
const TERMINAL_STATUSES = new Set(['complete', 'failed', 'cancelled']);

/** How often (ms) the tail loop polls for new stream events. */
const POLL_INTERVAL_MS = 50;

function readCursor(request: Request, url: URL): number {
	const rawCursor = url.searchParams.get('cursor') ?? request.headers.get('last-event-id') ?? '0';
	const cursor = Number(rawCursor);
	return Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

/**
 * Returns true when the event is a terminal lifecycle event — one whose payload
 * carries a status in TERMINAL_STATUSES. Used to detect whether the subscriber
 * has received the run-completion signal on the stream bus.
 */
function isTerminalLifecycleEvent(event: { kind: string; payload: string }): boolean {
	if (event.kind !== 'lifecycle') return false;
	try {
		const payload = JSON.parse(event.payload) as { status?: string };
		return typeof payload.status === 'string' && TERMINAL_STATUSES.has(payload.status);
	} catch {
		return false;
	}
}

/**
 * SSE endpoint that live-tails stream_events for the given run.
 *
 * The handler opens a ReadableStream and polls the database every ~50 ms,
 * flushing any new events as SSE frames. The stream closes when:
 * - The client disconnects (request.signal aborted), or
 * - The run reaches a terminal status (complete, failed, cancelled) and the
 *   final drain finds no more pending events.
 *
 * Clients use the `cursor` query parameter (or the SSE `Last-Event-ID` header)
 * to resume from where they left off. Events published before the cursor are
 * not replayed.
 *
 * Race-condition guard: `recordRunCompleted` publishes the `lifecycle:complete`
 * stream event and then immediately trims the stream bus. A subscriber whose
 * poll lands after the trim sees an empty final drain and would miss the terminal
 * signal. The `seenTerminalLifecycle` flag tracks whether any lifecycle event
 * with a terminal status has been forwarded to the subscriber. If the flag is
 * still false when the loop exits on terminal run status, the route synthesises
 * a recovery `lifecycle` frame from the canonical run record, ensuring the
 * subscriber always receives the terminal signal.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const { runId } = params;

	// Guard: return 404 immediately if the run does not exist. Without this
	// check, an unknown runId causes the poll loop to spin indefinitely because
	// `const [run] = await db.select(...)` resolves to `undefined` and the
	// terminal-status guard `run && TERMINAL_STATUSES.has(run.status)` is
	// permanently false.
	const [existingRun] = await db
		.select({ id: runs.id })
		.from(runs)
		.where(eq(runs.id, runId))
		.limit(1);
	if (!existingRun) throw error(404, 'Run not found');

	let cursor = readCursor(request, url);
	const signal = request.signal;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			// Tracks whether this subscriber has already received a terminal lifecycle
			// event on the stream bus. Reset per connection, not per run.
			let seenTerminalLifecycle = false;

			while (!signal.aborted) {
				// Read any new events since the cursor.
				const replay = await readStreamEventsAfterCursor(db, { runId, afterId: cursor });

				if (replay.events.length > 0) {
					if (!seenTerminalLifecycle) {
						seenTerminalLifecycle = replay.events.some(isTerminalLifecycleEvent);
					}
					controller.enqueue(encoder.encode(encodeServerSentEvents(replay)));
					cursor = replay.events[replay.events.length - 1].id;
				}

				// Check whether the run has reached a terminal state.
				const [run] = await db
					.select({ status: runs.status })
					.from(runs)
					.where(eq(runs.id, runId))
					.limit(1);

				if (run && TERMINAL_STATUSES.has(run.status)) {
					// Final drain: one more read to capture any events written between the
					// last poll and the status check, preventing loss of the final event
					// (e.g. the lifecycle:complete event) when trim and status update race.
					const finalReplay = await readStreamEventsAfterCursor(db, {
						runId,
						afterId: cursor
					});
					if (finalReplay.events.length > 0) {
						if (!seenTerminalLifecycle) {
							seenTerminalLifecycle = finalReplay.events.some(isTerminalLifecycleEvent);
						}
						controller.enqueue(encoder.encode(encodeServerSentEvents(finalReplay)));
					}

					// If the terminal lifecycle event was never received via the stream bus
					// (published by recordRunCompleted then immediately trimmed before the
					// subscriber's poll landed), reconstruct it from the canonical run record
					// so the subscriber always receives a terminal signal.
					if (!seenTerminalLifecycle) {
						const recoveryPayload = JSON.stringify({ status: run.status });
						controller.enqueue(encoder.encode(`event: lifecycle\ndata: ${recoveryPayload}\n\n`));
					}

					break;
				}

				// Yield to the event loop before the next poll.
				await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
