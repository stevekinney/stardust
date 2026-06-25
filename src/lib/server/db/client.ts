import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import * as schema from './schema';

function resolveDbPath(url: string): string {
	const raw = url.startsWith('file:') ? url.slice(5) : url;
	return raw.startsWith('~') ? resolve(process.env.HOME ?? '', raw.slice(2)) : resolve(raw);
}

function createClient() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');

	const dbPath = resolveDbPath(url);
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');

	return drizzle(sqlite, { schema });
}

export type DatabaseClient = ReturnType<typeof createClient>;

export const db = createClient();
