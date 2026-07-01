import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../src/lib/server/db/schema';
import type { DatabaseClient } from '../../src/lib/server/db';
import { appendTranscriptEvent, publishStreamEvent } from '../../src/lib/server/stream';
import { readRunInspectorProjection } from '../../src/lib/server/observability/projection';
import {
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX
} from '../../src/lib/server/temporal/task-queues';

type DemoMode = 'seed' | 'approval' | 'schedule' | 'crash' | 'smoke';

type DemoSeedResult = {
	sessionKey: string;
	runId: string;
	scheduleId?: string;
};

const mode = parseMode(process.argv[2]);

process.env.STARDUST_SKIP_TEMPORAL_HISTORY = '1';

if (mode === 'crash') {
	await runCrashDemo();
} else if (mode === 'smoke') {
	await withTemporaryDatabase(async (database) => {
		const result = await seedDemo(database, 'schedule');
		const projection = await readRunInspectorProjection(database, result.runId);
		if (!projection) throw new Error('Demo smoke projection was not created');
		if (projection.temporalConcepts.length === 0) {
			throw new Error('Demo smoke projection did not include Temporal concepts');
		}
		if (projection.durabilityEvidence.latestTranscriptSequence == null) {
			throw new Error('Demo smoke projection did not include transcript durability evidence');
		}
		if (projection.scheduleRunLinkage.length === 0) {
			throw new Error('Demo smoke projection did not include schedule linkage');
		}
		console.log(`STARDUST_DEMO_SMOKE_OK ${result.sessionKey}`);
	});
} else {
	const { db } = await import('../../src/lib/server/db/client');
	const result = await seedDemo(db, mode);
	if (mode === 'approval') {
		console.log(`STARDUST_DEMO_APPROVAL_OK ${result.sessionKey} ${result.runId}`);
		console.log(`APP_URL http://localhost:5173/sessions/${encodeURIComponent(result.sessionKey)}`);
		console.log('NO_SIDE_EFFECT_OCCURRED true');
	} else if (mode === 'schedule') {
		console.log(
			`STARDUST_DEMO_SCHEDULE_OK ${result.scheduleId ?? 'schedule-not-created'} ${result.sessionKey} ${result.runId}`
		);
	} else {
		console.log(`STARDUST_DEMO_SEED_OK ${result.sessionKey}`);
	}
}

function parseMode(value: string | undefined): DemoMode {
	if (
		value === 'seed' ||
		value === 'approval' ||
		value === 'schedule' ||
		value === 'crash' ||
		value === 'smoke'
	) {
		return value;
	}
	return 'seed';
}

async function withTemporaryDatabase(callback: (database: DatabaseClient) => Promise<void>) {
	const directory = mkdtempSync(join(tmpdir(), 'stardust-demo-smoke-'));
	const sqlitePath = join(directory, 'demo.db');
	const sqlite = new Database(sqlitePath);
	try {
		sqlite.pragma('journal_mode = WAL');
		const database = drizzle(sqlite, { schema }) as DatabaseClient;
		migrate(database, { migrationsFolder: './drizzle' });
		await callback(database);
	} finally {
		sqlite.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function seedDemo(
	database: DatabaseClient,
	variant: 'seed' | 'approval' | 'schedule'
): Promise<DemoSeedResult> {
	const suffix = `${variant}-${Date.now().toString(36)}`;
	const sessionKey = `demo-${suffix}`;
	const runId = `run-${suffix}`;
	const now = new Date().toISOString();
	const workflowId = `agent-run:${runId}`;
	const runStatus = variant === 'approval' ? 'waiting_approval' : 'complete';
	const sessionName = {
		seed: 'Demonstrate Temporal durability',
		approval: 'Approve a shell command',
		schedule: 'Recurring durability check'
	}[variant];

	await database.insert(schema.sessions).values({
		id: sessionKey,
		sessionKey,
		status: 'active',
		workflowId: `agent-session:${sessionKey}`,
		name: sessionName,
		createdAt: now,
		updatedAt: now
	});
	await database.insert(schema.runs).values({
		id: runId,
		sessionId: sessionKey,
		workflowId,
		status: runStatus,
		model: 'demo-model',
		input: JSON.stringify({ message: 'Demonstrate Temporal durability in Stardust.' }),
		finalAnswer:
			variant === 'approval'
				? null
				: 'The run completed from durable transcript and workflow evidence.',
		usage:
			variant === 'approval'
				? null
				: JSON.stringify({ inputTokens: 120, outputTokens: 60, estimatedCostUsd: 0.01 }),
		budget: JSON.stringify({
			maxModelCalls: 4,
			maxToolCalls: 4,
			maxChildWorkflows: 3,
			maxTokens: 10_000,
			maxActions: 8,
			maxActiveWallClockMs: 300_000,
			maxEstimatedCostUsd: 1
		}),
		startedAt: now,
		completedAt: variant === 'approval' ? null : now,
		createdAt: now,
		updatedAt: now
	});
	await database.insert(schema.workflowExecutions).values({
		id: `${runId}:workflow`,
		workflowId,
		temporalRunId: `temporal-${suffix}`,
		workflowType: 'AgentRunWorkflow',
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		sessionId: sessionKey,
		runId,
		status: variant === 'approval' ? 'running' : 'completed',
		startedAt: now,
		closedAt: variant === 'approval' ? null : now,
		historyLength: variant === 'approval' ? 18 : 42,
		createdAt: now,
		updatedAt: now
	});

	await appendTranscriptEvent(database, {
		id: `${runId}:user-message`,
		sessionId: sessionKey,
		runId,
		kind: 'user_message',
		payload: JSON.stringify({ text: 'Demonstrate Temporal durability in Stardust.' }),
		createdAt: now
	});
	await appendTranscriptEvent(database, {
		id: `${runId}:started`,
		sessionId: sessionKey,
		runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: 'started', recoverySafe: true }),
		createdAt: now
	});
	await appendTranscriptEvent(database, {
		id: `${runId}:tool-call`,
		sessionId: sessionKey,
		runId,
		kind: 'tool_call',
		payload: JSON.stringify({
			calls: [{ id: `${runId}:call-1`, name: 'shell.exec', input: { command: 'echo demo' } }]
		}),
		createdAt: now
	});

	if (variant === 'approval') {
		await database.insert(schema.approvalRequests).values({
			id: `${runId}:approval`,
			sessionId: sessionKey,
			runId,
			toolCallId: `${runId}:call-1`,
			toolName: 'shell.exec',
			status: 'pending',
			proposedArgs: JSON.stringify({ command: 'echo demo' }),
			argsHash: 'demo-approval-hash',
			policyVersion: 'demo-policy',
			expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
			createdAt: now,
			updatedAt: now
		});
		await publishStreamEvent(database, {
			sessionId: sessionKey,
			runId,
			kind: 'approval.request',
			payload: JSON.stringify({ id: `${runId}:approval`, toolName: 'shell.exec' }),
			deduplicationKey: 'demo:approval-request',
			createdAt: now
		});
		return { sessionKey, runId };
	}

	await database.insert(schema.toolInvocations).values({
		id: `${runId}:tool`,
		sessionId: sessionKey,
		runId,
		toolCallId: `${runId}:call-1`,
		toolName: 'shell.exec',
		args: JSON.stringify({ command: 'echo demo' }),
		argsHash: 'demo-tool-hash',
		idempotencyKey: `${runId}:tool`,
		status: 'complete',
		resultInline: JSON.stringify({ stdout: 'demo\n' }),
		risk: 'medium',
		taskQueue: TASK_QUEUE_SANDBOX,
		startedAt: now,
		completedAt: now,
		createdAt: now
	});
	await database.insert(schema.sandboxes).values({
		id: `${runId}:sandbox`,
		sessionId: sessionKey,
		name: `sd-${sessionKey}`,
		provider: 'local-subprocess',
		workspacePath: `/tmp/${sessionKey}`,
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	await database.insert(schema.sandboxCommands).values({
		id: `${runId}:command`,
		sandboxId: `${runId}:sandbox`,
		sessionId: sessionKey,
		runId,
		toolCallId: `${runId}:call-1`,
		command: 'echo',
		args: JSON.stringify(['demo']),
		background: false,
		status: 'complete',
		exitCode: 0,
		startedAt: now,
		completedAt: now,
		createdAt: now
	});
	await database.insert(schema.idempotencyLedger).values({
		id: `${runId}:ledger`,
		idempotencyKey: `${runId}:tool`,
		runId,
		toolCallId: `${runId}:call-1`,
		status: 'complete',
		resultRef: JSON.stringify({ replayable: true }),
		createdAt: now,
		completedAt: now
	});
	await appendTranscriptEvent(database, {
		id: `${runId}:tool-result`,
		sessionId: sessionKey,
		runId,
		kind: 'tool_result',
		payload: JSON.stringify({ callId: `${runId}:call-1`, content: 'demo', isError: false }),
		createdAt: now
	});
	await appendTranscriptEvent(database, {
		id: `${runId}:assistant-message`,
		sessionId: sessionKey,
		runId,
		kind: 'assistant_message',
		payload: JSON.stringify({ text: 'The run completed from durable evidence.' }),
		createdAt: now
	});
	await publishStreamEvent(database, {
		sessionId: sessionKey,
		runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: 'completed' }),
		deduplicationKey: 'demo:completed',
		createdAt: now
	});

	if (variant === 'schedule') {
		const scheduleId = `schedule-${suffix}`;
		await database.insert(schema.schedules).values({
			id: scheduleId,
			temporalScheduleId: scheduleId,
			targetSessionKey: sessionKey,
			name: 'Demo recurring agent',
			description: 'Deterministic schedule evidence for the Temporal teaching demo.',
			cronExpression: '0 9 * * 1',
			prompt: 'Run the deterministic Stardust schedule demo.',
			status: 'active',
			lastRunAt: now,
			nextRunAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
			createdAt: now,
			updatedAt: now
		});
		await database.insert(schema.scheduleFireEvents).values({
			id: `${scheduleId}:fire`,
			scheduleId,
			triggerSource: 'demo',
			actualTriggerTime: now,
			overlapPolicy: 'BUFFER_ONE',
			scheduledWorkflowId: `scheduled-agent:${scheduleId}`,
			scheduledTemporalRunId: `scheduled-temporal-${suffix}`,
			targetSessionKey: sessionKey,
			acceptedRunId: runId,
			status: 'accepted',
			createdAt: now,
			updatedAt: now
		});
		return { sessionKey, runId, scheduleId };
	}

	return { sessionKey, runId };
}

async function runCrashDemo(): Promise<void> {
	console.log('STARDUST_DEMO_CRASH_PHASE starting existing chaos flow');
	await new Promise<void>((resolve, reject) => {
		const child = spawn('bun', ['run', 'chaos'], {
			stdio: 'inherit',
			env: process.env
		});
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				console.log('STARDUST_DEMO_CRASH_OK');
				resolve();
			} else {
				reject(new Error(`chaos exited with code ${code ?? 'unknown'}`));
			}
		});
	});
}
