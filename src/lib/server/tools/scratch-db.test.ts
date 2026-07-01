import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_QUERY_TOOL } from '../policy/risk';
import { defineScratchDbTools, queryScratchDatabase } from './scratch-db';

let baseDirectory: string;

beforeEach(async () => {
	baseDirectory = await mkdtemp(join(tmpdir(), 'stardust-scratch-db-'));
});

afterEach(async () => {
	await rm(baseDirectory, { recursive: true, force: true });
});

describe('queryScratchDatabase', () => {
	it('creates a table, inserts with bound params, and selects the rows back', () => {
		const sessionKey = 'ses_7af3';

		const create = queryScratchDatabase({
			sessionKey,
			sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)',
			baseDirectory
		});
		expect(create).toMatchObject({ changes: 0 });

		const insert = queryScratchDatabase({
			sessionKey,
			sql: 'INSERT INTO notes (body) VALUES (?)',
			params: ['first note'],
			baseDirectory
		});
		expect(insert).toEqual({ changes: 1, lastInsertRowid: 1 });

		const select = queryScratchDatabase({
			sessionKey,
			sql: 'SELECT * FROM notes',
			baseDirectory
		});
		expect(select).toEqual({ rows: [{ id: 1, body: 'first note' }], truncated: false });
	});

	it('persists data across calls — the database file is per-session, not per-call', () => {
		const sessionKey = 'ses_persist';

		queryScratchDatabase({
			sessionKey,
			sql: 'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)',
			baseDirectory
		});
		queryScratchDatabase({
			sessionKey,
			sql: 'INSERT INTO kv (key, value) VALUES (?, ?)',
			params: ['color', 'blue'],
			baseDirectory
		});

		const result = queryScratchDatabase({
			sessionKey,
			sql: 'SELECT value FROM kv WHERE key = ?',
			params: ['color'],
			baseDirectory
		});

		expect(result).toEqual({ rows: [{ value: 'blue' }], truncated: false });
	});

	it('caps SELECT results at 200 rows and reports truncation', () => {
		const sessionKey = 'ses_cap';

		queryScratchDatabase({
			sessionKey,
			sql: 'CREATE TABLE numbers (n INTEGER)',
			baseDirectory
		});

		const values = Array.from({ length: 250 }, (_, index) => `(${index})`).join(',');
		queryScratchDatabase({
			sessionKey,
			sql: `INSERT INTO numbers (n) VALUES ${values}`,
			baseDirectory
		});

		const result = queryScratchDatabase({
			sessionKey,
			sql: 'SELECT * FROM numbers',
			baseDirectory
		}) as { rows: unknown[]; truncated: boolean };

		expect(result.rows).toHaveLength(200);
		expect(result.truncated).toBe(true);
	});

	it('rejects a sessionKey containing path traversal or separators', () => {
		for (const sessionKey of ['../escape', 'a/b', 'a\\b', 'ses 7af3', '']) {
			expect(() => queryScratchDatabase({ sessionKey, sql: 'SELECT 1', baseDirectory })).toThrow(
				/invalid sessionKey/
			);
		}
	});

	it('surfaces a descriptive error for multi-statement SQL instead of running only the first', () => {
		expect(() =>
			queryScratchDatabase({
				sessionKey: 'ses_multi',
				sql: 'CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER)',
				baseDirectory
			})
		).toThrow(/db\.query failed:.*more than one statement/i);
	});

	it('surfaces a descriptive error for invalid SQL', () => {
		expect(() =>
			queryScratchDatabase({
				sessionKey: 'ses_bad_sql',
				sql: 'NOT VALID SQL AT ALL',
				baseDirectory
			})
		).toThrow(/db\.query failed:/);
	});
});

describe('defineScratchDbTools', () => {
	it('exposes a single db.query tool backed by DB_QUERY_TOOL metadata', () => {
		const tools = defineScratchDbTools();

		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: 'db.query', metadata: DB_QUERY_TOOL });
	});

	it('requires non-empty sql and defaults params to an empty array', () => {
		const [tool] = defineScratchDbTools();

		const parsed = tool.schema.safeParse({ sql: 'SELECT 1' });
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect((parsed.data as { params: unknown[] }).params).toEqual([]);
		}

		expect(tool.schema.safeParse({ sql: '' }).success).toBe(false);
		expect(tool.schema.safeParse({ sql: 'SELECT 1', params: ['a', 1, true, null] }).success).toBe(
			true
		);
		expect(tool.schema.safeParse({ sql: 'SELECT 1', params: [{ nested: true }] }).success).toBe(
			false
		);
	});
});
