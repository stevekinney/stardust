import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DatabaseClient } from '../db/client';
import { runs, streamEvents, transcriptEvents } from '../db/schema';

type StreamEventInsert = typeof streamEvents.$inferInsert;
type StreamEventSelect = typeof streamEvents.$inferSelect;
type TranscriptEventInsert = typeof transcriptEvents.$inferInsert;
type TranscriptEventSelect = typeof transcriptEvents.$inferSelect;

export type PublishStreamEventInput = Pick<
	StreamEventInsert,
	'runId' | 'sessionId' | 'kind' | 'payload'
> & {
	createdAt?: string;
};

export type AppendTranscriptEventInput = Pick<
	TranscriptEventInsert,
	'id' | 'runId' | 'sessionId' | 'kind' | 'payload'
> & {
	createdAt?: string;
};

export type StreamReplay = {
	events: StreamEventSelect[];
	gapDetected: boolean;
};

/**
 * Inserts a stream event and assigns the next per-run monotonic sequence number
 * atomically inside a SQLite transaction. The transaction's exclusive write lock
 * prevents concurrent inserts from claiming the same sequence for the same run,
 * and the UNIQUE(run_id, sequence) index enforces this at the database level.
 *
 * Inside the synchronous transaction callback, `.get()` is used instead of
 * `await` because better-sqlite3 transactions run synchronously.
 */
export async function publishStreamEvent(
	database: DatabaseClient,
	input: PublishStreamEventInput
): Promise<StreamEventSelect> {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const row = database.transaction((tx) => {
		const last = tx
			.select({ sequence: streamEvents.sequence })
			.from(streamEvents)
			.where(eq(streamEvents.runId, input.runId))
			.orderBy(desc(streamEvents.sequence))
			.limit(1)
			.get();
		const sequence = (last?.sequence ?? 0) + 1;
		const inserted = tx
			.insert(streamEvents)
			.values({
				runId: input.runId,
				sessionId: input.sessionId,
				kind: input.kind,
				payload: input.payload,
				sequence,
				createdAt
			})
			.returning()
			.get();
		return inserted;
	});
	// The transaction always inserts one row and returns it; the non-null assertion
	// is safe here.
	return row!;
}

/**
 * Coalesces an array of token-delta chunks into a single assistant.delta stream
 * event. Returns null when chunks is empty so callers can skip the insert.
 */
export async function publishAssistantDeltas(
	database: DatabaseClient,
	input: Omit<PublishStreamEventInput, 'kind' | 'payload'> & { chunks: string[] }
): Promise<StreamEventSelect | null> {
	const text = input.chunks.join('');
	if (!text) return null;
	return publishStreamEvent(database, {
		runId: input.runId,
		sessionId: input.sessionId,
		createdAt: input.createdAt,
		kind: 'assistant.delta',
		payload: JSON.stringify({ text })
	});
}

/**
 * Reads stream events for a run after a given cursor ID, ordered by autoincrement
 * ID. Detects gaps using two checks:
 * - Leading edge: the first returned event's per-run sequence is not immediately
 *   after `afterSequence`. Requires `afterSequence > 0` to be meaningful; when
 *   omitted or zero the check is skipped. Using per-run sequence (not global id)
 *   avoids false positives from concurrent inserts by other runs.
 * - Interior: any consecutive pair of returned events has non-contiguous sequences.
 *
 * Either condition sets gapDetected=true so the client can request a full replay
 * from the canonical transcript.
 */
export async function readStreamEventsAfterCursor(
	database: DatabaseClient,
	input: { runId: string; afterId?: number; afterSequence?: number; limit?: number }
): Promise<StreamReplay> {
	const afterId = input.afterId ?? 0;
	const afterSequence = input.afterSequence ?? 0;
	const events = await database
		.select()
		.from(streamEvents)
		.where(and(eq(streamEvents.runId, input.runId), gt(streamEvents.id, afterId)))
		.orderBy(asc(streamEvents.id))
		.limit(input.limit ?? 100);

	const hasLeadingGap =
		events.length > 0 && afterSequence > 0 && events[0].sequence !== afterSequence + 1;
	const hasInteriorGap = events.some(
		(event, index) => index > 0 && event.sequence !== events[index - 1].sequence + 1
	);

	return {
		events,
		gapDetected: hasLeadingGap || hasInteriorGap
	};
}

/**
 * Inserts a canonical transcript event and assigns the next per-run monotonic
 * sequence number atomically inside a SQLite transaction.
 *
 * Inside the synchronous transaction callback, `.get()` is used instead of
 * `await` because better-sqlite3 transactions run synchronously.
 */
export async function appendTranscriptEvent(
	database: DatabaseClient,
	input: AppendTranscriptEventInput
): Promise<TranscriptEventSelect> {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const row = database.transaction((tx) => {
		const last = tx
			.select({ sequence: transcriptEvents.sequence })
			.from(transcriptEvents)
			.where(eq(transcriptEvents.runId, input.runId))
			.orderBy(desc(transcriptEvents.sequence))
			.limit(1)
			.get();
		const sequence = (last?.sequence ?? 0) + 1;
		const inserted = tx
			.insert(transcriptEvents)
			.values({
				id: input.id,
				runId: input.runId,
				sessionId: input.sessionId,
				kind: input.kind,
				payload: input.payload,
				sequence,
				createdAt
			})
			.returning()
			.get();
		return inserted;
	});
	// The transaction always inserts one row and returns it; the non-null assertion
	// is safe here.
	return row!;
}

export async function reconstructSessionTranscript(
	database: DatabaseClient,
	sessionId: string
): Promise<TranscriptEventSelect[]> {
	return database
		.select()
		.from(transcriptEvents)
		.where(eq(transcriptEvents.sessionId, sessionId))
		.orderBy(asc(transcriptEvents.createdAt), asc(transcriptEvents.sequence));
}

export async function trimCompletedRunStream(
	database: DatabaseClient,
	runId: string
): Promise<number> {
	const runRows = await database.select().from(runs).where(eq(runs.id, runId)).limit(1);
	const run = runRows[0];
	if (!run) throw new Error(`Cannot trim stream for unknown run: ${runId}`);
	if (run.status !== 'complete') throw new Error(`Cannot trim stream for incomplete run: ${runId}`);

	const runEvents = await database
		.select({ id: streamEvents.id })
		.from(streamEvents)
		.where(eq(streamEvents.runId, runId));

	if (runEvents.length === 0) return 0;

	const maxId = Math.max(...runEvents.map((event) => event.id));
	await database
		.delete(streamEvents)
		.where(and(eq(streamEvents.runId, runId), lte(streamEvents.id, maxId)));
	return runEvents.length;
}

/**
 * Persists a tool-execution result to both the canonical transcript and the
 * live stream bus so the context builder can reconstruct it on the next model
 * call and the UI can render the tool result card.
 */
export async function persistToolResult(
	database: DatabaseClient,
	input: {
		sessionId: string;
		runId: string;
		callId: string;
		content: unknown;
		isError?: boolean;
	}
): Promise<void> {
	const now = new Date().toISOString();
	const id = `${input.runId}:tool-result:${randomUUID()}`;
	const resultPayload = JSON.stringify({
		callId: input.callId,
		content: input.content,
		isError: input.isError ?? false
	});
	await appendTranscriptEvent(database, {
		id,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'tool_result',
		payload: resultPayload,
		createdAt: now
	});
	await publishStreamEvent(database, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'tool.result',
		payload: resultPayload,
		createdAt: now
	});
}

export function encodeServerSentEvents(replay: StreamReplay): string {
	const lines = replay.events.flatMap((event) => [
		`id: ${event.id}`,
		`event: ${event.kind}`,
		`data: ${event.payload}`,
		''
	]);

	if (replay.gapDetected) {
		lines.unshift('event: stream.gap', 'data: {"gapDetected":true}', '');
	}

	return `${lines.join('\n')}\n`;
}
