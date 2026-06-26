import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../../../../../../lib/server/db/schema';
import { publishStreamEvent } from '../../../../../../lib/server/stream';
import { GET } from './+server';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t3-stream-route-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../../../../../../lib/server/db', () => ({
	get db() {
		return database;
	}
}));

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('stream route', () => {
	it('returns server-sent events after the requested cursor', async () => {
		const first = await publishStreamEvent(database, {
			runId: 'route-run-001',
			sessionId: 'route-session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'started' })
		});
		await publishStreamEvent(database, {
			runId: 'route-run-001',
			sessionId: 'route-session-001',
			kind: 'assistant.message',
			payload: JSON.stringify({ text: 'ready' })
		});

		const response = await GET({
			params: { sessionKey: 'route-session-001', runId: 'route-run-001' },
			request: new Request(`http://localhost/api/sessions/route-session-001/stream/route-run-001`),
			url: new URL(
				`http://localhost/api/sessions/route-session-001/stream/route-run-001?cursor=${first.id}`
			)
		} as Parameters<typeof GET>[0]);

		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const body = await response.text();
		expect(body).not.toContain(`id: ${first.id}`);
		expect(body).toContain('event: assistant.message');
		expect(body).toContain('data: {"text":"ready"}');
	});
});
