import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { artifacts, sessions, toolInvocations } from '$lib/server/db/schema';
import { LocalArtifactStore } from '$lib/server/artifacts/local-artifact-store';
import type { ArtifactListItem } from '$lib/types';

const store = new LocalArtifactStore();

/**
 * List artifacts across every session, newest first, with display context
 * (owning session, producing tool) and a tokenized download URL. Read-only
 * aggregation over the artifacts table.
 */
export const GET: RequestHandler = async () => {
	const rows = await db
		.select({
			id: artifacts.id,
			runId: artifacts.runId,
			objectKey: artifacts.objectKey,
			mimeType: artifacts.mimeType,
			sizeBytes: artifacts.sizeBytes,
			createdAt: artifacts.createdAt,
			sessionKey: sessions.sessionKey,
			sessionName: sessions.name,
			toolName: toolInvocations.toolName
		})
		.from(artifacts)
		.leftJoin(sessions, eq(artifacts.sessionId, sessions.id))
		.leftJoin(toolInvocations, eq(artifacts.toolCallId, toolInvocations.toolCallId))
		.orderBy(desc(artifacts.createdAt));

	const items: ArtifactListItem[] = await Promise.all(
		rows.map(async (row) => ({
			id: row.id,
			sessionKey: row.sessionKey,
			sessionName: row.sessionName,
			runId: row.runId,
			toolName: row.toolName,
			objectKey: row.objectKey,
			mimeType: row.mimeType,
			sizeBytes: row.sizeBytes,
			createdAt: row.createdAt,
			downloadUrl: await store.getSignedUrl({
				artifactId: row.id,
				objectKey: row.objectKey,
				storageProvider: 'local'
			})
		}))
	);

	return json({ artifacts: items });
};
