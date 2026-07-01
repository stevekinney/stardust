/**
 * Tests for the approval-notification hook wired into `recordApprovalRequest`:
 * a desktop notification should fire whenever a run blocks on approval, but must
 * never be able to fail the underlying activity (see local-notifications.ts for
 * the escaping/darwin-gating unit tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_QUEUE_SANDBOX, type ToolManifestEntry } from '@src/lib/types';
import * as schema from '../lib/server/db/schema';
import { recordApprovalRequest } from './policy.activities';
import { sendUserNotification } from '../lib/server/tools/local-notifications';

let testDbDir: string;
let sqlite: Database.Database;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

vi.mock('../lib/server/db/client', () => ({
	get db() {
		return testDb;
	}
}));

vi.mock('../lib/server/tools/local-notifications', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/server/tools/local-notifications')>();
	return {
		...actual,
		sendUserNotification: vi.fn()
	};
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value: platform });
}

const tool: ToolManifestEntry = {
	name: 'shell.exec',
	description: 'Run a shell command in the current workspace.',
	inputSchema: {},
	metadata: {
		risk: 'high',
		requiresApproval: true,
		taskQueue: TASK_QUEUE_SANDBOX,
		timeoutMs: 30_000,
		retry: { maximumAttempts: 1 },
		idempotencyBehavior: 'unsafe'
	}
};

function approvalRequestInput(approvalId: string) {
	return {
		approvalId,
		sessionId: 'session-001',
		runId: 'run-001',
		toolCall: { id: `${approvalId}-call`, name: tool.name, arguments: {} },
		tool,
		policyVersion: '2026-06-26',
		proposedArguments: {},
		expiresAt: '2026-06-27T00:00:00.000Z',
		createdAt: '2026-06-26T00:00:00.000Z'
	};
}

beforeEach(() => {
	testDbDir = mkdtempSync(join(tmpdir(), 'stardust-policy-activities-'));
	sqlite = new Database(join(testDbDir, 'test.db'));
	sqlite.pragma('journal_mode = WAL');
	testDb = drizzle(sqlite, { schema });
	migrate(testDb, { migrationsFolder: './drizzle' });
	vi.mocked(sendUserNotification).mockReset().mockResolvedValue({ sentAt: 'irrelevant' });
});

afterEach(() => {
	setPlatform(originalPlatform);
	sqlite?.close();
	rmSync(testDbDir, { recursive: true, force: true });
});

describe('recordApprovalRequest notification hook', () => {
	it('fires a desktop notification naming the waiting tool on macOS', async () => {
		setPlatform('darwin');

		const approval = await recordApprovalRequest(approvalRequestInput('approval-notify-001'));

		expect(approval.status).toBe('pending');
		expect(sendUserNotification).toHaveBeenCalledTimes(1);
		expect(sendUserNotification).toHaveBeenCalledWith({
			title: 'Stardust needs approval',
			message: 'shell.exec is waiting for your approval'
		});
	});

	it('does not fire a notification on non-macOS platforms', async () => {
		setPlatform('linux');

		const approval = await recordApprovalRequest(approvalRequestInput('approval-notify-002'));

		expect(approval.status).toBe('pending');
		expect(sendUserNotification).not.toHaveBeenCalled();
	});

	it('still resolves the approval when the notification runner throws', async () => {
		setPlatform('darwin');
		vi.mocked(sendUserNotification).mockRejectedValue(new Error('osascript is not installed'));

		const approval = await recordApprovalRequest(approvalRequestInput('approval-notify-003'));

		expect(approval.status).toBe('pending');
		expect(sendUserNotification).toHaveBeenCalledTimes(1);
	});

	it('does not re-notify when a retry replays an already-recorded approvalId', async () => {
		setPlatform('darwin');
		const input = approvalRequestInput('approval-notify-004');

		const first = await recordApprovalRequest(input);
		const second = await recordApprovalRequest(input);

		expect(first).toEqual(second);
		expect(sendUserNotification).toHaveBeenCalledTimes(1);
	});
});
