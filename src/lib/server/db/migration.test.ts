import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t1-migration-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

const REQUIRED_TABLES = [
	'sessions',
	'runs',
	'transcript_events',
	'audit_events',
	'approval_requests',
	'memory_notes',
	'tool_invocations',
	'artifacts',
	'sandboxes',
	'sandbox_snapshots',
	'sandbox_commands',
	'schedules',
	'workflow_executions',
	'schedule_fire_events',
	'stream_events',
	'idempotency_ledger'
];

const FORBIDDEN_TABLES = ['users', 'tenants', 'memberships'];
const FORBIDDEN_COLUMN = 'tenant_id';

let sqlite: Database.Database;

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	const db = drizzle(sqlite);
	migrate(db, { migrationsFolder: './drizzle' });
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('migration', () => {
	it('enables WAL journal mode', () => {
		const row = sqlite.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
		expect(row.journal_mode).toBe('wal');
	});

	it.each(REQUIRED_TABLES)('creates table: %s', (tableName) => {
		const row = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(tableName);
		expect(row).toBeTruthy();
	});

	it.each(FORBIDDEN_TABLES)('does NOT create table: %s', (tableName) => {
		const row = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
			.get(tableName);
		expect(row).toBeUndefined();
	});

	it('creates the memory_notes FTS5 virtual table', () => {
		const row = sqlite
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_notes_fts'`)
			.get();
		expect(row).toBeTruthy();
	});

	it('has no tenant_id column in any table', () => {
		const tables = sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`
			)
			.all() as { name: string }[];

		const violations: string[] = [];
		for (const { name } of tables) {
			const columns = sqlite.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
			if (columns.some((c) => c.name === FORBIDDEN_COLUMN)) {
				violations.push(name);
			}
		}
		expect(violations).toEqual([]);
	});

	it('creates FTS5 sync triggers for memory_notes', () => {
		const triggers = sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'memory_notes'`
			)
			.all() as { name: string }[];
		const names = triggers.map((t) => t.name);
		expect(names).toContain('memory_notes_ai');
		expect(names).toContain('memory_notes_au');
		expect(names).toContain('memory_notes_ad');
	});

	it('adds stream event semantic deduplication support', () => {
		const columns = sqlite.prepare(`PRAGMA table_info(stream_events)`).all() as { name: string }[];
		expect(columns.map((column) => column.name)).toContain('deduplication_key');

		const indexes = sqlite.prepare(`PRAGMA index_list(stream_events)`).all() as { name: string }[];
		expect(indexes.map((index) => index.name)).toContain(
			'stream_events_run_id_deduplication_key_unique'
		);
	});

	it('adds Temporal teaching observability tables and transcript cursors', () => {
		const sessionColumns = sqlite.prepare(`PRAGMA table_info(sessions)`).all() as {
			name: string;
		}[];
		expect(sessionColumns.map((column) => column.name)).toContain('transcript_cursor');

		const transcriptColumns = sqlite.prepare(`PRAGMA table_info(transcript_events)`).all() as {
			name: string;
		}[];
		expect(transcriptColumns.map((column) => column.name)).toContain('session_sequence');

		const transcriptIndexes = sqlite.prepare(`PRAGMA index_list(transcript_events)`).all() as {
			name: string;
		}[];
		expect(transcriptIndexes.map((index) => index.name)).toContain(
			'transcript_events_session_id_session_sequence_unique'
		);

		const workflowColumns = sqlite.prepare(`PRAGMA table_info(workflow_executions)`).all() as {
			name: string;
		}[];
		expect(workflowColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining(['workflow_id', 'temporal_run_id', 'workflow_type', 'task_queue'])
		);

		const fireColumns = sqlite.prepare(`PRAGMA table_info(schedule_fire_events)`).all() as {
			name: string;
		}[];
		expect(fireColumns.map((column) => column.name)).toEqual(
			expect.arrayContaining(['schedule_id', 'accepted_run_id', 'scheduled_workflow_id'])
		);
	});

	it('adds sandbox background process metadata columns', () => {
		const columns = sqlite.prepare(`PRAGMA table_info(sandbox_commands)`).all() as {
			name: string;
		}[];
		expect(columns.map((column) => column.name)).toEqual(
			expect.arrayContaining(['pid', 'process_group_id', 'background'])
		);
	});

	it('FTS5 mirror syncs on insert', () => {
		const id = 'fts-test-1';
		sqlite
			.prepare(`INSERT INTO memory_notes (id, session_id, kind, content) VALUES (?, ?, ?, ?)`)
			.run(id, 'session-fts-test', 'durable', 'the quick brown fox');
		const rows = sqlite
			.prepare(`SELECT id FROM memory_notes_fts WHERE memory_notes_fts MATCH 'quick'`)
			.all() as { id: string }[];
		expect(rows.some((r) => r.id === id)).toBe(true);
		// clean up
		sqlite.prepare(`DELETE FROM memory_notes WHERE id = ?`).run(id);
	});
});
