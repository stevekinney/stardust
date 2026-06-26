import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { RunsRepository } from '$lib/server/db/repositories/runs';
import { eq } from 'drizzle-orm';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

/** List all runs for a session, newest first. */
export const GET: RequestHandler = async ({ params }) => {
	if (!IDENTIFIER_RE.test(params.sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}

	const sessionRows = await db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionKey, params.sessionKey))
		.limit(1);
	const session = sessionRows[0];
	if (!session) {
		throw error(404, 'Session not found');
	}

	const repository = new RunsRepository(db);
	const runs = await repository.findBySessionId(session.id);

	return json({ runs });
};
