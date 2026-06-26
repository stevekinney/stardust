import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_QUEUE_SANDBOX, type ToolManifestEntry } from '@src/lib/types';
import * as schema from '../db/schema';
import { ApprovalsRepository, hashApprovalArguments } from './approvals';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t8-approvals-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

const tool: ToolManifestEntry = {
	name: 'workspace.writeFile',
	description: 'Write a file.',
	inputSchema: {},
	metadata: {
		risk: 'medium',
		requiresApproval: true,
		taskQueue: TASK_QUEUE_SANDBOX,
		timeoutMs: 15_000,
		retry: { maximumAttempts: 1 }
	}
};

let sqlite: Database.Database;
let approvals: ApprovalsRepository;

beforeEach(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	approvals = new ApprovalsRepository(database);
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('ApprovalsRepository', () => {
	it('persists approval request audit, transcript, and stream projection rows', async () => {
		const proposedArguments = { path: 'notes.txt', content: 'draft' };

		const request = await approvals.recordRequest({
			approvalId: 'approval-001',
			sessionId: 'session-001',
			runId: 'run-001',
			toolCall: { id: 'tool-call-001', name: tool.name, arguments: proposedArguments },
			tool,
			policyVersion: '2026-06-26',
			proposedArguments,
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: '2026-06-26T00:00:00.000Z'
		});

		expect(request.status).toBe('pending');
		expect(request.argsHash).toBe(hashApprovalArguments(proposedArguments));

		const auditRows = await sqlite
			.prepare('SELECT kind, args_hash, policy_version FROM audit_events WHERE id = ?')
			.all('approval-001:request');
		expect(auditRows).toEqual([
			{
				kind: 'approval_request',
				args_hash: request.argsHash,
				policy_version: '2026-06-26'
			}
		]);

		const transcriptRows = await sqlite
			.prepare('SELECT kind FROM transcript_events WHERE id = ?')
			.all('approval-001:request');
		expect(transcriptRows).toEqual([{ kind: 'approval_request' }]);
	});

	it('makes edited arguments canonical while preserving proposed arguments', async () => {
		const proposedArguments = { path: 'notes.txt', content: 'draft' };
		const editedArguments = { path: 'notes.txt', content: 'approved text' };

		await approvals.recordRequest({
			approvalId: 'approval-002',
			sessionId: 'session-001',
			runId: 'run-001',
			toolCall: { id: 'tool-call-002', name: tool.name, arguments: proposedArguments },
			tool,
			policyVersion: '2026-06-26',
			proposedArguments,
			expiresAt: '2026-06-27T00:00:00.000Z'
		});

		const resolution = await approvals.recordResolution({
			approvalId: 'approval-002',
			action: 'approve_with_edits',
			editedArguments,
			remember: true,
			actor: 'user',
			resolvedAt: '2026-06-26T01:00:00.000Z'
		});

		expect(resolution.terminalState).toBe('approved');
		expect(resolution.proposedArguments).toEqual(proposedArguments);
		expect(resolution.editedArguments).toEqual(editedArguments);
		expect(resolution.canonicalArguments).toEqual(editedArguments);
		expect(resolution.remember).toBe(true);

		const rows = (await sqlite
			.prepare(
				'SELECT status, proposed_args, canonical_args, edited_args, remember FROM approval_requests WHERE id = ?'
			)
			.all('approval-002')) as {
			status: string;
			proposed_args: string;
			canonical_args: string;
			edited_args: string;
			remember: number;
		}[];
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('approved');
		expect(JSON.parse(rows[0].proposed_args)).toEqual(proposedArguments);
		expect(JSON.parse(rows[0].canonical_args)).toEqual(editedArguments);
		expect(JSON.parse(rows[0].edited_args)).toEqual(editedArguments);
		expect(rows[0].remember).toBe(1);

		const auditRow = (await sqlite
			.prepare('SELECT kind, edited_args FROM audit_events WHERE id = ?')
			.get('approval-002:resolution:approved')) as { kind: string; edited_args: string };
		expect(auditRow.kind).toBe('approval_resolution');
		expect(JSON.parse(auditRow.edited_args)).toEqual(editedArguments);

		const transcriptRow = (await sqlite
			.prepare('SELECT payload FROM transcript_events WHERE id = ?')
			.get('approval-002:resolution:approved')) as { payload: string };
		expect(JSON.parse(transcriptRow.payload)).toMatchObject({
			terminalState: 'approved',
			canonicalArguments: editedArguments,
			proposedArguments
		});
	});
});
