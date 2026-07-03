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
	const delegateSubagents = body?.delegateSubagents === true ? true : undefined;
	const model = typeof body?.model === 'string' && body.model ? body.model : undefined;
	const maxBudgetUsd = typeof body?.maxBudgetUsd === 'number' ? body.maxBudgetUsd : undefined;

	const workflowId = `agent-session:${sessionKey}`;

	try {
		const client = await getTemporalClient();

		// Start-or-use-existing in one call, then send the update.
		await client.workflow.start(agentSessionWorkflow, {
			workflowId,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
			args: [{ sessionKey }]
		});

		const handle = client.workflow.getHandle(workflowId);
		const result = await handle.executeUpdate(submitTurnUpdate, {
			args: [{ message, delegateSubagents, model, maxBudgetUsd }]
		});

		return json({
			accepted: result.accepted,
			runId: result.runId,
			streamUrl: `/api/sessions/${sessionKey}/stream/${result.runId}`
		});
	} catch (caught) {
		// Surface the real reason (misconfiguration, unreachable Temporal, unknown
		// namespace) instead of a bare 500 — the client renders this message directly.
		const reason =
			caught instanceof Error ? caught.message : 'Failed to reach the session service.';
		throw error(503, reason);
	}
};
