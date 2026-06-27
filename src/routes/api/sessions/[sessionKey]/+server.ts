import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sessions } from '$lib/server/db/schema';
import { isValidSessionKey } from '$lib/server/session-key';

/**
 * PATCH /api/sessions/[sessionKey]
 *
 * Supported mutations (may be combined in one call):
 *   { name: string }       — rename the session; trimmed, non-empty required
 *   { archived: boolean }  — archive (true) or unarchive (false)
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
	const { sessionKey } = params;

	if (!isValidSessionKey(sessionKey)) {
		throw error(400, 'Invalid sessionKey');
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const record = body as Record<string, unknown>;
	const updates: { name?: string | null; archivedAt?: string | null } = {};

	// Rename
	if ('name' in record) {
		if (typeof record.name !== 'string' || !record.name.trim()) {
			throw error(400, 'name must be a non-empty string');
		}
		updates.name = record.name.trim();
	}

	// Archive / unarchive
	if ('archived' in record) {
		updates.archivedAt = record.archived === true ? new Date().toISOString() : null;
	}

	if (Object.keys(updates).length === 0) {
		throw error(400, 'No actionable fields provided (name or archived)');
	}

	await db.update(sessions).set(updates).where(eq(sessions.sessionKey, sessionKey));

	return json({
		sessionKey,
		...('name' in updates ? { name: updates.name } : {}),
		...('archivedAt' in updates ? { archivedAt: updates.archivedAt } : {})
	});
};
