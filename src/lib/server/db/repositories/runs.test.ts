import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as schema from '../schema';
import { RunsRepository } from './runs';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t1-runs-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let runs: RunsRepository;

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: './drizzle' });
	runs = new RunsRepository(db);

	// seed a parent session (FK pragma is OFF by default so this isn't strictly required,
	// but it keeps the data honest)
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('session-001', 'session-001', 'active', 'agent-session:session-001');
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('RunsRepository', () => {
	it('inserts a run and reads it back by id', async () => {
		const id = await runs.insert({
			id: 'run-001',
			sessionId: 'session-001',
			workflowId: 'agent-run:session-001:run-001',
			status: 'pending',
			model: 'claude-sonnet-4-6'
		});

		const found = await runs.findById(id);
		expect(found).not.toBeNull();
		expect(found!.id).toBe('run-001');
		expect(found!.sessionId).toBe('session-001');
		expect(found!.status).toBe('pending');
		expect(found!.model).toBe('claude-sonnet-4-6');
	});

	it('finds runs by session id', async () => {
		await runs.insert({
			id: 'run-002',
			sessionId: 'session-001',
			workflowId: 'agent-run:session-001:run-002',
			status: 'complete',
			model: 'claude-sonnet-4-6'
		});

		const found = await runs.findBySessionId('session-001');
		expect(found.length).toBeGreaterThanOrEqual(2);
		expect(found.map((r) => r.id)).toContain('run-001');
		expect(found.map((r) => r.id)).toContain('run-002');
	});

	it('returns null for a missing id', async () => {
		const result = await runs.findById('not-a-real-id');
		expect(result).toBeNull();
	});
});
