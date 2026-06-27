import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../db/schema';
import {
	appendTranscriptEvent,
	encodeServerSentEvents,
	publishAssistantDeltas,
	publishStreamEvent,
	readStreamEventsAfterCursor,
	reconstructSessionTranscript,
	trimCompletedRunStream
} from '.';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t3-stream-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('session-001', 'session-001', 'active', 'agent-session:session-001');
	sqlite
		.prepare(
			`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
		)
		.run(
			'run-001',
			'session-001',
			'agent-run:run-001',
			'running',
			'run-complete',
			'session-001',
			'agent-run:run-complete',
			'complete'
		);
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('stream events', () => {
	it('publishes stream events with per-run monotonic sequence numbers', async () => {
		const first = await publishStreamEvent(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		const second = await publishStreamEvent(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'hello' })
		});

		expect(first.sequence).toBe(1);
		expect(second.sequence).toBe(2);
		expect(second.id).toBeGreaterThan(first.id);
	});

	it('rejects a duplicate (run_id, sequence) pair — UNIQUE constraint is enforced', () => {
		// The migration must have created the index for this to throw.
		expect(() => {
			sqlite
				.prepare(
					`INSERT INTO stream_events (run_id, session_id, sequence, kind, payload, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.run('run-001', 'session-001', 1, 'lifecycle', '{}', new Date().toISOString());
		}).toThrow(/UNIQUE constraint failed/);
	});

	it('replays stream events after a cursor and detects leading-edge gaps', async () => {
		// Publish two contiguous events for run-complete.
		const first = await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		const second = await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'done' })
		});

		// Reading after first with afterSequence correctly set must not detect a gap.
		const replay = await readStreamEventsAfterCursor(database, {
			runId: 'run-complete',
			afterId: first.id,
			afterSequence: first.sequence
		});

		expect(replay.gapDetected).toBe(false);
		expect(replay.events).toHaveLength(1);
		expect(replay.events[0].id).toBe(second.id);

		// Simulate a missing event by inserting via raw SQL with a sequence that skips
		// ahead by 2, creating a genuine per-run sequence gap (sequence N+1 is absent).
		// Deleting an event and re-inserting cannot reliably test this because
		// publishStreamEvent recycles the sequence of the deleted row.
		sqlite
			.prepare(
				`INSERT INTO stream_events (run_id, session_id, sequence, kind, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(
				'run-complete',
				'session-001',
				second.sequence + 2,
				'lifecycle',
				JSON.stringify({ status: 'complete' }),
				new Date().toISOString()
			);

		// Reading after second with afterSequence=second.sequence must detect the leading gap.
		// The raw-inserted event has sequence second.sequence+2, skipping second.sequence+1.
		const gapReplay = await readStreamEventsAfterCursor(database, {
			runId: 'run-complete',
			afterId: second.id,
			afterSequence: second.sequence
		});
		expect(gapReplay.gapDetected).toBe(true);
		expect(encodeServerSentEvents(gapReplay)).toContain('event: stream.gap');
	});

	it('does not detect a leading-edge gap when another run advances the global id', async () => {
		// Regression: a jump in the global autoincrement id caused by a concurrent
		// run must NOT trigger a false-positive stream.gap for the target run.
		// Two run-A events, one run-B event (advances global id), a third run-A event
		// must yield gapDetected === false when afterSequence is threaded correctly.
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`
			)
			.run(
				'run-gap-a',
				'session-001',
				'agent-run:run-gap-a',
				'running',
				'run-gap-b',
				'session-001',
				'agent-run:run-gap-b',
				'running'
			);

		const a1 = await publishStreamEvent(database, {
			runId: 'run-gap-a',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		const a2 = await publishStreamEvent(database, {
			runId: 'run-gap-a',
			sessionId: 'session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'first' })
		});

		// Run-B inserts an event, advancing the global autoincrement id by one.
		await publishStreamEvent(database, {
			runId: 'run-gap-b',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});

		const a3 = await publishStreamEvent(database, {
			runId: 'run-gap-a',
			sessionId: 'session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'third' })
		});

		// The global id jumps between a2 and a3 because run-B inserted between them.
		expect(a3.id).toBeGreaterThan(a2.id + 1);
		// But the per-run sequences for run-A are contiguous (1, 2, 3).
		expect(a1.sequence).toBe(1);
		expect(a2.sequence).toBe(2);
		expect(a3.sequence).toBe(3);

		// Reading after a2 with afterSequence = a2.sequence must not report a gap.
		const replay = await readStreamEventsAfterCursor(database, {
			runId: 'run-gap-a',
			afterId: a2.id,
			afterSequence: a2.sequence
		});

		expect(replay.events).toHaveLength(1);
		expect(replay.events[0].id).toBe(a3.id);
		expect(replay.gapDetected).toBe(false);
	});

	it('detects interior gaps within a batch via per-run sequence', async () => {
		// Insert three events for a fresh run.
		const a = await publishStreamEvent(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'seq-gap-test-a' })
		});
		const b = await publishStreamEvent(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'seq-gap-test-b' })
		});
		await publishStreamEvent(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'seq-gap-test-c' })
		});

		// Delete the middle event to create an interior sequence gap.
		sqlite.prepare(`DELETE FROM stream_events WHERE id = ?`).run(b.id);

		// Reading after `a` should now return a and c — sequences a.sequence, a.sequence+2.
		const gapReplay = await readStreamEventsAfterCursor(database, {
			runId: 'run-001',
			afterId: a.id - 1
		});

		// The batch contains a (seq N) and c (seq N+2) — the gap between them must be detected.
		expect(gapReplay.gapDetected).toBe(true);
	});

	it('coalesces token deltas before publishing', async () => {
		const event = await publishAssistantDeltas(database, {
			runId: 'run-001',
			sessionId: 'session-001',
			chunks: ['hel', 'lo']
		});

		expect(event?.kind).toBe('assistant.delta');
		expect(JSON.parse(event!.payload)).toEqual({ text: 'hello' });
	});

	it('trims stream events only after a run is complete', async () => {
		await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'ready-to-trim' })
		});

		await expect(trimCompletedRunStream(database, 'run-001')).rejects.toThrow('incomplete run');
		const trimmed = await trimCompletedRunStream(database, 'run-complete');
		expect(trimmed).toBeGreaterThan(0);
		const remaining = await readStreamEventsAfterCursor(database, { runId: 'run-complete' });
		expect(remaining.events).toEqual([]);
	});
});

describe('transcript events', () => {
	it('reconstructs the canonical transcript without stream events', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'assistant_message',
			payload: JSON.stringify({ text: 'hi' }),
			createdAt: '2026-01-01T00:00:01.000Z'
		});

		await trimCompletedRunStream(database, 'run-complete');
		const transcript = await reconstructSessionTranscript(database, 'session-001');

		expect(transcript.map((event) => event.id)).toEqual(['transcript-001', 'transcript-002']);
		expect(transcript.map((event) => event.sequence)).toEqual([1, 2]);
	});
});
