import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../lib/server/db/schema';
import {
	publishStreamEvent,
	readStreamEventsAfterCursor,
	reconstructSessionTranscript
} from '../lib/server/stream';
import { recordRunCompleted, recordRunStarted } from './observability.activities';

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

	it('persists usage totals when provided', async () => {
		sqlite
			.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
			.run('run-usage', 'obs-session', 'agent-run:run-usage', 'running');

		await recordRunCompleted({
			sessionId: 'obs-session',
			runId: 'run-usage',
			status: 'complete',
			finalAnswer: 'done',
			usage: { inputTokens: 150, outputTokens: 50, estimatedCostUsd: 0.003 }
		});

		const row = sqlite.prepare('SELECT usage FROM runs WHERE id = ?').get('run-usage') as {
			usage: string;
		};
		expect(JSON.parse(row.usage)).toEqual({
			inputTokens: 150,
			outputTokens: 50,
			estimatedCostUsd: 0.003
		});
	});

	it('is idempotent for canonical transcript and stream lifecycle completion events', async () => {
		sqlite
			.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
			.run(
				'run-complete-idempotent',
				'obs-session',
				'agent-run:run-complete-idempotent',
				'running'
			);

		const input = {
			sessionId: 'obs-session',
			runId: 'run-complete-idempotent',
			status: 'failed' as const,
			finalAnswer: 'failed',
			reason: 'planned retry failure'
		};

		await recordRunCompleted(input);
		await recordRunCompleted(input);

		const transcript = await reconstructSessionTranscript(database, 'obs-session');
		expect(
			transcript.filter((event) => event.id === 'run-complete-idempotent:assistant-message')
		).toHaveLength(1);
		expect(
			transcript.filter((event) => event.id === 'run-complete-idempotent:completed')
		).toHaveLength(1);
		const replay = await readStreamEventsAfterCursor(database, {
			runId: 'run-complete-idempotent'
		});
		expect(
			replay.events.filter((event) => event.deduplicationKey === 'lifecycle:completed')
		).toHaveLength(1);
	});
});

describe('recordRunStarted', () => {
	it('persists model and budget when provided', async () => {
		// recordRunStarted creates the session row (idempotent) and the run row.
		// Use a fresh session + run to avoid collisions.
		sqlite
			.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
			.run('obs-session-b', 'obs-session-b', 'active', 'agent-session:obs-session-b');

		await recordRunStarted({
			sessionId: 'obs-session-b',
			runId: 'run-started-model',
			message: 'hello',
			model: 'claude-sonnet-4-5-20250929',
			budget: {
				maxModelCalls: 10,
				maxToolCalls: 20,
				maxChildWorkflows: 3,
				maxTokens: 100_000,
				maxActions: 30,
				maxActiveWallClockMs: 600_000,
				maxEstimatedCostUsd: 1.0
			}
		});

		const row = sqlite
			.prepare('SELECT model, budget FROM runs WHERE id = ?')
			.get('run-started-model') as { model: string; budget: string };

		expect(row.model).toBe('claude-sonnet-4-5-20250929');
		const budget = JSON.parse(row.budget);
		expect(budget.maxModelCalls).toBe(10);
		expect(budget.maxEstimatedCostUsd).toBe(1.0);
	});

	it('creates a run row even without model or budget (backwards-compatible)', async () => {
		sqlite
			.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
			.run('obs-session-c', 'obs-session-c', 'active', 'agent-session:obs-session-c');

		await recordRunStarted({
			sessionId: 'obs-session-c',
			runId: 'run-started-minimal',
			message: 'hello'
		});

		const row = sqlite
			.prepare('SELECT id, status FROM runs WHERE id = ?')
			.get('run-started-minimal') as { id: string; status: string };
		expect(row.id).toBe('run-started-minimal');
		expect(row.status).toBe('running');
	});

	it('is idempotent for canonical transcript and stream lifecycle start events', async () => {
		const input = {
			sessionId: 'obs-session-start-idempotent',
			runId: 'run-started-idempotent',
			message: 'hello'
		};

		await recordRunStarted(input);
		await recordRunStarted(input);

		const transcript = await reconstructSessionTranscript(database, 'obs-session-start-idempotent');
		expect(
			transcript.filter((event) => event.id === 'run-started-idempotent:user-message')
		).toHaveLength(1);
		expect(
			transcript.filter((event) => event.id === 'run-started-idempotent:started')
		).toHaveLength(1);
		const replay = await readStreamEventsAfterCursor(database, { runId: 'run-started-idempotent' });
		expect(
			replay.events.filter((event) => event.deduplicationKey === 'lifecycle:started')
		).toHaveLength(1);
	});
});
