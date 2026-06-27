import { error, json } from '@sveltejs/kit';
import { WorkflowIdConflictPolicy } from '@temporalio/common';
import type { RequestHandler } from './$types';
import { TASK_QUEUE_ORCHESTRATOR } from '$lib/types';
import { getTemporalClient } from '$lib/server/temporal/client';
import { agentSessionWorkflow } from '@src/workflows/agent-session.workflow';
import { submitTurnUpdate } from '@src/workflows/session-contracts';
import { isValidSessionKey } from '$lib/server/session-key';

export const POST: RequestHandler = async ({ params, request }) => {
	const { sessionKey } = params;

	if (!isValidSessionKey(sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}

	const body = await request.json().catch(() => null);
	const message = typeof body?.message === 'string' ? body.message.trim() : '';
	if (!message) {
		throw error(400, 'message is required');
	}

	const client = await getTemporalClient();
	const workflowId = `agent-session:${sessionKey}`;

	// Start-or-use-existing in one call, then send the update.
	await client.workflow.start(agentSessionWorkflow, {
		workflowId,
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
		args: [{ sessionKey }]
	});

	const handle = client.workflow.getHandle(workflowId);
	const result = await handle.executeUpdate(submitTurnUpdate, {
		args: [{ message }]
	});

	return json({
		accepted: result.accepted,
		runId: result.runId,
		streamUrl: `/api/sessions/${sessionKey}/stream/${result.runId}`
	});
};
