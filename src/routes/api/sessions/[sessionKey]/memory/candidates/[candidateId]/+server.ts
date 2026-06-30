import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { MemoryStore, type MemoryCandidate } from '$lib/server/memory/memory-store';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

function getSession(sessionKey: string) {
	if (!IDENTIFIER_RE.test(sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}
	return db
		.select()
		.from(sessions)
		.where(eq(sessions.sessionKey, sessionKey))
		.limit(1)
		.then((rows) => {
			if (!rows[0]) throw error(404, 'Session not found');
			return rows[0];
		});
}

async function findCandidate(sessionId: string, candidateId: string): Promise<MemoryCandidate> {
	const store = new MemoryStore(db);
	const candidate = await store.findCandidateById(sessionId, candidateId);
	if (!candidate) {
		throw error(404, 'Candidate not found');
	}
	return candidate;
}

/** Confirm (approve) a memory candidate — promotes it to a durable note. */
export const POST: RequestHandler = async ({ params }) => {
	const session = await getSession(params.sessionKey);
	const candidate = await findCandidate(session.id, params.candidateId);
	const store = new MemoryStore(db);
	const note = await store.confirmCandidate(candidate);
	return json({ note });
};

/** Discard a memory candidate — removes it from the pending queue. */
export const DELETE: RequestHandler = async ({ params }) => {
	const session = await getSession(params.sessionKey);
	const store = new MemoryStore(db);
	const discarded = await store.discardCandidate(session.id, params.candidateId);
	if (!discarded) throw error(404, 'Candidate not found');
	return json({ discarded: true });
};
