import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { sessions, transcriptEvents } from '$lib/server/db/schema';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

/**
 * Returns the canonical transcript events for a session in chronological order.
 * Clients use this to rehydrate a conversation view after refresh or on resume.
 */
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

	const events = await db
		.select()
		.from(transcriptEvents)
		.where(eq(transcriptEvents.sessionId, session.id))
		.orderBy(asc(transcriptEvents.createdAt), asc(transcriptEvents.sequence));

	return json({ events });
};
