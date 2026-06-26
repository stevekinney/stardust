import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '../../../../../../../lib/server/db';
import { readRunInspectorProjection } from '../../../../../../../lib/server/observability/projection';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

export const GET: RequestHandler = async ({ params }) => {
	if (!IDENTIFIER_RE.test(params.sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}
	if (!IDENTIFIER_RE.test(params.runId)) {
		throw error(400, 'Invalid runId');
	}

	const projection = await readRunInspectorProjection(db, params.runId);
	if (!projection || projection.run.sessionId !== params.sessionKey) {
		throw error(404, 'Run not found');
	}

	return json(projection);
};
