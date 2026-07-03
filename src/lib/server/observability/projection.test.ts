import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../db/schema';
import { appendTranscriptEvent, publishStreamEvent } from '../stream';
import { buildTemporalWebWorkflowUrl, queryRuns, readRunInspectorProjection } from './projection';
import { TASK_QUEUE_ORCHESTRATOR } from '../temporal/task-queues';

const TEST_DB_DIR = join(tmpdir(), 'stardust-observability-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('session-001', 'session-001', 'active', 'agent-session:session-001');
	sqlite
		.prepare(
			`INSERT INTO runs (id, session_id, workflow_id, status, started_at) VALUES (?, ?, ?, ?, ?)`
		)
		.run('run-001', 'session-001', 'agent-run:run-001', 'complete', '2026-06-26T00:00:00.000Z');
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('run inspector projection', () => {
	it('links to the workflow (latest-run redirect) when no run id is known', () => {
		expect(
			buildTemporalWebWorkflowUrl({
				workflowId: 'agent-run:run-001',
				namespace: 'default'
			})
		).toBe('http://localhost:8233/namespaces/default/workflows/agent-run%3Arun-001');
	});

	it('links to the run-specific history page when the run id is known', () => {
		// Temporal history lives at /workflows/{workflowId}/{runId}/history — the run id
		// segment is required. Omitting it lands "history" in the run-id slot on a broken page.
		expect(
			buildTemporalWebWorkflowUrl({
				workflowId: 'agent-run:run-001',
				temporalRunId: 'b3f1c2d4-5566-7788-99aa-bbccddeeff00',
				namespace: 'default'
			})
		).toBe(
			'http://localhost:8233/namespaces/default/workflows/agent-run%3Arun-001/b3f1c2d4-5566-7788-99aa-bbccddeeff00/history'
		);
	});

	it('returns undefined timelineLanes when no subagent events exist', async () => {
		const projection = await readRunInspectorProjection(database, 'run-001');
		expect(projection?.timelineLanes).toBeUndefined();
	});

	it('exposes taskQueue as the orchestrator queue for all runs', async () => {
		const projection = await readRunInspectorProjection(database, 'run-001');
		expect(projection?.taskQueue).toBe(TASK_QUEUE_ORCHESTRATOR);
	});

	it('returns Temporal teaching evidence from durable SQLite rows', async () => {
		const runId = 'run-teaching-evidence';
		const now = '2026-06-26T04:00:00.000Z';
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, started_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(runId, 'session-001', `agent-run:${runId}`, 'complete', now, now);
		sqlite
			.prepare(
				`INSERT INTO workflow_executions (id, workflow_id, temporal_run_id, workflow_type, task_queue, session_id, run_id, status, started_at, closed_at, history_length)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`${runId}:workflow`,
				`agent-run:${runId}`,
				'temporal-run-teaching',
				'AgentRunWorkflow',
				TASK_QUEUE_ORCHESTRATOR,
				'session-001',
				runId,
				'completed',
				now,
				now,
				27
			);
		sqlite
			.prepare(
				`INSERT INTO tool_invocations (id, session_id, run_id, tool_call_id, tool_name, args, args_hash, idempotency_key, status, risk, task_queue, started_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`${runId}:tool`,
				'session-001',
				runId,
				'call-teaching',
				'shell.exec',
				'{}',
				'hash',
				`${runId}:tool`,
				'complete',
				'medium',
				'tools-sandbox',
				now,
				now
			);
		sqlite
			.prepare(`INSERT INTO sandboxes (id, session_id, name, workspace_path) VALUES (?, ?, ?, ?)`)
			.run(`${runId}:sandbox`, 'session-001', `sd-${runId}`, `/tmp/${runId}`);
		sqlite
			.prepare(
				`INSERT INTO sandbox_commands (id, sandbox_id, session_id, run_id, tool_call_id, command, status, started_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`${runId}:command`,
				`${runId}:sandbox`,
				'session-001',
				runId,
				'call-teaching',
				'echo',
				'complete',
				now,
				now
			);
		sqlite
			.prepare(
				`INSERT INTO approval_requests (id, session_id, run_id, tool_call_id, tool_name, status, proposed_args, args_hash, policy_version, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`${runId}:approval`,
				'session-001',
				runId,
				'call-teaching',
				'shell.exec',
				'pending',
				'{}',
				'hash',
				'policy',
				'2026-06-26T04:30:00.000Z'
			);
		sqlite
			.prepare(
				`INSERT INTO idempotency_ledger (id, idempotency_key, run_id, tool_call_id, status, result_ref)
				VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run(`${runId}:ledger`, `${runId}:tool`, runId, 'call-teaching', 'complete', '{}');
		sqlite
			.prepare(
				`INSERT INTO memory_notes (id, session_id, kind, content, run_id, confirmed_at)
				VALUES (?, ?, ?, ?, ?, NULL)`
			)
			.run(`${runId}:memory`, 'session-001', 'durable', 'Candidate survives stream trim.', runId);
		sqlite
			.prepare(
				`INSERT INTO schedule_fire_events (id, schedule_id, trigger_source, actual_trigger_time, overlap_policy, scheduled_workflow_id, target_session_key, accepted_run_id, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				`${runId}:fire`,
				'schedule-teaching',
				'demo',
				now,
				'BUFFER_ONE',
				'scheduled-agent:schedule-teaching',
				'session-001',
				runId,
				'accepted'
			);

		await appendTranscriptEvent(database, {
			id: `${runId}:tool-call`,
			runId,
			sessionId: 'session-001',
			kind: 'tool_call',
			payload: JSON.stringify({
				calls: [{ id: 'call-teaching', name: 'shell.exec', input: { command: 'echo demo' } }]
			}),
			createdAt: now
		});
		await appendTranscriptEvent(database, {
			id: `${runId}:tool-result`,
			runId,
			sessionId: 'session-001',
			kind: 'tool_result',
			payload: JSON.stringify({ callId: 'call-teaching', content: 'demo', isError: false }),
			createdAt: now
		});

		const projection = await readRunInspectorProjection(database, runId);

		expect(projection?.run.temporalRunId).toBe('temporal-run-teaching');
		expect(projection?.taskQueues).toContain('tools-sandbox');
		expect(projection?.temporalHistorySummary.source).toBe('sqlite');
		expect(projection?.temporalHistorySummary.historyLength).toBe(27);
		expect(projection?.durabilityEvidence).toMatchObject({
			latestTranscriptSequence: 2,
			approvalWaitCount: 1,
			idempotencyReplayCount: 1,
			heartbeatBackedCommandCount: 1,
			scheduleFireCount: 1,
			memoryCandidateCount: 1
		});
		expect(projection?.activityAttempts[0]).toMatchObject({
			callId: 'call-teaching',
			heartbeatBacked: true,
			attempts: 1
		});
		expect(projection?.scheduleRunLinkage[0]?.scheduleId).toBe('schedule-teaching');
		expect(projection?.temporalConcepts.map((concept) => concept.primitive)).toEqual(
			expect.arrayContaining(['workflow', 'task-queue', 'heartbeat', 'update', 'timer', 'schedule'])
		);
	});

	it('builds timelineLanes from subagent.start and subagent.complete stream events', async () => {
		// Seed a second run to test subagent lane reconstruction.
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, started_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run('run-002', 'session-001', 'agent-run:run-002', 'complete', '2026-06-26T01:00:00.000Z');

		await publishStreamEvent(database, {
			sessionId: 'session-001',
			runId: 'run-002',
			kind: 'subagent.start',
			payload: JSON.stringify({
				subagentRunId: 'run-002:research',
				kind: 'research',
				label: 'Research',
				startedAt: '2026-06-26T01:00:01.000Z'
			}),
			createdAt: '2026-06-26T01:00:01.000Z'
		});
		await publishStreamEvent(database, {
			sessionId: 'session-001',
			runId: 'run-002',
			kind: 'subagent.complete',
			payload: JSON.stringify({
				subagentRunId: 'run-002:research',
				kind: 'research',
				label: 'Research',
				status: 'complete',
				budget: { inputTokens: 70, outputTokens: 20, estimatedCostUsd: 0.0007 },
				completedAt: '2026-06-26T01:00:05.000Z'
			}),
			createdAt: '2026-06-26T01:00:05.000Z'
		});

		const projection = await readRunInspectorProjection(database, 'run-002');

		expect(projection?.timelineLanes).toHaveLength(1);
		const parentLane = projection?.timelineLanes?.[0];
		expect(parentLane?.kind).toBe('parent');
		expect(parentLane?.children).toHaveLength(1);
		const researchLane = parentLane?.children?.[0];
		expect(researchLane?.id).toBe('run-002:research');
		expect(researchLane?.label).toBe('Research');
		expect(researchLane?.status).toBe('complete');
		expect(researchLane?.budget?.inputTokens).toBe(70);
	});

	it('rehydrates a run inspector from SQLite transcript and ledger rows', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'recover after refresh' }),
			createdAt: '2026-06-26T00:00:01.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'lifecycle',
			payload: JSON.stringify({ status: 'complete', recoverySafe: true }),
			createdAt: '2026-06-26T00:00:02.000Z'
		});
		sqlite
			.prepare(
				`INSERT INTO idempotency_ledger (id, idempotency_key, run_id, tool_call_id, status, result_ref) VALUES (?, ?, ?, ?, ?, ?)`
			)
			.run('ledger-001', 'run-001:write-once', 'run-001', 'tool-call-001', 'complete', '{}');

		const projection = await readRunInspectorProjection(database, 'run-001');

		expect(projection?.run.workflowId).toBe('agent-run:run-001');
		expect(projection?.temporalWebUrl).toContain('localhost:8233');
		expect(projection?.transcript.map((event) => event.kind)).toEqual([
			'user_message',
			'lifecycle'
		]);
		expect(projection?.transcript[0].payload).toEqual({ text: 'recover after refresh' });
		expect(projection?.actionMeter.breakdown.transcriptEvents).toBe(2);
		expect(projection?.actionMeter.breakdown.idempotencyEntries).toBe(1);
		expect(projection?.actionMeter.total).toBe(3);
		expect(projection?.recoveryMarkers).toEqual([
			JSON.stringify({ status: 'complete', recoverySafe: true })
		]);
	});

	it('exposes usage and budget from the runs row', async () => {
		const usage = { inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.005 };
		const budget = {
			maxModelCalls: 10,
			maxToolCalls: 20,
			maxChildWorkflows: 3,
			maxTokens: 100_000,
			maxActions: 30,
			maxActiveWallClockMs: 600_000,
			maxEstimatedCostUsd: 1.0
		};

		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, model, usage, budget, started_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'run-usage-budget',
				'session-001',
				'agent-run:run-usage-budget',
				'complete',
				'claude-sonnet-4-5-20250929',
				JSON.stringify(usage),
				JSON.stringify(budget),
				'2026-06-26T02:00:00.000Z',
				'2026-06-26T02:01:00.000Z'
			);

		const projection = await readRunInspectorProjection(database, 'run-usage-budget');

		expect(projection?.run.model).toBe('claude-sonnet-4-5-20250929');
		expect(projection?.run.usage).toEqual(usage);
		expect(projection?.run.budget).toEqual(budget);
	});

	it('exposes null usage and budget when not persisted', async () => {
		const projection = await readRunInspectorProjection(database, 'run-001');
		expect(projection?.run.usage).toBeNull();
		expect(projection?.run.budget).toBeNull();
	});

	it('computes durationMs from tool_call/tool_result pairing by callId', async () => {
		const callStart = '2026-06-26T05:00:00.000Z';
		const resultTime = '2026-06-26T05:00:02.500Z'; // 2500ms later

		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, started_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run('run-timing-001', 'session-001', 'agent-run:run-timing-001', 'complete', callStart);

		await appendTranscriptEvent(database, {
			id: 'timing-tc-001',
			runId: 'run-timing-001',
			sessionId: 'session-001',
			kind: 'tool_call',
			payload: JSON.stringify({
				calls: [{ id: 'call-abc', name: 'bash', input: { command: 'ls' } }]
			}),
			createdAt: callStart
		});

		await appendTranscriptEvent(database, {
			id: 'timing-tr-001',
			runId: 'run-timing-001',
			sessionId: 'session-001',
			kind: 'tool_result',
			payload: JSON.stringify({
				callId: 'call-abc',
				content: 'file-list',
				isError: false
			}),
			createdAt: resultTime
		});

		const projection = await readRunInspectorProjection(database, 'run-timing-001');
		const toolCallEvent = projection?.transcript.find((e) => e.kind === 'tool_call');

		expect(toolCallEvent?.durationMs).toBe(2500);
		expect(toolCallEvent?.attempts).toBe(1);
	});

	it('computes attempts > 1 when multiple tool_result rows share a callId', async () => {
		const callStart = '2026-06-26T06:00:00.000Z';
		const firstResultTime = '2026-06-26T06:00:01.000Z'; // first attempt (error)
		const secondResultTime = '2026-06-26T06:00:02.000Z'; // retry succeeds

		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, started_at) VALUES (?, ?, ?, ?, ?)`
			)
			.run('run-timing-002', 'session-001', 'agent-run:run-timing-002', 'complete', callStart);

		await appendTranscriptEvent(database, {
			id: 'timing-tc-002',
			runId: 'run-timing-002',
			sessionId: 'session-001',
			kind: 'tool_call',
			payload: JSON.stringify({
				calls: [{ id: 'call-def', name: 'bash', input: { command: 'risky' } }]
			}),
			createdAt: callStart
		});

		// First attempt: Temporal activity fails and persists an error result.
		await appendTranscriptEvent(database, {
			id: 'timing-tr-002a',
			runId: 'run-timing-002',
			sessionId: 'session-001',
			kind: 'tool_result',
			payload: JSON.stringify({
				callId: 'call-def',
				content: 'error: timeout',
				isError: true
			}),
			createdAt: firstResultTime
		});

		// Second attempt: Temporal retries the activity; same callId, success.
		await appendTranscriptEvent(database, {
			id: 'timing-tr-002b',
			runId: 'run-timing-002',
			sessionId: 'session-001',
			kind: 'tool_result',
			payload: JSON.stringify({
				callId: 'call-def',
				content: 'success output',
				isError: false
			}),
			createdAt: secondResultTime
		});

		const projection = await readRunInspectorProjection(database, 'run-timing-002');
		const toolCallEvent = projection?.transcript.find((e) => e.kind === 'tool_call');

		expect(toolCallEvent?.attempts).toBe(2);
		// durationMs = latest result time - call start = 2000ms
		expect(toolCallEvent?.durationMs).toBe(2000);
	});

	it('leaves durationMs and attempts undefined for non-tool_call events', async () => {
		const projection = await readRunInspectorProjection(database, 'run-001');

		for (const event of projection?.transcript ?? []) {
			if (event.kind !== 'tool_call') {
				expect(event.durationMs).toBeUndefined();
				expect(event.attempts).toBeUndefined();
			}
		}
	});

	it('shows timeline lanes, usage, and tool invocations for a parent run with child workflow and tool call', async () => {
		const usage = { inputTokens: 500, outputTokens: 200, estimatedCostUsd: 0.009 };
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, model, usage, started_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'run-parent-with-child',
				'session-001',
				'agent-run:run-parent-with-child',
				'complete',
				'claude-sonnet-4-5-20250929',
				JSON.stringify(usage),
				'2026-06-26T03:00:00.000Z',
				'2026-06-26T03:02:00.000Z'
			);

		// Seed a tool invocation for this run.
		sqlite
			.prepare(
				`INSERT INTO tool_invocations (id, session_id, run_id, tool_call_id, tool_name, args, args_hash, status, risk, task_queue)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'tool-inv-001',
				'session-001',
				'run-parent-with-child',
				'tc-001',
				'workspace.readFile',
				'{}',
				'abc123',
				'complete',
				'low',
				'tools-general'
			);

		// Seed subagent stream events (child workflow lane).
		await publishStreamEvent(database, {
			sessionId: 'session-001',
			runId: 'run-parent-with-child',
			kind: 'subagent.start',
			payload: JSON.stringify({
				subagentRunId: 'run-parent-with-child:research',
				kind: 'research',
				label: 'Research',
				startedAt: '2026-06-26T03:00:30.000Z'
			}),
			createdAt: '2026-06-26T03:00:30.000Z'
		});
		await publishStreamEvent(database, {
			sessionId: 'session-001',
			runId: 'run-parent-with-child',
			kind: 'subagent.complete',
			payload: JSON.stringify({
				subagentRunId: 'run-parent-with-child:research',
				kind: 'research',
				label: 'Research',
				status: 'complete',
				budget: { inputTokens: 70, outputTokens: 20, estimatedCostUsd: 0.0007 },
				completedAt: '2026-06-26T03:01:00.000Z'
			}),
			createdAt: '2026-06-26T03:01:00.000Z'
		});

		const projection = await readRunInspectorProjection(database, 'run-parent-with-child');

		// Token usage + cost surfaced from the row.
		expect(projection?.run.usage?.inputTokens).toBe(500);
		expect(projection?.run.usage?.estimatedCostUsd).toBe(0.009);
		// Timeline lane present (child workflow).
		expect(projection?.timelineLanes).toHaveLength(1);
		const parentLane = projection?.timelineLanes?.[0];
		expect(parentLane?.children).toHaveLength(1);
		expect(parentLane?.children?.[0].id).toBe('run-parent-with-child:research');
		// Tool invocation counted in the action meter.
		expect(projection?.actionMeter.breakdown.toolInvocations).toBe(1);
		expect(projection?.toolInvocations).toHaveLength(1);
		expect(projection?.toolInvocations[0].toolName).toBe('workspace.readFile');
	});
});

describe('queryRuns', () => {
	beforeAll(() => {
		// Seed a variety of runs for filter tests.
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, model) VALUES (?, ?, ?, ?, ?)`
			)
			.run(
				'qr-run-001',
				'session-001',
				'agent-run:qr-run-001',
				'complete',
				'claude-sonnet-4-5-20250929'
			);
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, model) VALUES (?, ?, ?, ?, ?)`
			)
			.run(
				'qr-run-002',
				'session-001',
				'agent-run:qr-run-002',
				'failed',
				'claude-opus-4-5-20251101'
			);
		sqlite
			.prepare(
				`INSERT INTO runs (id, session_id, workflow_id, status, model) VALUES (?, ?, ?, ?, ?)`
			)
			.run('qr-run-003', 'session-001', 'agent-run:qr-run-003', 'complete', null);

		// Seed a tool_invocations row for qr-run-001.
		sqlite
			.prepare(
				`INSERT INTO tool_invocations (id, session_id, run_id, tool_call_id, tool_name, args, args_hash, status, risk, task_queue)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'qr-tool-001',
				'session-001',
				'qr-run-001',
				'qr-tc-001',
				'workspace.writeFile',
				'{}',
				'def456',
				'complete',
				'medium',
				'tools-sandbox'
			);

		// Seed an approval_request row for qr-run-002.
		sqlite
			.prepare(
				`INSERT INTO approval_requests (id, session_id, run_id, tool_call_id, tool_name, status, proposed_args, args_hash, policy_version, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'qr-approval-001',
				'session-001',
				'qr-run-002',
				'qr-tc-002',
				'workspace.writeFile',
				'approved',
				'{}',
				'hash001',
				'v1',
				'2099-01-01T00:00:00.000Z'
			);
	});

	it('returns all runs for a session', async () => {
		const result = await queryRuns(database, { sessionId: 'session-001' });
		const ids = result.map((r) => r.id);
		expect(ids).toContain('qr-run-001');
		expect(ids).toContain('qr-run-002');
		expect(ids).toContain('qr-run-003');
	});

	it('filters by status', async () => {
		const result = await queryRuns(database, { sessionId: 'session-001', status: 'complete' });
		const ids = result.map((r) => r.id);
		expect(ids).toContain('qr-run-001');
		expect(ids).not.toContain('qr-run-002');
	});

	it('filters by model', async () => {
		const result = await queryRuns(database, {
			sessionId: 'session-001',
			model: 'claude-opus-4-5-20251101'
		});
		const ids = result.map((r) => r.id);
		expect(ids).toContain('qr-run-002');
		expect(ids).not.toContain('qr-run-001');
		expect(ids).not.toContain('qr-run-003');
	});

	it('filters by tool name (via tool_invocations subquery)', async () => {
		const result = await queryRuns(database, {
			sessionId: 'session-001',
			toolName: 'workspace.writeFile'
		});
		const ids = result.map((r) => r.id);
		expect(ids).toContain('qr-run-001');
		expect(ids).not.toContain('qr-run-002');
		expect(ids).not.toContain('qr-run-003');
	});

	it('filters by approval state (via approval_requests subquery)', async () => {
		const result = await queryRuns(database, {
			sessionId: 'session-001',
			approvalStatus: 'approved'
		});
		const ids = result.map((r) => r.id);
		expect(ids).toContain('qr-run-002');
		expect(ids).not.toContain('qr-run-001');
	});
});
