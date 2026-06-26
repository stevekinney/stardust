import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { DATABASE_URL } from '../../src/lib/server/config';

function resolveDbPath(url: string): string {
	const raw = url.startsWith('file:') ? url.slice(5) : url;
	return raw.startsWith('~') ? resolve(process.env.HOME ?? '', raw.slice(2)) : resolve(raw);
}

const dbPath = resolveDbPath(DATABASE_URL);
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');

const db = drizzle(sqlite);
migrate(db, { migrationsFolder: './drizzle' });

sqlite.close();
