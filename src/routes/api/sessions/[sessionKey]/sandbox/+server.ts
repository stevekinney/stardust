import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { sandboxCommands, sandboxSnapshots, sandboxes, sessions } from '$lib/server/db/schema';
import { asc, desc, eq } from 'drizzle-orm';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;
const RECENT_COMMANDS_LIMIT = 20;

/** Return sandbox info, recent commands, and snapshots for a session. */
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

	const sandboxRows = await db
		.select()
		.from(sandboxes)
		.where(eq(sandboxes.sessionId, session.id))
		.limit(1);
	const sandbox = sandboxRows[0] ?? null;

	if (!sandbox) {
		return json({ sandbox: null, commands: [], snapshots: [] });
	}

	const [commands, snapshots] = await Promise.all([
		db
			.select()
			.from(sandboxCommands)
			.where(eq(sandboxCommands.sandboxId, sandbox.id))
			.orderBy(desc(sandboxCommands.createdAt))
			.limit(RECENT_COMMANDS_LIMIT),
		db
			.select()
			.from(sandboxSnapshots)
			.where(eq(sandboxSnapshots.sandboxId, sandbox.id))
			.orderBy(asc(sandboxSnapshots.createdAt))
	]);

	return json({ sandbox, commands, snapshots });
};
