import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { ApprovalsRepository } from '$lib/server/policy/approvals';

/** List all approval requests across all sessions, pending first then newest first. */
export const GET: RequestHandler = async () => {
	const repository = new ApprovalsRepository(db);
	const approvals = await repository.listAll();
	return json({ approvals });
};
