import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScheduledAgentInput } from '@src/lib/types';
import { TASK_QUEUE_MEMORY, TASK_QUEUE_ORCHESTRATOR } from '@src/lib/types';

describe('scheduledAgentWorkflow', () => {
	let env: TestWorkflowEnvironment;

	beforeAll(async () => {
		env = await TestWorkflowEnvironment.createTimeSkipping();
	});

	afterAll(async () => {
		await env.teardown();
	});

	it('submits the scheduled prompt through the schedule activity', async () => {
		const submitScheduledTurn = vi.fn(async (input: ScheduledAgentInput) => ({
			accepted: true,
			runId: `${input.scheduleId}-run-1`
		}));

		const orchestrator = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url))
		});
		const activities = await Worker.create({
			connection: env.nativeConnection,
			namespace: 'default',
			taskQueue: TASK_QUEUE_MEMORY,
			activities: { submitScheduledTurn }
		});

		await Promise.all([
			orchestrator.runUntil(async () => {
				await activities.runUntil(async () => {
					const result = await env.client.workflow.execute('scheduledAgentWorkflow', {
						taskQueue: TASK_QUEUE_ORCHESTRATOR,
						workflowId: `scheduled-agent:test-schedule-${Date.now()}`,
						args: [{ scheduleId: 'test-schedule', prompt: 'write the digest' }]
					});

					expect(result).toEqual({ accepted: true, runId: 'test-schedule-run-1' });
				});
			})
		]);

		expect(submitScheduledTurn).toHaveBeenCalledWith({
			scheduleId: 'test-schedule',
			prompt: 'write the digest'
		});
	});
});
