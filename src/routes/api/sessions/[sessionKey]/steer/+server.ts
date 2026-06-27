import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTemporalClient } from '$lib/server/temporal/client';
import { submitSteeringUpdate } from '@src/workflows/session-contracts';
import { isValidSessionKey } from '$lib/server/session-key';

/**
 * POST /api/sessions/[sessionKey]/steer
 *
 * Injects a steering message into the currently active run via the
 * submitSteering session Update. Returns accepted=false (with a reason)
 * when no run is active, rather than erroring.
 */
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
	const handle = client.workflow.getHandle(workflowId);
	const result = await handle.executeUpdate(submitSteeringUpdate, { args: [{ message }] });

	return json(result);
};
