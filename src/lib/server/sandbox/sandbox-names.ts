import { join, resolve, sep } from 'node:path';
import { SandboxPathError, SandboxSessionKeyError } from './sandbox-errors';

const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertValidSessionKey(sessionKey: string): void {
	if (!SESSION_KEY_PATTERN.test(sessionKey)) {
		throw new SandboxSessionKeyError(sessionKey);
	}
}

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
