import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../../../../../../lib/server/db/schema';
import { publishStreamEvent } from '../../../../../../lib/server/stream';
import { GET } from './+server';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t3-stream-route-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../../../../../../lib/server/db', () => ({
	get db() {
		return database;
	}
}));

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });

	// Seed session and runs used across tests.
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('route-session-001', 'route-session-001', 'active', 'agent-session:route-session-001');

	// A completed run — the SSE tail must close after sending buffered events.
	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('route-run-complete', 'route-session-001', 'agent-run:route-run-complete', 'complete');

	// A running run — flipped to complete during the live-tail test.
	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('route-run-live', 'route-session-001', 'agent-run:route-run-live', 'running');

	// A completed run with no stream events — simulates a run whose stream bus was
	// trimmed by recordRunCompleted before the SSE subscriber could read it.
	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('route-run-trim-race', 'route-session-001', 'agent-run:route-run-trim-race', 'complete');
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('stream route', () => {
	it('returns server-sent events after the requested cursor and closes when run is complete', async () => {
		// Publish two events for a completed run.
		const first = await publishStreamEvent(database, {
			runId: 'route-run-complete',
			sessionId: 'route-session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		await publishStreamEvent(database, {
			runId: 'route-run-complete',
			sessionId: 'route-session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'ready' })
		});

		// Because the run is already 'complete', the stream must close naturally.
		const response = await GET({
			params: { sessionKey: 'route-session-001', runId: 'route-run-complete' },
			request: new Request(
				`http://localhost/api/sessions/route-session-001/stream/route-run-complete`
			),
			url: new URL(
				`http://localhost/api/sessions/route-session-001/stream/route-run-complete?cursor=${first.id}`
			)
		} as Parameters<typeof GET>[0]);

		expect(response.headers.get('content-type')).toContain('text/event-stream');

		// response.text() resolves only when the stream closes — it must not hang.
		const body = await response.text();
		expect(body).not.toContain(`id: ${first.id}`);
		expect(body).toContain('event: assistant.message');
		expect(body).toContain('data: {"text":"ready"}');
	});

	it('delivers events published after the stream opens (live tail)', async () => {
		// Publish an initial event before the stream opens.
		const first = await publishStreamEvent(database, {
			runId: 'route-run-live',
			sessionId: 'route-session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});

		// Open the stream with a cursor pointing past the initial event.
		const response = await GET({
			params: { sessionKey: 'route-session-001', runId: 'route-run-live' },
			request: new Request(`http://localhost/api/sessions/route-session-001/stream/route-run-live`),
			url: new URL(
				`http://localhost/api/sessions/route-session-001/stream/route-run-live?cursor=${first.id}`
			)
		} as Parameters<typeof GET>[0]);

		expect(response.headers.get('content-type')).toContain('text/event-stream');

		// Publish a new event while the stream is polling, then flip the run to
		// 'complete' so the tail loop exits naturally.
		await publishStreamEvent(database, {
			runId: 'route-run-live',
			sessionId: 'route-session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'live delivery' })
		});
		sqlite.prepare(`UPDATE runs SET status = 'complete' WHERE id = ?`).run('route-run-live');

		// Drain the stream incrementally via the reader.
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let body = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			body += decoder.decode(value, { stream: true });
		}

		// The live-published event must arrive before the stream closes.
		expect(body).toContain('event: assistant.message');
		expect(body).toContain('data: {"text":"live delivery"}');
	});

	it('delivers the terminal lifecycle event even when stream events were trimmed before the poll landed', async () => {
		// This is the trim-race regression test.
		//
		// Scenario: recordRunCompleted publishes lifecycle:complete to the stream bus then
		// immediately calls trimCompletedRunStream, which deletes every row for the run.
		// A live SSE subscriber whose poll lands after the trim sees an empty stream even
		// though the run is terminal. Without the recovery path, the subscriber closes
		// without receiving any terminal signal.
		//
		// The run `route-run-trim-race` is already seeded as 'complete' with zero stream
		// events — identical to the post-trim state. Opening a fresh SSE connection with
		// cursor=0 must still produce a lifecycle:complete frame from the canonical run
		// record.
		const response = await GET({
			params: { sessionKey: 'route-session-001', runId: 'route-run-trim-race' },
			request: new Request(
				`http://localhost/api/sessions/route-session-001/stream/route-run-trim-race`
			),
			url: new URL(`http://localhost/api/sessions/route-session-001/stream/route-run-trim-race`)
		} as Parameters<typeof GET>[0]);

		expect(response.headers.get('content-type')).toContain('text/event-stream');

		// response.text() must resolve (stream must close) and must contain the recovery
		// lifecycle frame synthesised from the canonical run record.
		const body = await response.text();
		expect(body).toContain('event: lifecycle');
		expect(body).toContain('data: {"status":"complete"}');
	});
});
