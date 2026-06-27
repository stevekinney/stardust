/**
 * GET /api/artifacts/[artifactId]?token={opaqueToken}
 *
 * Streams a local artifact file to the browser after verifying the opaque HMAC
 * token produced by `LocalArtifactStore.getSignedUrl`. No public bucket exists
 * in the POC; this route is the download path for all artifact URLs.
 *
 * Token is passed as a URL query parameter `token`. The token encodes:
 *   - `artifactId` — must match the route parameter.
 *   - `exp`        — Unix expiry timestamp; requests after expiry are rejected.
 *
 * Error responses:
 *   - 400 — invalid artifactId format.
 *   - 401 — missing, malformed, tampered, or expired token.
 *   - 404 — artifact not found in the database or on disk.
 */

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { artifacts } from '$lib/server/db/schema';
import { verifyToken } from '$lib/server/artifacts/token';
import { LocalArtifactStore } from '$lib/server/artifacts/local-artifact-store';
import { ARTIFACT_TOKEN_SECRET } from '$lib/server/config';

/** Allow UUID v4/v7 and simple slug forms used in tests. */
const ARTIFACT_ID_RE = /^[\w-]{1,128}$/;

const store = new LocalArtifactStore();

export const GET: RequestHandler = async ({ params, url }) => {
	const { artifactId } = params;

	if (!ARTIFACT_ID_RE.test(artifactId)) {
		error(400, 'Invalid artifactId');
	}

	const token = url.searchParams.get('token');
	if (!token) {
		error(401, 'Missing token');
	}

	const verification = verifyToken(token, ARTIFACT_TOKEN_SECRET);
	if (!verification.valid) {
		error(401, `Token ${verification.reason}`);
	}
	if (verification.artifactId !== artifactId) {
		error(401, 'Token does not match artifactId');
	}

	const rows = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);

	const artifact = rows[0];
	if (!artifact) {
		error(404, 'Artifact not found');
	}

	const stream = await store.getObject({
		artifactId: artifact.id,
		objectKey: artifact.objectKey,
		storageProvider: 'local'
	});

	// Convert the Node.js ReadableStream to a Web ReadableStream for SvelteKit.
	const webStream = new ReadableStream({
		start(controller) {
			stream.on('data', (chunk: Buffer | string) => {
				controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			});
			stream.on('end', () => {
				controller.close();
			});
			stream.on('error', (err: Error) => {
				if (err.message.includes('ENOENT')) {
					// File missing from disk despite DB row — treat as 404.
					controller.error(
						Object.assign(new Error('Artifact file not found on disk'), { status: 404 })
					);
				} else {
					controller.error(err);
				}
			});
		},
		cancel() {
			// Destroy the underlying fs stream to release the file handle.
			if ('destroy' in stream && typeof (stream as { destroy(): void }).destroy === 'function') {
				(stream as { destroy(): void }).destroy();
			}
		}
	});

	return new Response(webStream, {
		headers: {
			'Content-Type': artifact.mimeType,
			'Content-Length': String(artifact.sizeBytes),
			// Prevent caching of opaque-token URLs; tokens are short-lived.
			'Cache-Control': 'no-store'
		}
	});
};
