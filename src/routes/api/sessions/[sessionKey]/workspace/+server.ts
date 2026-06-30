import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import {
	artifacts,
	sandboxCommands,
	sandboxSnapshots,
	sandboxes,
	sessions,
	toolInvocations
} from '$lib/server/db/schema';
import type {
	WorkspaceArtifact,
	WorkspaceCommand,
	WorkspaceDiff,
	WorkspaceSnapshot
} from '$lib/components/workspace-panel.svelte';

const IDENTIFIER_RE = /^[\w-]{1,128}$/;

/**
 * Return workspace data for a session: commands, snapshots, artifacts, and diffs.
 *
 * Files are not returned — no persisted file-listing source exists; workspace files
 * are tracked by the sandbox filesystem rather than the database.
 *
 * Diffs are projected from persisted `workspace.diff` tool results. This keeps
 * request handlers read-only and avoids spawning git during UI refresh.
 */
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
		return json({ files: [], commands: [], snapshots: [], artifacts: [], diffs: [] });
	}

	const [commandRows, snapshotRows, artifactRows, diffToolRows] = await Promise.all([
		db
			.select()
			.from(sandboxCommands)
			.where(eq(sandboxCommands.sandboxId, sandbox.id))
			.orderBy(sandboxCommands.createdAt),
		db
			.select()
			.from(sandboxSnapshots)
			.where(eq(sandboxSnapshots.sandboxId, sandbox.id))
			.orderBy(sandboxSnapshots.createdAt),
		db
			.select()
			.from(artifacts)
			.where(eq(artifacts.sessionId, session.id))
			.orderBy(artifacts.createdAt),
		db
			.select()
			.from(toolInvocations)
			.where(eq(toolInvocations.sessionId, session.id))
			.orderBy(toolInvocations.createdAt)
	]);

	const commands: WorkspaceCommand[] = commandRows.map((row) => ({
		id: row.id,
		command: row.command,
		args: parseStringArray(row.args),
		status: row.status,
		exitCode: row.exitCode,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		stdout: row.stdoutRef ?? null,
		stderr: row.stderrRef ?? null
	}));

	const snapshots: WorkspaceSnapshot[] = snapshotRows.map((row) => ({
		id: row.id,
		externalSnapshotId: row.externalSnapshotId,
		reason: row.reason,
		createdAt: row.createdAt
	}));

	const workspaceArtifacts: WorkspaceArtifact[] = artifactRows.map((row) => ({
		id: row.id,
		objectKey: row.objectKey,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		createdAt: row.createdAt
	}));

	const diffs: WorkspaceDiff[] = diffToolRows
		.filter((row) => row.toolName === 'workspace.diff')
		.flatMap((row, index) => {
			const parsed = parseWorkspaceDiff(row.resultInline);
			if (!parsed || !parsed.patch) return [];
			return [
				{
					fromSnapshotId: parsed.base ?? 'working-tree',
					toSnapshotId: parsed.head ?? 'working-tree',
					patch: parsed.patch,
					createdAt: row.completedAt ?? row.createdAt,
					fileName: parsed.path ?? undefined,
					stepRef: { number: index + 1, name: row.toolName }
				}
			];
		});

	return json({ files: [], commands, snapshots, artifacts: workspaceArtifacts, diffs });
};

function parseStringArray(value: string | null | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: [];
	} catch {
		return [];
	}
}

function parseWorkspaceDiff(value: string | null | undefined): {
	base?: string;
	head?: string | null;
	path?: string | null;
	patch?: string;
} | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		return {
			base: typeof record.base === 'string' ? record.base : undefined,
			head: typeof record.head === 'string' ? record.head : null,
			path: typeof record.path === 'string' ? record.path : null,
			patch: typeof record.patch === 'string' ? record.patch : undefined
		};
	} catch {
		return null;
	}
}
