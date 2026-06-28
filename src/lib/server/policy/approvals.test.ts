import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_QUEUE_SANDBOX, TASK_QUEUE_TOOLS, type ToolManifestEntry } from '@src/lib/types';
import * as schema from '../db/schema';
import { ApprovalsRepository } from './approvals';
import { hashApprovalArguments } from './arguments-hash';

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
		retry: { maximumAttempts: 1 },
		idempotencyBehavior: 'key-required'
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

	it('toCardState reads tool metadata from the registry for a known low-risk tool', async () => {
		// web.fetch is LOW_RISK_TOOL: risk='low', taskQueue=TASK_QUEUE_TOOLS, timeoutMs=10_000
		// The bug hardcodes risk='high', taskQueue=TASK_QUEUE_SANDBOX, timeoutMs=0, description=toolName.
		const webFetchTool: ToolManifestEntry = {
			name: 'web.fetch',
			description: 'Fetch an HTTP or HTTPS URL with SSRF protection.',
			inputSchema: {},
			metadata: {
				risk: 'low',
				requiresApproval: false,
				taskQueue: TASK_QUEUE_TOOLS,
				timeoutMs: 10_000,
				retry: { maximumAttempts: 2 },
				idempotencyBehavior: 'safe'
			}
		};

		await approvals.recordRequest({
			approvalId: 'approval-low-risk',
			sessionId: 'session-001',
			runId: 'run-001',
			toolCall: { id: 'tc-low-risk', name: 'web.fetch', arguments: { url: 'https://example.com' } },
			tool: webFetchTool,
			policyVersion: '2026-06-26',
			proposedArguments: { url: 'https://example.com' },
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: '2026-06-26T00:00:00.000Z'
		});

		const card = await approvals.findById('approval-low-risk');
		expect(card).not.toBeNull();
		// Registry values must be used — not hardcoded defaults.
		expect(card!.tool.description).toBe('Fetch an HTTP or HTTPS URL with SSRF protection.');
		expect(card!.tool.metadata.risk).toBe('low');
		expect(card!.tool.metadata.taskQueue).toBe(TASK_QUEUE_TOOLS);
		expect(card!.tool.metadata.timeoutMs).toBe(10_000);
		expect(card!.tool.metadata.idempotencyBehavior).toBe('safe');
	});

	it('toCardState falls back to conservative defaults for an unrecognized tool name', async () => {
		const unknownTool: ToolManifestEntry = {
			name: 'unknown.tool',
			description: 'Some tool no longer in the registry.',
			inputSchema: {},
			metadata: {
				risk: 'high',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 5_000,
				retry: { maximumAttempts: 1 },
				idempotencyBehavior: 'key-required'
			}
		};

		await approvals.recordRequest({
			approvalId: 'approval-unknown',
			sessionId: 'session-001',
			runId: 'run-001',
			toolCall: { id: 'tc-unknown', name: 'unknown.tool', arguments: {} },
			tool: unknownTool,
			policyVersion: '2026-06-26',
			proposedArguments: {},
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: '2026-06-26T00:00:00.000Z'
		});

		const card = await approvals.findById('approval-unknown');
		expect(card).not.toBeNull();
		// Unknown tools fall back to conservative (high-risk) defaults to stay safe.
		expect(card!.tool.name).toBe('unknown.tool');
		expect(card!.tool.metadata.risk).toBe('high');
		expect(card!.tool.metadata.requiresApproval).toBe(true);
	});

	it('recordRequest sets runs.status to waiting_approval', async () => {
		const now = '2026-06-26T00:00:00.000Z';
		sqlite
			.prepare(
				'INSERT INTO runs (id, session_id, workflow_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run('run-status-test', 'session-001', 'workflow-001', 'running', now, now);

		await approvals.recordRequest({
			approvalId: 'approval-status-test',
			sessionId: 'session-001',
			runId: 'run-status-test',
			toolCall: { id: 'tc-status-test', name: tool.name, arguments: {} },
			tool,
			policyVersion: '2026-06-26',
			proposedArguments: {},
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: now
		});

		const row = sqlite.prepare('SELECT status FROM runs WHERE id = ?').get('run-status-test') as {
			status: string;
		};
		expect(row.status).toBe('waiting_approval');
	});

	it('recordResolution with approve sets runs.status back to running', async () => {
		const now = '2026-06-26T00:00:00.000Z';
		sqlite
			.prepare(
				'INSERT INTO runs (id, session_id, workflow_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run('run-approve-test', 'session-001', 'workflow-001', 'running', now, now);

		await approvals.recordRequest({
			approvalId: 'approval-approve-test',
			sessionId: 'session-001',
			runId: 'run-approve-test',
			toolCall: { id: 'tc-approve-test', name: tool.name, arguments: {} },
			tool,
			policyVersion: '2026-06-26',
			proposedArguments: {},
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: now
		});

		// Confirm runs.status is waiting_approval before resolution.
		const beforeRow = sqlite
			.prepare('SELECT status FROM runs WHERE id = ?')
			.get('run-approve-test') as { status: string };
		expect(beforeRow.status).toBe('waiting_approval');

		await approvals.recordResolution({
			approvalId: 'approval-approve-test',
			action: 'approve',
			remember: false,
			actor: 'user',
			resolvedAt: '2026-06-26T01:00:00.000Z'
		});

		const afterRow = sqlite
			.prepare('SELECT status FROM runs WHERE id = ?')
			.get('run-approve-test') as { status: string };
		expect(afterRow.status).toBe('running');
	});

	it('recordResolution with deny does not change runs.status', async () => {
		const now = '2026-06-26T00:00:00.000Z';
		sqlite
			.prepare(
				'INSERT INTO runs (id, session_id, workflow_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.run('run-deny-test', 'session-001', 'workflow-001', 'running', now, now);

		await approvals.recordRequest({
			approvalId: 'approval-deny-test',
			sessionId: 'session-001',
			runId: 'run-deny-test',
			toolCall: { id: 'tc-deny-test', name: tool.name, arguments: {} },
			tool,
			policyVersion: '2026-06-26',
			proposedArguments: {},
			expiresAt: '2026-06-27T00:00:00.000Z',
			createdAt: now
		});

		await approvals.recordResolution({
			approvalId: 'approval-deny-test',
			action: 'deny',
			remember: false,
			actor: 'user',
			resolvedAt: '2026-06-26T01:00:00.000Z'
		});

		// deny is handled by recordRunCompleted; runs.status must remain waiting_approval.
		const row = sqlite.prepare('SELECT status FROM runs WHERE id = ?').get('run-deny-test') as {
			status: string;
		};
		expect(row.status).toBe('waiting_approval');
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
