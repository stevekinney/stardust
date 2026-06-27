import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	ApprovalResolution,
	ApprovalResolutionInput,
	SessionMemorySnapshot,
	SessionState,
	SubmitTurnResult
} from '@src/lib/types';
import { TASK_QUEUE_ORCHESTRATOR, TASK_QUEUE_TOOLS } from '@src/lib/types';
import {
	cancelRunSignal,
	getActiveRunQuery,
	getMemorySnapshotQuery,
	getPendingApprovalsQuery,
	resolveApprovalUpdate,
	getSandboxSnapshotQuery,
	getSessionStateQuery,
	interruptRunUpdate,
	submitSteeringUpdate,
	submitTurnUpdate
} from './session-contracts';
import {
	getSteeringBufferQuery,
	receivedApprovalQuery,
	releaseRunSignal
} from './__fixtures__/blocking-run.fixture';

const testActivities = {
	async noop(): Promise<void> {}
};

// ── Basic suite — uses the real workflows index (no blocking) ──────────────────

describe('agentSessionWorkflow', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	async function runWithWorker<T>(callback: () => Promise<T>): Promise<T> {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
			activities: testActivities
		});

		return worker.runUntil(callback);
	}

	it('submitTurn returns { accepted: true, runId }', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-basic-${Date.now()}`,
				args: [{ sessionKey: 'test-basic' }]
			});

			const result: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'hello world' }]
			});

			expect(result.accepted).toBe(true);
			expect(result.runId).toBe('test-basic-run-1');
		});
	});

	it('getSessionState query reflects the session key and initial state', async () => {
		await runWithWorker(async () => {
			const sessionKey = 'test-query';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}-${Date.now()}`,
				args: [{ sessionKey }]
			});

			const state: SessionState = await handle.query(getSessionStateQuery);
			expect(state.sessionKey).toBe(sessionKey);
			expect(state.activeRunId).toBeNull();
			expect(state.queueDepth).toBe(0);
			expect(state.completedRunCount).toBe(0);
			// Status starts idle when no turn is active.
			expect(state.status).toBe('idle');
		});
	});

	it('getActiveRun query returns null when no run is active', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-active-run-idle-${Date.now()}`,
				args: [{ sessionKey: 'test-active-run-idle' }]
			});

			const activeRun = await handle.query(getActiveRunQuery);
			expect(activeRun).toBeNull();
		});
	});

	it('getPendingApprovals query returns empty array', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-pending-approvals-${Date.now()}`,
				args: [{ sessionKey: 'test-pending-approvals' }]
			});

			const approvals = await handle.query(getPendingApprovalsQuery);
			expect(approvals).toEqual([]);
		});
	});

	it('getMemorySnapshot query returns empty refs on a fresh session', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-memory-fresh-${Date.now()}`,
				args: [{ sessionKey: 'test-memory-fresh' }]
			});

			const snapshot: SessionMemorySnapshot = await handle.query(getMemorySnapshotQuery);
			expect(snapshot.memoryRefs).toEqual([]);
		});
	});

	it('getMemorySnapshot carries over refs supplied in input (post-CAN continuation)', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-memory-carried-${Date.now()}`,
				args: [{ sessionKey: 'test-memory-carried', memoryRefs: ['ref-a', 'ref-b'] }]
			});

			const snapshot: SessionMemorySnapshot = await handle.query(getMemorySnapshotQuery);
			expect(snapshot.memoryRefs).toEqual(['ref-a', 'ref-b']);
		});
	});

	it('getSandboxSnapshot returns workspacePath=null', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-sandbox-${Date.now()}`,
				args: [{ sessionKey: 'test-sandbox' }]
			});

			const snapshot = await handle.query(getSandboxSnapshotQuery);
			expect(snapshot.workspacePath).toBeNull();
			expect(snapshot.sessionKey).toBe('test-sandbox');
		});
	});

	it('submitSteering returns rejected when no active run', async () => {
		await runWithWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-steering-idle-${Date.now()}`,
				args: [{ sessionKey: 'test-steering-idle' }]
			});

			const result = await handle.executeUpdate(submitSteeringUpdate, {
				args: [{ message: 'steer me' }]
			});
			expect(result.accepted).toBe(false);
			expect(result.reason).toBeTruthy();
		});
	});
});

// ── Blocking-fixture suite — all tests that need to observe mid-run state ──────

describe('agentSessionWorkflow — blocking fixture', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	async function runWithBlockingWorker<T>(callback: () => Promise<T>): Promise<T> {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(
				new URL('./__fixtures__/blocking-run.fixture.ts', import.meta.url)
			),
			activities: testActivities
		});

		return worker.runUntil(callback);
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	async function pollUntil(
		condition: () => Promise<boolean>,
		maxAttempts = 20,
		intervalMs = 50
	): Promise<void> {
		for (let i = 0; i < maxAttempts; i++) {
			if (await condition()) return;
			await env.sleep(intervalMs);
		}
		throw ApplicationFailure.nonRetryable('pollUntil: condition not met within allowed attempts');
	}

	// ── Serialization ──────────────────────────────────────────────────────────

	it('queues a second turn while a run is active, not starts it concurrently', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-serialization';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn1: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'turn one' }]
			});
			expect(turn1.accepted).toBe(true);

			const turn2: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'turn two' }]
			});
			expect(turn2.accepted).toBe(true);
			expect(turn2.runId).not.toBe(turn1.runId);

			const midState: SessionState = await handle.query(getSessionStateQuery);
			expect(midState.activeRunId).toBe(turn1.runId);
			expect(midState.queueDepth).toBe(1);
			expect(midState.completedRunCount).toBe(0);

			const childHandle1 = env.client.workflow.getHandle(`agent-run:${turn1.runId}`);
			await childHandle1.signal(releaseRunSignal, turn1.runId);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn2.runId;
			});

			const childHandle2 = env.client.workflow.getHandle(`agent-run:${turn2.runId}`);
			await childHandle2.signal(releaseRunSignal, turn2.runId);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.completedRunCount === 2;
			});

			const finalState: SessionState = await handle.query(getSessionStateQuery);
			expect(finalState.completedRunCount).toBe(2);
			expect(finalState.activeRunId).toBeNull();
			expect(finalState.queueDepth).toBe(0);
		});
	});

	// ── Status transitions ─────────────────────────────────────────────────────

	it('status is idle before any turn, active during a run, idle again after', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-status-transitions';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const before: SessionState = await handle.query(getSessionStateQuery);
			expect(before.status).toBe('idle');

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'a message' }]
			});

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.status === 'active';
			});

			const during: SessionState = await handle.query(getSessionStateQuery);
			expect(during.status).toBe('active');
			expect(during.activeRunId).toBe(turn.runId);

			await env.client.workflow
				.getHandle(`agent-run:${turn.runId}`)
				.signal(releaseRunSignal, turn.runId);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.status === 'idle';
			});

			const after: SessionState = await handle.query(getSessionStateQuery);
			expect(after.status).toBe('idle');
			expect(after.activeRunId).toBeNull();
		});
	});

	// ── Steering ───────────────────────────────────────────────────────────────

	it('submitSteering is accepted and forwarded to the active run', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-steering-active';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'do something' }]
			});

			// Wait for the run to become active.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn.runId;
			});

			// Submit steering while the run is active.
			const steeringResult = await handle.executeUpdate(submitSteeringUpdate, {
				args: [{ message: 'actually do this instead' }]
			});
			expect(steeringResult.accepted).toBe(true);

			// The run should have received the steering message in its buffer.
			const runHandle = env.client.workflow.getHandle(`agent-run:${turn.runId}`);
			const steeringBuffer = await runHandle.query(getSteeringBufferQuery);
			expect(steeringBuffer).toContain('actually do this instead');

			// Clean up.
			await runHandle.signal(releaseRunSignal, turn.runId);
		});
	});

	it('getActiveRun query returns the run id while a run is in progress', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-active-run-query';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'query me' }]
			});

			await pollUntil(async () => {
				const active = await handle.query(getActiveRunQuery);
				return active?.runId === turn.runId;
			});

			const activeRun = await handle.query(getActiveRunQuery);
			expect(activeRun?.runId).toBe(turn.runId);

			await env.client.workflow
				.getHandle(`agent-run:${turn.runId}`)
				.signal(releaseRunSignal, turn.runId);

			await pollUntil(async () => {
				const active = await handle.query(getActiveRunQuery);
				return active === null;
			});

			expect(await handle.query(getActiveRunQuery)).toBeNull();
		});
	});

	// ── Interrupt ──────────────────────────────────────────────────────────────

	it('interruptRun cancels the active run and session returns to idle', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-interrupt';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'start a run' }]
			});

			// Wait for the run to become active.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn.runId;
			});

			// Interrupt the active run.
			const interruptResult = await handle.executeUpdate(interruptRunUpdate, {
				args: [{}]
			});
			expect(interruptResult.interrupted).toBe(true);
			expect(interruptResult.replacementRunId).toBeUndefined();

			// Session should return to idle with no active run.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === null && state.status === 'idle';
			});

			const state: SessionState = await handle.query(getSessionStateQuery);
			expect(state.activeRunId).toBeNull();
			expect(state.status).toBe('idle');
			// Cancelled run does not count as completed.
			expect(state.completedRunCount).toBe(0);
		});
	});

	it('interruptRun with replacement queues the replacement and returns its runId', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-interrupt-replacement';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'original' }]
			});

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn.runId;
			});

			const interruptResult = await handle.executeUpdate(interruptRunUpdate, {
				args: [{ replacement: 'do this instead' }]
			});
			expect(interruptResult.interrupted).toBe(true);
			expect(interruptResult.replacementRunId).toBeDefined();

			// Wait for the replacement run to become active.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === interruptResult.replacementRunId;
			});

			// Release the replacement run.
			await env.client.workflow
				.getHandle(`agent-run:${interruptResult.replacementRunId!}`)
				.signal(releaseRunSignal, interruptResult.replacementRunId!);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.completedRunCount === 1;
			});

			const finalState: SessionState = await handle.query(getSessionStateQuery);
			expect(finalState.completedRunCount).toBe(1);
		});
	});

	it('interruptRun returns interrupted=false when no run is active', async () => {
		await runWithBlockingWorker(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-interrupt-idle-${Date.now()}`,
				args: [{ sessionKey: 'test-interrupt-idle' }]
			});

			const result = await handle.executeUpdate(interruptRunUpdate, {
				args: [{}]
			});
			expect(result.interrupted).toBe(false);
		});
	});

	// ── Cancel ─────────────────────────────────────────────────────────────────

	it('cancelRun signal ends the session even with an active run', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-cancel';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'run that gets cancelled' }]
			});

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn.runId;
			});

			// Send the cancel signal.
			await handle.signal(cancelRunSignal);

			// The session should exit; await its result.
			await handle.result();

			const finalState: SessionState = await handle.query(getSessionStateQuery);
			expect(finalState.status).toBe('complete');
			expect(finalState.activeRunId).toBeNull();
		});
	});

	// ── Memory refs ────────────────────────────────────────────────────────────

	it('getMemorySnapshot accumulates refs from completed runs', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-memory-accumulation';
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			const turn1: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'first' }]
			});
			const turn2: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'second' }]
			});

			// Release run 1.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn1.runId;
			});
			await env.client.workflow
				.getHandle(`agent-run:${turn1.runId}`)
				.signal(releaseRunSignal, turn1.runId);

			// Release run 2.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn2.runId;
			});
			await env.client.workflow
				.getHandle(`agent-run:${turn2.runId}`)
				.signal(releaseRunSignal, turn2.runId);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.completedRunCount === 2;
			});

			const snapshot: SessionMemorySnapshot = await handle.query(getMemorySnapshotQuery);
			// The blocking fixture emits one ref per run (mem:<runId>).
			expect(snapshot.memoryRefs).toHaveLength(2);
			expect(snapshot.memoryRefs).toContain(`mem:${turn1.runId}`);
			expect(snapshot.memoryRefs).toContain(`mem:${turn2.runId}`);
		});
	});

	// ── Continue-As-New ────────────────────────────────────────────────────────

	it('Continue-As-New carries completedRunCount and memoryRefs across the boundary', async () => {
		await runWithBlockingWorker(async () => {
			const sessionKey = 'test-can';
			// Set threshold to 1 so CAN triggers after the first run completes.
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey, canHistoryThreshold: 1 }]
			});

			// Submit and complete run 1 — this triggers CAN (threshold=1).
			const turn1: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'trigger CAN' }]
			});

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn1.runId;
			});

			// Capture the runId of the first execution before CAN fires.
			const beforeCanRunId = (await handle.describe()).runId;

			await env.client.workflow
				.getHandle(`agent-run:${turn1.runId}`)
				.signal(releaseRunSignal, turn1.runId);

			// After CAN the session continues under the same workflowId.
			// Submit run 2 to confirm the new execution is alive.
			const turn2: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'post-CAN turn' }]
			});
			expect(turn2.accepted).toBe(true);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn2.runId;
			});
			await env.client.workflow
				.getHandle(`agent-run:${turn2.runId}`)
				.signal(releaseRunSignal, turn2.runId);

			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.completedRunCount === 2;
			});

			// Verify that Continue-As-New actually fired: the runId must have changed,
			// proving the boundary was crossed (not just that state survived two runs).
			const afterCanRunId = (await handle.describe()).runId;
			expect(afterCanRunId).not.toBe(beforeCanRunId);

			const state: SessionState = await handle.query(getSessionStateQuery);
			expect(state.completedRunCount).toBe(2);

			const snapshot: SessionMemorySnapshot = await handle.query(getMemorySnapshotQuery);
			// Both refs should be present across the CAN boundary.
			expect(snapshot.memoryRefs).toHaveLength(2);
			expect(snapshot.memoryRefs).toContain(`mem:${turn1.runId}`);
			expect(snapshot.memoryRefs).toContain(`mem:${turn2.runId}`);
		});
	}, 60_000);
});

// ── Approval routing suite — verifies session sits on the approval resolution path ──

describe('agentSessionWorkflow — approval routing', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	async function pollUntil(
		condition: () => Promise<boolean>,
		maxAttempts = 20,
		intervalMs = 50
	): Promise<void> {
		for (let i = 0; i < maxAttempts; i++) {
			if (await condition()) return;
			await env.sleep(intervalMs);
		}
		throw ApplicationFailure.nonRetryable('pollUntil: condition not met within allowed attempts');
	}

	it('resolveApprovalUpdate routes through the session and confirms it reaches the active run', async () => {
		// The forwardApprovalToRun activity (on TASK_QUEUE_TOOLS) uses env.client to
		// call resolveApprovalUpdate on the run. The blocking fixture handles the update
		// and records the input for assertion via receivedApprovalQuery.
		const approvalForwardingActivities = {
			async forwardApprovalToRun(input: {
				runId: string;
				resolution: ApprovalResolutionInput;
			}): Promise<ApprovalResolution> {
				const handle = env.client.workflow.getHandle(`agent-run:${input.runId}`);
				return handle.executeUpdate(resolveApprovalUpdate, { args: [input.resolution] });
			}
		};

		const orchestratorWorker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(
				new URL('./__fixtures__/blocking-run.fixture.ts', import.meta.url)
			),
			activities: { noop: async () => {} }
		});

		const toolsWorker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_TOOLS,
			activities: approvalForwardingActivities
		});

		const sessionKey = 'test-approval-routing';
		const orchestratorTask = orchestratorWorker.runUntil(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}-${Date.now()}`,
				args: [{ sessionKey }]
			});

			const turn: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'do something' }]
			});

			// Wait for the run to become active.
			await pollUntil(async () => {
				const state = await handle.query(getSessionStateQuery);
				return state.activeRunId === turn.runId;
			});

			// Resolve via the session — this is the path the architecture spec requires.
			const approvalId = `${turn.runId}:tool-001:approval`;
			const resolution: ApprovalResolution = await handle.executeUpdate(resolveApprovalUpdate, {
				args: [{ approvalId, action: 'approve', actor: 'user' }]
			});

			// The session returned the ApprovalResolution from the run.
			expect(resolution.approvalId).toBe(approvalId);
			expect(resolution.action).toBe('approve');
			expect(resolution.terminalState).toBe('approved');

			// Verify the run actually received the resolution (not bypassed).
			const runHandle = env.client.workflow.getHandle(`agent-run:${turn.runId}`);
			const received = await runHandle.query(receivedApprovalQuery);
			expect(received?.approvalId).toBe(approvalId);
			expect(received?.action).toBe('approve');

			// Clean up.
			await runHandle.signal(releaseRunSignal, turn.runId);
		});

		const toolsTask = toolsWorker.runUntil(orchestratorTask.catch(() => undefined));
		await Promise.all([orchestratorTask, toolsTask]);
	}, 60_000);

	it('resolveApprovalUpdate throws when no run is active', async () => {
		const worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
			activities: { noop: async () => {} }
		});

		await worker.runUntil(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:test-approval-idle-${Date.now()}`,
				args: [{ sessionKey: 'test-approval-idle' }]
			});

			await expect(
				handle.executeUpdate(resolveApprovalUpdate, {
					args: [{ approvalId: 'approval-001', action: 'approve', actor: 'user' }]
				})
			).rejects.toThrow();
		});
	});
});
