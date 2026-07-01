import type { Client } from '@temporalio/client';
import type { SubmitTurnResult } from '@src/lib/types';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import { submitTurnUpdate } from '@src/workflows/session-contracts';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';
import { getTemporalClient } from './client';

export type SendSessionMessageInput = {
	/** Session key of the session that should receive the message. */
	targetSessionKey: string;
	/** Message content, enqueued as a new turn on the target session. */
	message: string;
	/** Session key of the sending session, when known. Used only for the self-send check. */
	fromSessionKey?: string;
};

export type SendSessionMessageResult = SubmitTurnResult & {
	targetSessionKey: string;
};

type SessionMessagingDependencies = {
	temporalClient?: Pick<Client, 'workflow'>;
};

/**
 * Sends a message into another session as a new turn.
 *
 * Follows the same start-or-reuse pattern as `submitScheduledTurn`:
 * `client.workflow.start` with `WorkflowIdConflictPolicy.USE_EXISTING` starts
 * the target session workflow if it isn't already running, or is a no-op
 * against the existing execution when it is, and then
 * `executeUpdate(submitTurnUpdate, ...)` enqueues the message as a turn on
 * that session.
 *
 * Rejects when `targetSessionKey === fromSessionKey`: a session messaging
 * itself is not a cross-session handoff, it's almost certainly a bug in the
 * calling agent (or a prompt trying to get the run to loop on itself).
 */
export async function sendSessionMessage(
	input: SendSessionMessageInput,
	dependencies: SessionMessagingDependencies = {}
): Promise<SendSessionMessageResult> {
	if (input.fromSessionKey !== undefined && input.fromSessionKey === input.targetSessionKey) {
		throw new Error('session.sendMessage cannot target the sending session itself');
	}

	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const workflowId = `agent-session:${input.targetSessionKey}`;

	await client.workflow.start('agentSessionWorkflow', {
		workflowId,
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
		args: [{ sessionKey: input.targetSessionKey }]
	});

	const handle = client.workflow.getHandle(workflowId);
	const result = await handle.executeUpdate(submitTurnUpdate, {
		args: [{ message: input.message }]
	});

	return { ...result, targetSessionKey: input.targetSessionKey };
}
