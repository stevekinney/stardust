import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getToolManifest } from '$lib/server/tools/registry';

/**
 * Lists the agent's currently configured tools (name, description, risk level).
 * Backs the in-composer `/tools` slash command — read-only, no auth beyond the
 * app's existing session boundary.
 */
export const GET: RequestHandler = async () => {
	const tools = getToolManifest().map((tool) => ({
		name: tool.name,
		description: tool.description,
		risk: tool.metadata.risk
	}));

	return json({ tools });
};
