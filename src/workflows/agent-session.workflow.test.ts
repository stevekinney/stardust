import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionState, SubmitTurnResult } from '@src/lib/types';
import { TASK_QUEUE_ORCHESTRATOR } from '@src/lib/types';
import { getSessionStateQuery, submitTurnUpdate } from './session-contracts';
import { releaseRunSignal } from './__fixtures__/blocking-run.fixture';

describe('agentSessionWorkflow', () => {
	let env: TestWorkflowEnvironment;
	let worker: Worker;
	let workerRunPromise: Promise<void>;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
		worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		workerRunPromise = worker.run();
	});

	afterAll(async () => {
		worker.shutdown();
		await workerRunPromise;
		await env.teardown();
	});

	it('submitTurn returns { accepted: true, runId }', async () => {
		const handle = await env.client.workflow.start('agentSessionWorkflow', {
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowId: `agent-session:test-basic-${Date.now()}`,
			args: [{ sessionKey: 'test-basic' }]
		});

		const result: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
			args: [{ message: 'hello world' }]
		});

		expect(result.accepted).toBe(true);
		expect(typeof result.runId).toBe('string');
		expect(result.runId.length).toBeGreaterThan(0);
	});

	it('getSessionState query reflects the session key and initial state', async () => {
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
	});

	describe('serialization — one active run at a time', () => {
		let serializationEnv: TestWorkflowEnvironment;
		let serializationWorker: Worker;
		let serializationRunPromise: Promise<void>;

		beforeAll(async () => {
			serializationEnv = await TestWorkflowEnvironment.createTimeSkipping();
			serializationWorker = await Worker.create({
				connection: serializationEnv.nativeConnection,
				namespace: 'default',
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowsPath: fileURLToPath(
					new URL('./__fixtures__/blocking-run.fixture.ts', import.meta.url)
				)
			});
			serializationRunPromise = serializationWorker.run();
		});

		afterAll(async () => {
			serializationWorker.shutdown();
			await serializationRunPromise;
			await serializationEnv.teardown();
		});

		it('queues a second turn while a run is active, not starts it concurrently', async () => {
			const sessionKey = 'test-serialization';
			const handle = await serializationEnv.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: `agent-session:${sessionKey}`,
				args: [{ sessionKey }]
			});

			// Submit turn 1 — session starts agentRunWorkflow child which blocks on releaseRunSignal.
			const turn1: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'turn one' }]
			});
			expect(turn1.accepted).toBe(true);

			// Submit turn 2 while turn 1 is in-flight.
			const turn2: SubmitTurnResult = await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'turn two' }]
			});
			expect(turn2.accepted).toBe(true);
			expect(turn2.runId).not.toBe(turn1.runId);

			// Mid-flight assertion: turn 1 must be active; turn 2 must be queued, not running.
			const midState: SessionState = await handle.query(getSessionStateQuery);
			expect(midState.activeRunId).toBe(turn1.runId);
			expect(midState.queueDepth).toBe(1);
			expect(midState.completedRunCount).toBe(0);

			// Release turn 1.
			const childHandle1 = serializationEnv.client.workflow.getHandle(`agent-run:${turn1.runId}`);
			await childHandle1.signal(releaseRunSignal, turn1.runId);

			// Poll until the session workflow has advanced and started turn 2.
			for (let i = 0; i < 20; i++) {
				const state = await handle.query(getSessionStateQuery);
				if (state.activeRunId === turn2.runId) break;
				await serializationEnv.sleep(50);
			}

			// Release turn 2.
			const childHandle2 = serializationEnv.client.workflow.getHandle(`agent-run:${turn2.runId}`);
			await childHandle2.signal(releaseRunSignal, turn2.runId);

			// Poll until both runs complete.
			let finalState: SessionState | null = null;
			for (let i = 0; i < 20; i++) {
				finalState = await handle.query(getSessionStateQuery);
				if (finalState.completedRunCount === 2) break;
				await serializationEnv.sleep(50);
			}

			expect(finalState?.completedRunCount).toBe(2);
			expect(finalState?.activeRunId).toBeNull();
			expect(finalState?.queueDepth).toBe(0);
		});
	});
});
