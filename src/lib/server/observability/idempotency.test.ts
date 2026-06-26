import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolExecutionResult } from '@src/lib/types';
import * as schema from '../db/schema';
import { executeWithIdempotency } from './idempotency';

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;
let testDbDirectory: string;

beforeEach(() => {
	testDbDirectory = mkdtempSync(join(tmpdir(), 'stardust-idempotency-'));
	sqlite = new Database(join(testDbDirectory, 'test.db'));
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
});

afterEach(() => {
	sqlite?.close();
	rmSync(testDbDirectory, { recursive: true, force: true });
});

describe('executeWithIdempotency', () => {
	it('does not run the side effect twice when the same key is retried', async () => {
		let sideEffectCount = 0;
		const execute = async (): Promise<ToolExecutionResult> => {
			sideEffectCount++;
			return {
				callId: 'tool-call-001',
				toolName: 'workspace.writeFile',
				outcome: 'success',
				content: { writes: sideEffectCount }
			};
		};

		const first = await executeWithIdempotency({
			database,
			idempotencyKey: 'run-001:tool-call-001',
			runId: 'run-001',
			toolCallId: 'tool-call-001',
			execute
		});
		const second = await executeWithIdempotency({
			database,
			idempotencyKey: 'run-001:tool-call-001',
			runId: 'run-001',
			toolCallId: 'tool-call-001',
			execute
		});

		expect(sideEffectCount).toBe(1);
		expect(first.metadata?.idempotencyReplayed).toBe(false);
		expect(second.metadata).toMatchObject({
			idempotencyKey: 'run-001:tool-call-001',
			idempotencyReplayed: true
		});
		expect(second.content).toMatchObject({ replayed: true });
	});
});
