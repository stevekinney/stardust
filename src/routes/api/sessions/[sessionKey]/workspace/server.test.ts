/**
 * Unit tests for GET /api/sessions/[sessionKey]/workspace.
 *
 * The critical regression: the handler must map `stdoutRef`/`stderrRef` DB
 * columns to `stdout`/`stderr` in the WorkspaceCommand shape. Before the fix,
 * these fields were silently dropped, so commands appeared to have no output
 * even when the subprocess captured output into the DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './+server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Terminal methods in the Drizzle query chain used by this route:
//   select().from().where().limit()   → sessions, sandboxes (one at a time)
//   select().from().where().orderBy() → commands, snapshots, artifacts, tool invocations (Promise.all)
const mockLimit = vi.fn();
const mockOrderBy = vi.fn();

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: mockLimit,
					orderBy: mockOrderBy
				})
			})
		})
	}
}));

// Schema table references are passed as arguments to the mocked chain but are
// never executed — no additional mock needed.
vi.mock('$lib/server/db/schema', () => ({
	sessions: {},
	sandboxes: {},
	sandboxCommands: { createdAt: null },
	sandboxSnapshots: { createdAt: null },
	artifacts: { createdAt: null },
	toolInvocations: { createdAt: null }
}));

// drizzle-orm helpers used inside the handler — they just need to be callable.
vi.mock('drizzle-orm', () => ({
	eq: () => undefined
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sessionRow = {
	id: 'session-001',
	sessionKey: 'test-session',
	name: 'Test Session'
};

const sandboxRow = {
	id: 'sandbox-001',
	sessionId: 'session-001'
};

const baseCommandRow: {
	id: string;
	command: string;
	args: string;
	status: string;
	exitCode: number;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	sandboxId: string;
	stdoutRef: string | null;
	stderrRef: string | null;
} = {
	id: 'cmd-001',
	command: 'bun',
	args: JSON.stringify(['run', 'build']),
	status: 'complete',
	exitCode: 0,
	startedAt: null,
	completedAt: null,
	createdAt: '2026-06-26T00:00:00.000Z',
	sandboxId: 'sandbox-001',
	stdoutRef: null,
	stderrRef: null
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(sessionKey: string): Parameters<typeof GET>[0] {
	return {
		params: { sessionKey },
		url: new URL(`http://localhost/api/sessions/${sessionKey}/workspace`),
		request: new Request(`http://localhost/api/sessions/${sessionKey}/workspace`)
	} as Parameters<typeof GET>[0];
}

/**
 * Prime the mock sequence for one successful request.
 *
 * Call order matches the handler:
 *   1. session  → limit (returns one row)
 *   2. sandbox  → limit (returns one row)
 *   3. commands → orderBy  (Promise.all, first)
 *   4. snapshots → orderBy (Promise.all, second)
 *   5. artifacts → orderBy (Promise.all, third)
 *   6. tool invocations → orderBy (Promise.all, fourth)
 */
function primeDb(
	commandRows: (typeof baseCommandRow)[] = [],
	toolRows: Array<Record<string, unknown>> = []
) {
	mockLimit.mockResolvedValueOnce([sessionRow]); // session
	mockLimit.mockResolvedValueOnce([sandboxRow]); // sandbox
	mockOrderBy.mockResolvedValueOnce(commandRows); // commands
	mockOrderBy.mockResolvedValueOnce([]); // snapshots
	mockOrderBy.mockResolvedValueOnce([]); // artifacts
	mockOrderBy.mockResolvedValueOnce(toolRows); // tool invocations
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/sessions/[sessionKey]/workspace', () => {
	beforeEach(() => {
		mockLimit.mockReset();
		mockOrderBy.mockReset();
	});

	it('maps stdoutRef to stdout in the WorkspaceCommand response', async () => {
		const commandRow = { ...baseCommandRow, stdoutRef: 'Build succeeded\n3 files written' };
		primeDb([commandRow]);

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.commands).toHaveLength(1);
		expect(body.commands[0].stdout).toBe('Build succeeded\n3 files written');
	});

	it('maps stderrRef to stderr in the WorkspaceCommand response', async () => {
		const commandRow = {
			...baseCommandRow,
			status: 'failed',
			exitCode: 1,
			stderrRef: 'error: module not found'
		};
		primeDb([commandRow]);

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.commands[0].stderr).toBe('error: module not found');
	});

	it('maps null stdoutRef and stderrRef to null stdout/stderr', async () => {
		primeDb([baseCommandRow]);

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(body.commands[0].stdout).toBeNull();
		expect(body.commands[0].stderr).toBeNull();
	});

	it('maps undefined stdoutRef to null stdout via nullish coalescing', async () => {
		// Simulate a DB row where the column is absent (undefined) rather than NULL.
		const commandRow = { ...baseCommandRow };
		// @ts-expect-error — intentionally removing column to test the ?? null guard
		delete commandRow.stdoutRef;
		// @ts-expect-error — intentionally removing column to test the ?? null guard
		delete commandRow.stderrRef;
		primeDb([commandRow]);

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(body.commands[0].stdout).toBeNull();
		expect(body.commands[0].stderr).toBeNull();
	});

	it('projects persisted workspace.diff tool results as workspace diffs', async () => {
		primeDb(
			[],
			[
				{
					id: 'tool-001',
					toolName: 'workspace.diff',
					resultInline: JSON.stringify({
						base: 'abc123',
						head: 'working-tree',
						path: 'src/example.ts',
						patch: 'diff --git a/src/example.ts b/src/example.ts\n+export const value = 1;\n'
					}),
					completedAt: '2026-06-26T00:01:00.000Z',
					createdAt: '2026-06-26T00:00:59.000Z'
				}
			]
		);

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.diffs).toEqual([
			expect.objectContaining({
				fromSnapshotId: 'abc123',
				toSnapshotId: 'working-tree',
				fileName: 'src/example.ts',
				patch: expect.stringContaining('+export const value = 1;')
			})
		]);
	});

	it('returns 400 for an invalid sessionKey', async () => {
		await expect(GET(makeRequest('../../etc/passwd'))).rejects.toMatchObject({ status: 400 });
	});

	it('returns 404 when the session does not exist', async () => {
		mockLimit.mockResolvedValueOnce([]); // session not found

		await expect(GET(makeRequest('missing-session'))).rejects.toMatchObject({ status: 404 });
	});

	it('returns empty workspace when no sandbox is provisioned', async () => {
		mockLimit.mockResolvedValueOnce([sessionRow]); // session found
		mockLimit.mockResolvedValueOnce([]); // no sandbox

		const response = await GET(makeRequest('test-session'));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.commands).toEqual([]);
		expect(body.snapshots).toEqual([]);
	});
});
