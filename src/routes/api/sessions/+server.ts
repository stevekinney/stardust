import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { mintSessionKey } from '$lib/server/session-key';

/** List all non-archived sessions, newest first. */
export const GET: RequestHandler = async () => {
	const rows = await db
		.select()
		.from(sessions)
		.where(isNull(sessions.archivedAt))
		.orderBy(desc(sessions.updatedAt));
	return json({ sessions: rows });
};

/**
 * Mint a new session key on the server.
 *
 * The browser must call this endpoint instead of generating a session key
 * client-side.  Sessions are created lazily — the first turn submitted via
 * POST /api/sessions/{sessionKey}/turn starts the workflow.  This endpoint
 * only allocates a canonical, safe key.
 */
export const POST: RequestHandler = async () => {
	const sessionKey = mintSessionKey();
	return json({ sessionKey }, { status: 201 });
};
