import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';

/** List all sessions, newest first. */
export const GET: RequestHandler = async () => {
	const rows = await db.select().from(sessions).orderBy(sessions.updatedAt);
	return json({ sessions: rows });
};
