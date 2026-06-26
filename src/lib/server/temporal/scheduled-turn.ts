import type { ScheduledAgentInput, SubmitTurnResult } from '@src/lib/types';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';
import { getTemporalClient } from './client';
import { submitTurnUpdate } from '@src/workflows/session-contracts';

export function getScheduledSessionKey(scheduleId: string): string {
	return `scheduled:${scheduleId}`;
}

export async function submitScheduledTurn(input: ScheduledAgentInput): Promise<SubmitTurnResult> {
	const client = await getTemporalClient();
	const sessionKey = getScheduledSessionKey(input.scheduleId);
	const workflowId = `agent-session:${sessionKey}`;

	await client.workflow.start('agentSessionWorkflow', {
		workflowId,
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
		args: [{ sessionKey }]
	});

	const handle = client.workflow.getHandle(workflowId);
	return handle.executeUpdate(submitTurnUpdate, {
		args: [{ message: input.prompt }]
	});
}
