/**
 * Large-tool-output spill path.
 *
 * When a tool result exceeds `inlineLimit` characters the full output is
 * persisted as a local artifact. The model receives a compact head/tail excerpt
 * plus an artifact reference and byte count so it knows a full result exists
 * and can cite it. The `tool_invocations.resultRef` column is updated with the
 * artifact ID when a database client is provided.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ToolExecutionResult } from '@src/lib/types';
import type { DatabaseClient } from '../db/client';
import { artifacts, toolInvocations } from '../db/schema';
import type { ArtifactStore } from './artifact-store';
import { TOOL_RESULT_INLINE_LIMIT } from '../config';
import { assertValidSessionKey } from '../session-key';

export type SpillOptions = {
	sessionId: string;
	sessionKey: string;
	runId: string;
	toolCallId: string;
	artifactStore: ArtifactStore;
	database?: DatabaseClient;
	/** Override for the inline character limit (defaults to `TOOL_RESULT_INLINE_LIMIT`). */
	inlineLimit?: number;
};

/**
 * Spill a large tool result to a local artifact.
 *
 * If `result.content` (serialized as a string) is within `inlineLimit` characters
 * the result is returned unchanged. Otherwise the full content is written to
 * `artifactStore`, metadata is inserted into the `artifacts` table, and the
 * model receives a compact head/tail excerpt.
 */
export async function spillLargeOutput(
	result: ToolExecutionResult,
	options: SpillOptions
): Promise<ToolExecutionResult> {
	// Guard: the session key becomes a path segment in the artifact object key.
	// Validate here so an unsafe key is caught before any filesystem write.
	assertValidSessionKey(options.sessionKey);

	const inlineLimit = options.inlineLimit ?? TOOL_RESULT_INLINE_LIMIT;
	const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);

	if (text.length <= inlineLimit) return result;

	const artifactId = randomUUID();
	const objectKey = `sessions/${options.sessionKey}/runs/${options.runId}/artifacts/${artifactId}`;
	const contentBuffer = Buffer.from(text, 'utf8');
	const sizeBytes = contentBuffer.byteLength;

	await options.artifactStore.putObject({
		artifactId,
		objectKey,
		content: contentBuffer,
		mimeType: 'text/plain'
	});

	if (options.database) {
		const now = new Date().toISOString();
		await options.database
			.insert(artifacts)
			.values({
				id: artifactId,
				sessionId: options.sessionId,
				runId: options.runId,
				toolCallId: options.toolCallId,
				objectKey,
				storageProvider: 'local',
				mimeType: 'text/plain',
				sizeBytes,
				createdAt: now
			})
			.onConflictDoNothing();

		await options.database
			.update(toolInvocations)
			.set({ resultRef: artifactId })
			.where(eq(toolInvocations.toolCallId, options.toolCallId));
	}

	// Model-facing summary: head/tail excerpt + artifact ref + byte count.
	const excerptChars = Math.floor(inlineLimit / 4);
	const head = text.slice(0, excerptChars);
	const tail = text.slice(-excerptChars);
	const spilledContent =
		`[Output spilled to artifact (${sizeBytes} bytes). Full output available at artifact:${artifactId}]\n\n` +
		`--- head (first ${excerptChars} chars) ---\n${head}\n\n` +
		`--- tail (last ${excerptChars} chars) ---\n${tail}`;

	return {
		...result,
		content: spilledContent,
		metadata: {
			...result.metadata,
			truncated: true,
			originalCharacters: text.length,
			spilledArtifactId: artifactId,
			spilledBytes: sizeBytes
		}
	};
}
