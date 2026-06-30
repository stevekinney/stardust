import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { MemoryStore } from '$lib/server/memory/memory-store';

/** List all confirmed memory notes and unconfirmed candidates across all sessions. */
export const GET: RequestHandler = async () => {
	const store = new MemoryStore(db);
	const [notes, candidates] = await Promise.all([store.listAll(), store.listAllCandidates()]);
	return json({ notes, candidates });
};
