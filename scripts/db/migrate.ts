import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

function resolveDbPath(url: string): string {
	const raw = url.startsWith('file:') ? url.slice(5) : url;
	return raw.startsWith('~') ? resolve(process.env.HOME ?? '', raw.slice(2)) : resolve(raw);
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const dbPath = resolveDbPath(url);
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');

const db = drizzle(sqlite);
migrate(db, { migrationsFolder: './drizzle' });

sqlite.close();
