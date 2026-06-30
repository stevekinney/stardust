import { randomUUID } from 'node:crypto';
import { artifacts } from '../db/schema';
import type { DatabaseClient } from '../db/client';
import type { ArtifactStore } from '../artifacts/artifact-store';
import { assertValidSessionKey } from '../session-key';

export type PersistToolArtifactInput = {
	sessionId: string;
	sessionKey: string;
	runId: string;
	toolCallId: string;
	artifactStore: ArtifactStore;
	database?: DatabaseClient;
	content: string | Buffer;
	mimeType: string;
	extension?: string;
};

export async function persistToolArtifact(input: PersistToolArtifactInput) {
	assertValidSessionKey(input.sessionKey);

	const artifactId = randomUUID();
	const suffix = input.extension ? `.${input.extension.replace(/^\./, '')}` : '';
	const objectKey = `sessions/${input.sessionKey}/runs/${input.runId}/artifacts/${artifactId}${suffix}`;
	const content =
		typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;

	await input.artifactStore.putObject({
		artifactId,
		objectKey,
		content,
		mimeType: input.mimeType
	});

	if (input.database) {
		await input.database
			.insert(artifacts)
			.values({
				id: artifactId,
				sessionId: input.sessionId,
				runId: input.runId,
				toolCallId: input.toolCallId,
				objectKey,
				storageProvider: 'local',
				mimeType: input.mimeType,
				sizeBytes: content.byteLength,
				createdAt: new Date().toISOString()
			})
			.onConflictDoNothing();
	}

	const url = await input.artifactStore.getSignedUrl({
		artifactId,
		objectKey,
		storageProvider: 'local'
	});

	return {
		artifactId,
		objectKey,
		mimeType: input.mimeType,
		sizeBytes: content.byteLength,
		url
	};
}
