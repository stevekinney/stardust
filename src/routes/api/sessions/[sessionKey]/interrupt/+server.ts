import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTemporalClient } from '$lib/server/temporal/client';
import { interruptRunUpdate } from '@src/workflows/session-contracts';
import { isValidSessionKey } from '$lib/server/session-key';

/**
 * POST /api/sessions/[sessionKey]/interrupt
 *
 * Interrupts the currently active run via the interruptRun session Update.
 * Optionally accepts a replacement message to queue as the next turn.
 * Returns interrupted=false when no run is active.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const { sessionKey } = params;

	if (!isValidSessionKey(sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}

	const body = await request.json().catch(() => ({}));
	const replacement = typeof body?.replacement === 'string' ? body.replacement.trim() : undefined;

	const client = await getTemporalClient();
	const workflowId = `agent-session:${sessionKey}`;
	const handle = client.workflow.getHandle(workflowId);
	const result = await handle.executeUpdate(interruptRunUpdate, {
		args: [{ replacement: replacement || undefined }]
	});

	return json(result);
};
