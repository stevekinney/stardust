import { join, resolve, sep } from 'node:path';
import { assertValidSessionKey } from '../session-key';
import { SandboxPathError } from './sandbox-errors';

// Re-export so callers that import assertValidSessionKey from the sandbox namespace
// still resolve to the single canonical implementation.
export { assertValidSessionKey } from '../session-key';

export function sandboxNameForSession(sessionKey: string): string {
	assertValidSessionKey(sessionKey);
	return `sd-${sessionKey}`;
}

export function workspacePathForSession(workspaceRoot: string, sessionKey: string): string {
	assertValidSessionKey(sessionKey);
	return join(workspaceRoot, sessionKey);
}

export function resolveWorkspacePath(workspacePath: string, relativePath = '.'): string {
	const resolvedWorkspace = resolve(workspacePath);
	const resolvedPath = resolve(resolvedWorkspace, relativePath);

	if (
		resolvedPath !== resolvedWorkspace &&
		!resolvedPath.startsWith(`${resolvedWorkspace}${sep}`)
	) {
		throw new SandboxPathError(relativePath);
	}

	return resolvedPath;
}
