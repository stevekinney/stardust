import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { MemoryStore } from '$lib/server/memory/memory-store';
import { eq } from 'drizzle-orm';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

/** List memory notes for a session, grouped by layer. */
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

	const store = new MemoryStore(db);
	const notes = await store.listBySession(session.id);

	return json({ notes });
};
