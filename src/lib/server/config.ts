// Framework-agnostic server configuration — safe to import from Worker (no SvelteKit virtuals).

import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
export const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';
/** Temporal Cloud API key. Unset for the local dev server; presence with a local address is a leak. */
export const TEMPORAL_API_KEY = process.env.TEMPORAL_API_KEY;
export const DATABASE_URL = process.env.DATABASE_URL ?? 'file:~/.stardust/stardust.db';

/** Port the Temporal Web UI is served on. */
export const TEMPORAL_WEB_PORT = process.env.TEMPORAL_WEB_PORT ?? '8233';
/** Base URL of the Temporal Web UI, used to build run-inspector deep links. */
export const TEMPORAL_WEB_URL = `http://localhost:${TEMPORAL_WEB_PORT}`;

// ── Artifact store ────────────────────────────────────────────────────────────

/** Root directory for local artifact storage. Tilde expansion is handled by resolveLocalPath. */
export const ARTIFACT_DIR = process.env.ARTIFACT_DIR ?? '~/.stardust/artifacts';

/** Root directory for local subprocess workspaces. */
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? '~/.stardust/workspaces';

export interface LocalDataPath {
	label: string;
	value: string;
}

interface LocalDataPathConfiguration {
	databaseUrl?: string;
	artifactDirectory?: string;
	workspaceRoot?: string;
}

/** Resolve a configured local path exactly as the storage consumers do. */
export function resolveLocalPath(raw: string): string {
	const path = raw.startsWith('file:') ? raw.slice(5) : raw;
	if (path === '~' || path.startsWith('~/')) {
		return resolve(process.env.HOME ?? homedir(), path === '~' ? '' : path.slice(2));
	}
	return resolve(path);
}

/** Non-secret effective paths safe to expose in Settings route data. */
export function localDataPaths(configuration: LocalDataPathConfiguration = {}): LocalDataPath[] {
	return [
		{ label: 'Database', value: resolveLocalPath(configuration.databaseUrl ?? DATABASE_URL) },
		{
			label: 'Artifacts',
			value: resolveLocalPath(configuration.artifactDirectory ?? ARTIFACT_DIR)
		},
		{ label: 'Workspaces', value: resolveLocalPath(configuration.workspaceRoot ?? WORKSPACE_ROOT) }
	];
}

/**
 * HMAC signing secret shared between the web process and the Worker process.
 * Used to mint and verify opaque artifact download tokens.
 * Override in production; the default is safe only for local development.
 */
export const ARTIFACT_TOKEN_SECRET =
	process.env.ARTIFACT_TOKEN_SECRET ?? 'stardust-local-dev-secret';

/**
 * Maximum byte length of tool output that is returned inline to the model.
 * Output above this threshold is spilled to a local artifact and the model
 * receives a head/tail excerpt plus an artifact reference.
 */
export const TOOL_RESULT_INLINE_LIMIT = parseInt(
	process.env.TOOL_RESULT_INLINE_LIMIT ?? '8000',
	10
);
