import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../lib/server/db/schema';
import { publishStreamEvent, readStreamEventsAfterCursor } from '../lib/server/stream';
import { recordRunCompleted } from './observability.activities';

const TEST_DB_DIR = join(tmpdir(), 'stardust-observability-activities-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../lib/server/db/client', () => ({
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

	// Seed sessions and runs used across tests.
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('obs-session', 'obs-session', 'active', 'agent-session:obs-session');

	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('run-to-trim', 'obs-session', 'agent-run:run-to-trim', 'complete');

	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('run-failed', 'obs-session', 'agent-run:run-failed', 'failed');
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('recordRunCompleted', () => {
	it('trims stream events after a run completes successfully', async () => {
		// Seed stream events for the run that will be completed.
		await publishStreamEvent(database, {
			runId: 'run-to-trim',
			sessionId: 'obs-session',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		await publishStreamEvent(database, {
			runId: 'run-to-trim',
			sessionId: 'obs-session',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'done' })
		});

		await recordRunCompleted({
			sessionId: 'obs-session',
			runId: 'run-to-trim',
			status: 'complete',
			finalAnswer: 'done'
		});

		// After completion with status 'complete', stream events must be trimmed.
		const remaining = await readStreamEventsAfterCursor(database, { runId: 'run-to-trim' });
		expect(remaining.events).toHaveLength(0);
	});

	it('does NOT trim stream events when a run fails', async () => {
		// Seed stream events for the failed run.
		await publishStreamEvent(database, {
			runId: 'run-failed',
			sessionId: 'obs-session',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});

		await recordRunCompleted({
			sessionId: 'obs-session',
			runId: 'run-failed',
			status: 'failed',
			finalAnswer: ''
		});

		// Failed runs should retain stream events (canonical state may be needed for debugging).
		const remaining = await readStreamEventsAfterCursor(database, { runId: 'run-failed' });
		expect(remaining.events.length).toBeGreaterThan(0);
	});
});
