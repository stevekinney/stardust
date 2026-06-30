import type { ScheduledAgentInput, SubmitTurnResult } from '@src/lib/types';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { eq } from 'drizzle-orm';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';
import { getTemporalClient } from './client';
import { submitTurnUpdate } from '@src/workflows/session-contracts';
import { db } from '../db/client';
import { scheduleFireEvents, workflowExecutions } from '../db/schema';

/**
 * Maps a Temporal schedule ID to its canonical session key.
 *
 * The mapping uses a `sched-` prefix rather than the previously used
 * `scheduled:` prefix because colons are forbidden by the canonical session key
 * format (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`).  A colon-prefixed key would
 * fail validation in sandbox-names, workspace-path construction, and artifact
 * object key assembly.
 *
 * The mapping round-trips: given a session key produced by this function, the
 * originating schedule ID can be recovered with `sessionKey.slice('sched-'.length)`.
 *
 * Schedule IDs are minted as `schedule-{randomUUID()}`, so the resulting session
 * key is `sched-schedule-{uuid}` — well within the 128-character limit and
 * satisfying the canonical format.
 */
export function getScheduledSessionKey(scheduleId: string): string {
	return `sched-${scheduleId}`;
}

export async function submitScheduledTurn(input: ScheduledAgentInput): Promise<SubmitTurnResult> {
	const client = await getTemporalClient();
	const sessionKey = getScheduledSessionKey(input.scheduleId);
	const workflowId = `agent-session:${sessionKey}`;
	const now = new Date().toISOString();
	const activityContext = getActivityContext();
	const scheduledWorkflowExecution = activityContext?.info.workflowExecution;
	const scheduledWorkflowId =
		scheduledWorkflowExecution?.workflowId ?? `scheduled-agent:${input.scheduleId}`;
	const scheduledTemporalRunId = scheduledWorkflowExecution?.runId ?? null;
	const fireId = `${input.scheduleId}:${scheduledWorkflowId}:${scheduledTemporalRunId ?? 'local'}`;

	await db
		.insert(workflowExecutions)
		.values({
			id: `${fireId}:workflow`,
			workflowId: scheduledWorkflowId,
			temporalRunId: scheduledTemporalRunId,
			workflowType: 'ScheduledAgentWorkflow',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			sessionId: sessionKey,
			status: 'running',
			startedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: workflowExecutions.id,
			set: {
				status: 'running',
				startedAt: now,
				updatedAt: now
			}
		});

	await db
		.insert(scheduleFireEvents)
		.values({
			id: fireId,
			scheduleId: input.scheduleId,
			triggerSource: 'scheduled',
			actualTriggerTime: now,
			overlapPolicy: 'BUFFER_ONE',
			scheduledWorkflowId,
			scheduledTemporalRunId,
			targetSessionKey: sessionKey,
			status: 'started',
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();

	try {
		await client.workflow.start('agentSessionWorkflow', {
			workflowId,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
			args: [{ sessionKey }]
		});

		const handle = client.workflow.getHandle(workflowId);
		const result = await handle.executeUpdate(submitTurnUpdate, {
			args: [{ message: input.prompt }]
		});
		const completedAt = new Date().toISOString();
		await db
			.update(scheduleFireEvents)
			.set({
				acceptedRunId: result.runId,
				status: 'accepted',
				updatedAt: completedAt
			})
			.where(eq(scheduleFireEvents.id, fireId));
		await db
			.update(workflowExecutions)
			.set({
				runId: result.runId,
				status: 'completed',
				closedAt: completedAt,
				updatedAt: completedAt
			})
			.where(eq(workflowExecutions.id, `${fireId}:workflow`));
		return result;
	} catch (error) {
		const failedAt = new Date().toISOString();
		await db
			.update(scheduleFireEvents)
			.set({
				status: 'failed',
				error: error instanceof Error ? error.message : 'Scheduled turn failed',
				updatedAt: failedAt
			})
			.where(eq(scheduleFireEvents.id, fireId));
		await db
			.update(workflowExecutions)
			.set({
				status: 'failed',
				closedAt: failedAt,
				updatedAt: failedAt
			})
			.where(eq(workflowExecutions.id, `${fireId}:workflow`));
		throw error;
	}
}

function getActivityContext(): Context | null {
	try {
		return Context.current();
	} catch {
		return null;
	}
}
