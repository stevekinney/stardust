import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_QUEUE_ORCHESTRATOR } from '@src/lib/types';
import { submitTurnUpdate } from '@src/workflows/session-contracts';

const testActivities = {
	async noop(): Promise<void> {}
};

// Required export — temporal/replay-history-smoke-test-hook verifies this exists.
export async function runReplayHistorySmokeTest(): Promise<void> {
	const env = await TestWorkflowEnvironment.createTimeSkipping();
	const worker = await Worker.create({
		connection: env.nativeConnection,
		namespace: 'default',
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
		activities: testActivities
	});

	try {
		await worker.runUntil(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: 'agent-session:replay-smoke-hook',
				args: [{ sessionKey: 'replay-smoke-hook' }]
			});

			await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'replay test message' }]
			});

			await env.sleep(100);

			const history = await handle.fetchHistory();

			// Validate the recorded history against the current workflow code.
			const results = Worker.runReplayHistories(
				{
					workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url))
				},
				[{ workflowId: 'agent-session:replay-smoke-hook', history }]
			);

			for await (const result of results) {
				if (result.error) throw result.error;
			}
		});
	} finally {
		await env.teardown();
	}
}

describe('Workflow replay histories', () => {
	let env: TestWorkflowEnvironment;
	let worker: Worker;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
		worker = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
			activities: testActivities
		});
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('replays AgentSessionWorkflow history against current code without non-determinism errors', async () => {
		await worker.runUntil(async () => {
			const handle = await env.client.workflow.start('agentSessionWorkflow', {
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				workflowId: 'agent-session:replay-smoke',
				args: [{ sessionKey: 'replay-smoke' }]
			});

			await handle.executeUpdate(submitTurnUpdate, {
				args: [{ message: 'replay test message' }]
			});

			await env.sleep(100);

			const history = await handle.fetchHistory();
			expect(history.events?.length).toBeGreaterThan(0);

			const results = Worker.runReplayHistories(
				{
					workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url))
				},
				[{ workflowId: 'agent-session:replay-smoke', history }]
			);

			for await (const result of results) {
				if (result.error) throw result.error;
			}
		});
	}, 30_000);
});
