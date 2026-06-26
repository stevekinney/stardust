import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../db/schema';
import { appendTranscriptEvent } from '../stream';
import { buildTemporalWebWorkflowUrl, readRunInspectorProjection } from './projection';

const TEST_DB_DIR = join(tmpdir(), 'stardust-observability-test');
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
			`INSERT INTO runs (id, session_id, workflow_id, status, started_at) VALUES (?, ?, ?, ?, ?)`
		)
		.run('run-001', 'session-001', 'agent-run:run-001', 'complete', '2026-06-26T00:00:00.000Z');
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('run inspector projection', () => {
	it('builds Temporal Web deep links for local workflow history', () => {
		expect(
			buildTemporalWebWorkflowUrl({
				workflowId: 'agent-run:run-001',
				namespace: 'default'
			})
		).toBe('http://localhost:8233/namespaces/default/workflows/agent-run%3Arun-001/history');
	});

	it('rehydrates a run inspector from SQLite transcript and ledger rows', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'recover after refresh' }),
			createdAt: '2026-06-26T00:00:01.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'complete', recoverySafe: true }),
			createdAt: '2026-06-26T00:00:02.000Z'
		});
		sqlite
			.prepare(
				`INSERT INTO idempotency_ledger (id, idempotency_key, run_id, tool_call_id, status, result_ref) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run('ledger-001', 'run-001:write-once', 'run-001', 'tool-call-001', 'complete', '{}');

		const projection = await readRunInspectorProjection(database, 'run-001');

		expect(projection?.run.workflowId).toBe('agent-run:run-001');
		expect(projection?.temporalWebUrl).toContain('localhost:8233');
		expect(projection?.transcript.map((event) => event.kind)).toEqual([
			'user_message',
			'lifecycle'
		]);
		expect(projection?.transcript[0].payload).toEqual({ text: 'recover after refresh' });
		expect(projection?.actionMeter.breakdown.transcriptEvents).toBe(2);
		expect(projection?.actionMeter.breakdown.idempotencyEntries).toBe(1);
		expect(projection?.actionMeter.total).toBe(3);
		expect(projection?.recoveryMarkers).toEqual([
			JSON.stringify({ status: 'complete', recoverySafe: true })
		]);
	});
});
