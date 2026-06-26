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
	sequence?: number;
	createdAt?: string;
};

export type AppendTranscriptEventInput = Pick<
	TranscriptEventInsert,
	'id' | 'runId' | 'sessionId' | 'kind' | 'payload'
> & {
	sequence?: number;
	createdAt?: string;
};

export type StreamReplay = {
	events: StreamEventSelect[];
	gapDetected: boolean;
};

async function nextStreamSequence(database: DatabaseClient, runId: string): Promise<number> {
	const rows = await database
		.select({ sequence: streamEvents.sequence })
		.from(streamEvents)
		.where(eq(streamEvents.runId, runId))
		.orderBy(desc(streamEvents.sequence))
		.limit(1);
	return (rows[0]?.sequence ?? 0) + 1;
}

async function nextTranscriptSequence(database: DatabaseClient, runId: string): Promise<number> {
	const rows = await database
		.select({ sequence: transcriptEvents.sequence })
		.from(transcriptEvents)
		.where(eq(transcriptEvents.runId, runId))
		.orderBy(desc(transcriptEvents.sequence))
		.limit(1);
	return (rows[0]?.sequence ?? 0) + 1;
}

export async function publishStreamEvent(
	database: DatabaseClient,
	input: PublishStreamEventInput
): Promise<StreamEventSelect> {
	const sequence = input.sequence ?? (await nextStreamSequence(database, input.runId));
	const createdAt = input.createdAt ?? new Date().toISOString();
	const rows = await database
		.insert(streamEvents)
		.values({ ...input, sequence, createdAt })
		.returning();
	return rows[0];
}

export async function publishAssistantDeltas(
	database: DatabaseClient,
	input: Omit<PublishStreamEventInput, 'kind' | 'payload'> & { chunks: string[] }
): Promise<StreamEventSelect | null> {
	const text = input.chunks.join('');
	if (!text) return null;
	return publishStreamEvent(database, {
		runId: input.runId,
		sessionId: input.sessionId,
		sequence: input.sequence,
		createdAt: input.createdAt,
		kind: 'assistant.delta',
		payload: JSON.stringify({ text })
	});
}

export async function readStreamEventsAfterCursor(
	database: DatabaseClient,
	input: { runId: string; afterId?: number; limit?: number }
): Promise<StreamReplay> {
	const afterId = input.afterId ?? 0;
	const events = await database
		.select()
		.from(streamEvents)
		.where(and(eq(streamEvents.runId, input.runId), gt(streamEvents.id, afterId)))
		.orderBy(asc(streamEvents.id))
		.limit(input.limit ?? 100);

	return {
		events,
		gapDetected: events.length > 0 && afterId > 0 && events[0].id !== afterId + 1
	};
}

export async function appendTranscriptEvent(
	database: DatabaseClient,
	input: AppendTranscriptEventInput
): Promise<TranscriptEventSelect> {
	const sequence = input.sequence ?? (await nextTranscriptSequence(database, input.runId));
	const createdAt = input.createdAt ?? new Date().toISOString();
	const rows = await database
		.insert(transcriptEvents)
		.values({ ...input, sequence, createdAt })
		.returning();
	return rows[0];
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
