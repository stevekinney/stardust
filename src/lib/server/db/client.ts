import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { DATABASE_URL } from '../config';
import * as schema from './schema';
import { loadSqliteVecExtension } from './sqlite-vec';

function resolveDbPath(url: string): string {
	const raw = url.startsWith('file:') ? url.slice(5) : url;
	return raw.startsWith('~') ? resolve(process.env.HOME ?? '', raw.slice(2)) : resolve(raw);
}

function createClient() {
	const dbPath = resolveDbPath(DATABASE_URL);
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	loadSqliteVecExtension(sqlite);

	return drizzle(sqlite, { schema });
}

export type DatabaseClient = ReturnType<typeof createClient>;

export const db = createClient();
