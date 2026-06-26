import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { sessions, streamEvents } from '$lib/server/db/schema';
import { MemoryStore, type MemoryCandidate } from '$lib/server/memory/memory-store';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

/** List memory notes and pending candidates for a session. */
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
	const [notes, candidateEvents] = await Promise.all([
		store.listBySession(session.id),
		db
			.select()
			.from(streamEvents)
			.where(and(eq(streamEvents.sessionId, session.id), eq(streamEvents.kind, 'memory.candidate')))
			.orderBy(streamEvents.createdAt)
	]);

	// Dedup: candidates whose id matches an existing note have already been confirmed.
	const confirmedIds = new Set(notes.map((note) => note.id));
	const candidates: MemoryCandidate[] = candidateEvents
		.map((event) => {
			try {
				return JSON.parse(event.payload) as MemoryCandidate;
			} catch {
				return null;
			}
		})
		.filter((candidate): candidate is MemoryCandidate => candidate !== null)
		.filter((candidate) => !confirmedIds.has(candidate.id));

	return json({ notes, candidates });
};
