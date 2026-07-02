import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { MemoryStore } from '$lib/server/memory/memory-store';

/**
 * List all confirmed memory notes and unconfirmed candidates across all
 * sessions. Candidates carry the owning session's key so clients can call the
 * per-session confirm/discard routes.
 */
export const GET: RequestHandler = async () => {
	const store = new MemoryStore(db);
	const [notes, candidates, sessionRows] = await Promise.all([
		store.listAll(),
		store.listAllCandidates(),
		db.select({ id: sessions.id, sessionKey: sessions.sessionKey }).from(sessions)
	]);
	const sessionKeyById = new Map(sessionRows.map((row) => [row.id, row.sessionKey]));
	return json({
		notes,
		candidates: candidates.map((candidate) => ({
			...candidate,
			sessionKey: sessionKeyById.get(candidate.sessionId) ?? null
		}))
	});
};
