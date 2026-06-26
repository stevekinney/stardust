import type Database from 'better-sqlite3';
import { load as loadSqliteVec } from 'sqlite-vec';

export function loadSqliteVecExtension(sqlite: Database.Database): boolean {
	try {
		loadSqliteVec(sqlite);
		return true;
	} catch (error) {
		console.warn(
			'sqlite-vec extension unavailable; vector memory will use lexical fallback.',
			error
		);
		return false;
	}
}
