import type { ScheduledAgentInput, SubmitTurnResult } from '@src/lib/types';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';
import { getTemporalClient } from './client';
import { submitTurnUpdate } from '@src/workflows/session-contracts';

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
