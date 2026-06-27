/**
 * Artifact Activities — persist file content + metadata for explicit uploads.
 *
 * The `uploadArtifact` activity is used by the workflow and other activities
 * to store files (screenshots, generated patches, large logs, etc.) under the
 * local artifact store and record their metadata in SQLite.
 *
 * The large-tool-output spill path reuses the same `LocalArtifactStore`
 * directly inside `executeTool` (inline, not as a separate activity call)
 * because the spill result must be returned to the workflow in the same
 * Activity return value.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../lib/server/db/client';
import { artifacts } from '../lib/server/db/schema';
import { getArtifactStore } from '../lib/server/artifacts';
import type { ArtifactRef } from '../lib/server/artifacts';

export type UploadArtifactInput = {
	/** Session the artifact belongs to (used for DB row). */
	sessionId: string;
	/** Session key — used to construct the object key path. */
	sessionKey: string;
	/** Run that produced the artifact. */
	runId: string;
	/** Tool call that produced the artifact, if any. */
	toolCallId?: string;
	/**
	 * Raw content to persist. Strings are written as UTF-8.
	 * Pass a Buffer for binary content.
	 */
	content: string | Buffer;
	/** MIME type, e.g. `text/plain` or `image/png`. */
	mimeType: string;
	/**
	 * Optional caller-supplied artifact ID (UUIDv7 recommended).
	 * A random UUID is generated when omitted.
	 */
	artifactId?: string;
	/** Optional free-form metadata to store in the artifacts row (JSON-serializable). */
	metadata?: Record<string, unknown>;
};

/**
 * Persist a file artifact and its metadata row.
 *
 * Returns a stable `ArtifactRef` that can be passed to `getSignedUrl` or
 * stored on workflow state for later reference.
 */
export async function uploadArtifact(input: UploadArtifactInput): Promise<ArtifactRef> {
	const artifactId = input.artifactId ?? randomUUID();
	const objectKey = `sessions/${input.sessionKey}/runs/${input.runId}/artifacts/${artifactId}`;
	const contentBuffer =
		typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
	const sizeBytes = contentBuffer.byteLength;

	const store = getArtifactStore();
	const ref = await store.putObject({
		artifactId,
		objectKey,
		content: contentBuffer,
		mimeType: input.mimeType
	});

	const now = new Date().toISOString();
	await db
		.insert(artifacts)
		.values({
			id: artifactId,
			sessionId: input.sessionId,
			runId: input.runId,
			toolCallId: input.toolCallId ?? null,
			objectKey,
			storageProvider: 'local',
			mimeType: input.mimeType,
			sizeBytes,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
			createdAt: now
		})
		.onConflictDoNothing();

	return ref;
}
