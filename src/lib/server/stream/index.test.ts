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

	it('replays stream events after a cursor and detects gaps', async () => {
		const first = await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'done' })
		});

		const replay = await readStreamEventsAfterCursor(database, {
			runId: 'run-complete',
			afterId: first.id
		});

		expect(replay.gapDetected).toBe(false);
		expect(replay.events).toHaveLength(1);

		sqlite.prepare(`DELETE FROM stream_events WHERE id = ?`).run(first.id + 1);
		const later = await publishStreamEvent(database, {
			runId: 'run-complete',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'complete' })
		});

		const gapReplay = await readStreamEventsAfterCursor(database, {
			runId: 'run-complete',
			afterId: first.id
		});
		expect(later.id).toBeGreaterThan(first.id + 1);
		expect(gapReplay.gapDetected).toBe(true);
		expect(encodeServerSentEvents(gapReplay)).toContain('event: stream.gap');
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
