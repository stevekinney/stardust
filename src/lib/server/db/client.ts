import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { DATABASE_URL, resolveLocalPath } from '../config';
import * as schema from './schema';
import { loadSqliteVecExtension } from './sqlite-vec';

function resolveMigrationsFolder(): string {
	let dir = resolve('drizzle');
	if (existsSync(dir)) return dir;
	dir = resolve(import.meta.dirname ?? '.', '../../../drizzle');
	if (existsSync(dir)) return dir;
	return resolve('drizzle');
}

function createClient() {
	const dbPath = resolveLocalPath(DATABASE_URL);
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	loadSqliteVecExtension(sqlite);

	const db = drizzle(sqlite, { schema });

	try {
		migrate(db, { migrationsFolder: resolveMigrationsFolder() });
	} catch (error) {
		console.warn('Auto-migration skipped:', (error as Error).message);
	}

	return db;
}

export type DatabaseClient = ReturnType<typeof createClient>;

export const db = createClient();
