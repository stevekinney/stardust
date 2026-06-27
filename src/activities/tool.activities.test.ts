/**
 * Tests for the `executeTool` activity, verifying:
 *
 * 1. Tool invocation ledger rows are persisted to `tool_invocations` when a
 *    database is wired into `executeRegisteredTool`.
 * 2. Scheduled-session sandbox compatibility: a session key with the
 *    `sched-{scheduleId}` prefix satisfies the canonical session key format and
 *    produces a valid sandbox workspace (no validation exceptions from
 *    `sandboxNameForSession` or `workspacePathForSession`).
 *
 * The `executeTool` activity function itself delegates to `executeRegisteredTool`
 * with the module-level sandbox provider and DB — those singleton dependencies are
 * tested indirectly here. Direct integration of the registry + provider + DB is
 * tested through `executeRegisteredTool` in `registry.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../lib/server/db/schema';
import { executeRegisteredTool } from '../lib/server/tools/registry';
import { LocalSubprocessSandboxProvider } from '../lib/server/sandbox';
import { getScheduledSessionKey } from '../lib/server/temporal/scheduled-turn';

let testDbDir: string;
let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;
let workspaceRoot: string;
let provider: LocalSubprocessSandboxProvider;

beforeEach(() => {
	testDbDir = mkdtempSync(join(tmpdir(), 'stardust-activity-'));
	sqlite = new Database(join(testDbDir, 'test.db'));
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });

	workspaceRoot = mkdtempSync(join(tmpdir(), 'stardust-ws-'));
	provider = new LocalSubprocessSandboxProvider({ workspaceRoot, database });
});

afterEach(() => {
	sqlite?.close();
	rmSync(testDbDir, { recursive: true, force: true });
	rmSync(workspaceRoot, { recursive: true, force: true });
});

// ── Tool ledger rows ──────────────────────────────────────────────────────────

describe('tool invocation ledger', () => {
	it('writes a tool_invocations row with status=complete when a tool succeeds', async () => {
		expect.assertions(4);

		const result = await executeRegisteredTool({
			call: {
				id: 'call-ledger-001',
				name: 'web.fetch',
				arguments: { url: 'https://example.test' }
			},
			sessionId: 'sess-ledger-test',
			sessionKey: 'sess-ledger-test',
			runId: 'run-ledger-001',
			database,
			fetcher: async () =>
				new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
		});

		expect(result.outcome).toBe('success');

		const rows = sqlite
			.prepare('SELECT * FROM tool_invocations WHERE tool_call_id = ?')
			.all('call-ledger-001') as Array<{ tool_name: string; status: string; run_id: string }>;

		expect(rows).toHaveLength(1);
		expect(rows[0]?.tool_name).toBe('web.fetch');
		expect(rows[0]?.status).toBe('complete');
	});

	it('writes a tool_invocations row with status=failed when a tool throws', async () => {
		expect.assertions(3);

		// workspace.readFile with no sandboxProvider will throw inside executeAllowedTool,
		// which is caught and converted to an error outcome.
		const result = await executeRegisteredTool({
			call: { id: 'call-ledger-002', name: 'workspace.readFile', arguments: { path: 'x.txt' } },
			sessionId: 'sess-ledger-test',
			sessionKey: 'sess-ledger-test',
			runId: 'run-ledger-002',
			approved: true,
			database
			// sandboxProvider intentionally omitted — throws inside executeAllowedTool
		});

		expect(result.outcome).toBe('error');

		const rows = sqlite
			.prepare('SELECT * FROM tool_invocations WHERE tool_call_id = ?')
			.all('call-ledger-002') as Array<{ status: string }>;

		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe('failed');
	});
});

// ── Scheduled-session sandbox compatibility ───────────────────────────────────

describe('scheduled-session sandbox compatibility', () => {
	/**
	 * Schedule IDs are minted as `schedule-{randomUUID()}` so the resulting session
	 * key is `sched-schedule-{uuid}`. This satisfies the canonical session key
	 * format and therefore passes `assertValidSessionKey` inside `sandboxNameForSession`
	 * and `workspacePathForSession`.
	 */
	it('sched-prefixed session keys produce a valid sandbox workspace without validation errors', async () => {
		expect.assertions(2);

		const scheduleId = 'schedule-550e8400-e29b-41d4-a716-446655440000';
		const sessionKey = getScheduledSessionKey(scheduleId);

		// ensureWorkspace calls assertValidSessionKey internally; if the key were
		// invalid it would throw. A resolved promise proves no validation error.
		const workspacePath = await provider.ensureWorkspace(sessionKey);
		expect(workspacePath).toBeTruthy();
		expect(workspacePath).toContain(sessionKey);
	});

	it('executes a tool with a scheduled session key through the sandbox provider', async () => {
		expect.assertions(2);

		const sessionKey = getScheduledSessionKey('schedule-test-sched-compat-001');

		const result = await executeRegisteredTool({
			call: {
				id: 'call-sched-001',
				name: 'workspace.readFile',
				arguments: { path: 'nonexistent.txt' }
			},
			sessionId: sessionKey,
			sessionKey,
			runId: 'run-sched-001',
			approved: true,
			database,
			sandboxProvider: provider
		});

		// The file does not exist so the provider throws and we get an error outcome —
		// but the key format is valid and the routing reaches the provider without
		// validation failures.
		expect(result.outcome).toBe('error');
		expect(result.content).toContain('nonexistent.txt');
	});
});
