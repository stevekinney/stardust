import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DB_QUERY_TOOL } from '../policy/risk';
import type { RegisteredTool } from '../policy/policy-engine';
import { defineStardustTool } from './define-tool';

/** Session keys may only contain letters, digits, `.`, `_`, and `-` — no path separators. */
const SESSION_KEY_RE = /^[A-Za-z0-9._-]+$/;

/** Row cap applied to SELECT-like query results. */
const MAX_ROWS = 200;

const scratchDbQueryInput = z.object({
	sql: z.string().min(1),
	params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([])
});

export type ScratchDbParam = string | number | boolean | null;

export type ScratchDbSelectResult = { rows: Record<string, unknown>[]; truncated: boolean };
export type ScratchDbMutationResult = { changes: number; lastInsertRowid: string | number };

/**
 * Runs a single SQL statement against a per-session scratch SQLite database at
 * `~/.stardust/agent-data/<sessionKey>.db` (or under `baseDirectory` when
 * provided, mainly for tests). The database is opened and closed for this call
 * only. SELECT-like statements return rows (capped at 200, with a `truncated`
 * flag); mutating statements return `changes` and `lastInsertRowid`.
 *
 * better-sqlite3 rejects multi-statement SQL strings — that rejection is
 * surfaced as a descriptive error rather than silently running only the first
 * statement.
 */
export function queryScratchDatabase(input: {
	sessionKey: string;
	sql: string;
	params?: ScratchDbParam[];
	baseDirectory?: string;
}): ScratchDbSelectResult | ScratchDbMutationResult {
	if (!SESSION_KEY_RE.test(input.sessionKey)) {
		throw new Error(
			`db.query failed: invalid sessionKey "${input.sessionKey}" — only letters, digits, ".", "_", and "-" are allowed`
		);
	}

	const directory = input.baseDirectory ?? join(homedir(), '.stardust', 'agent-data');
	mkdirSync(directory, { recursive: true });
	const dbPath = join(directory, `${input.sessionKey}.db`);
	const params = input.params ?? [];

	const database = new Database(dbPath);
	try {
		const statement = prepareStatement(database, input.sql);
		return runStatement(statement, params);
	} finally {
		database.close();
	}
}

/** Builds the `db.query` registered tool definition. */
export function defineScratchDbTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'db.query',
			description:
				'Run a single SQL statement against a private, persistent SQLite scratch database ' +
				'dedicated to this session. Create tables, accumulate data across runs, and query it ' +
				'back later.',
			schema: scratchDbQueryInput,
			metadata: DB_QUERY_TOOL
		})
	];
}

function prepareStatement(database: Database.Database, sql: string): Database.Statement {
	try {
		return database.prepare(sql);
	} catch (error) {
		throw new Error(`db.query failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error
		});
	}
}

function runStatement(
	statement: Database.Statement,
	params: ScratchDbParam[]
): ScratchDbSelectResult | ScratchDbMutationResult {
	try {
		if (statement.reader) {
			const rows = statement.all(...params) as Record<string, unknown>[];
			return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
		}
		const result = statement.run(...params);
		return { changes: result.changes, lastInsertRowid: normalizeRowid(result.lastInsertRowid) };
	} catch (error) {
		throw new Error(`db.query failed: ${error instanceof Error ? error.message : String(error)}`, {
			cause: error
		});
	}
}

function normalizeRowid(value: number | bigint): string | number {
	if (typeof value !== 'bigint') return value;
	return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
		? Number(value)
		: value.toString();
}
