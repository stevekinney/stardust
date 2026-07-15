/**
 * LocalArtifactStore — an ArtifactStore that writes files under a local directory.
 *
 * The storage root defaults to `~/.stardust/artifacts` (or the value of the
 * `ARTIFACT_DIR` environment variable). Each artifact is stored at:
 *
 *   `{storageRoot}/{objectKey}`
 *
 * where `objectKey` is expected to follow the shape:
 *
 *   `sessions/{sessionKey}/runs/{runId}/artifacts/{artifactId}`
 *
 * `getSignedUrl` returns a route-relative URL:
 *
 *   `/api/artifacts/{artifactId}?token={hmacToken}`
 *
 * The token is a stateless HMAC-SHA256 value shared between the web process and
 * the Worker process via `ARTIFACT_TOKEN_SECRET`.
 */

import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ARTIFACT_DIR, ARTIFACT_TOKEN_SECRET, resolveLocalPath } from '../config';
import { mintToken } from './token';
import type {
	ArtifactRef,
	ArtifactStore,
	PutObjectInput,
	SignedUrlOptions
} from './artifact-store';

/** Default signed-URL lifetime in seconds (1 hour). */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

function resolveStorageRoot(root?: string): string {
	return resolveLocalPath(root ?? ARTIFACT_DIR);
}

export class LocalArtifactStore implements ArtifactStore {
	private readonly storageRoot: string;
	private readonly tokenSecret: string;

	constructor(options: { storageRoot?: string; tokenSecret?: string } = {}) {
		this.storageRoot = resolveStorageRoot(options.storageRoot);
		this.tokenSecret = options.tokenSecret ?? ARTIFACT_TOKEN_SECRET;
	}

	/** Absolute path to the artifact file on disk. */
	private filePath(objectKey: string): string {
		const resolved = resolve(join(this.storageRoot, objectKey));
		if (!resolved.startsWith(this.storageRoot)) {
			throw new Error(`Object key escapes storage root: ${objectKey}`);
		}
		return resolved;
	}

	async putObject(input: PutObjectInput): Promise<ArtifactRef> {
		const filePath = this.filePath(input.objectKey);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, input.content);
		return {
			artifactId: input.artifactId,
			objectKey: input.objectKey,
			storageProvider: 'local'
		};
	}

	async getObject(ref: ArtifactRef): Promise<NodeJS.ReadableStream> {
		const filePath = this.filePath(ref.objectKey);
		// createReadStream throws synchronously for missing files only after the
		// stream is opened; returning a stream that immediately errors on read is
		// the standard Node.js contract for fs.createReadStream.
		return createReadStream(filePath);
	}

	async getSignedUrl(ref: ArtifactRef, options: SignedUrlOptions = {}): Promise<string> {
		const expiresInSeconds = options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
		const token = mintToken(ref.artifactId, expiresInSeconds, this.tokenSecret);
		return `/api/artifacts/${encodeURIComponent(ref.artifactId)}?token=${encodeURIComponent(token)}`;
	}

	async deleteObject(ref: ArtifactRef): Promise<void> {
		const filePath = this.filePath(ref.objectKey);
		await rm(filePath, { force: true });
	}
}
