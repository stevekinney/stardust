/**
 * ArtifactStore — abstract interface for storing and retrieving binary artifacts.
 *
 * In the POC only LocalArtifactStore ships. The interface keeps R2/S3 addable later
 * without changing callers or Workflow code.
 */

export type StorageProvider = 'local';

/** Stable reference to a stored artifact. */
export type ArtifactRef = {
	artifactId: string;
	objectKey: string;
	storageProvider: StorageProvider;
};

/** Input for persisting a new artifact object. */
export type PutObjectInput = {
	/** Globally unique ID for this artifact (UUIDv7 recommended). */
	artifactId: string;
	/**
	 * Object key — callers are responsible for uniqueness and path safety.
	 * Recommended shape: `sessions/{sessionKey}/runs/{runId}/artifacts/{artifactId}`.
	 */
	objectKey: string;
	/** Raw content to persist. */
	content: Buffer | string;
	/** MIME type, e.g. `text/plain` or `application/octet-stream`. */
	mimeType: string;
};

/** Options for generating a signed/opaque download URL. */
export type SignedUrlOptions = {
	/** How long the URL should remain valid. Defaults to 3600 seconds (1 hour). */
	expiresInSeconds?: number;
};

/**
 * ArtifactStore abstracts the backend for artifact persistence.
 *
 * For the local POC, `getSignedUrl` degrades to an opaque HMAC token URL
 * served by the SvelteKit route `/api/artifacts/[artifactId]`.
 */
export interface ArtifactStore {
	/**
	 * Write content under `objectKey` and return a stable ref.
	 * Creating an artifact with an existing `artifactId` overwrites the file.
	 */
	putObject(input: PutObjectInput): Promise<ArtifactRef>;

	/**
	 * Read the artifact as a Node.js Readable stream.
	 * Callers are responsible for consuming or destroying the stream.
	 */
	getObject(ref: ArtifactRef): Promise<NodeJS.ReadableStream>;

	/**
	 * Return an opaque URL that grants short-lived access to the artifact.
	 * For LocalArtifactStore this is `/api/artifacts/{artifactId}?token={hmacToken}`.
	 */
	getSignedUrl(ref: ArtifactRef, options?: SignedUrlOptions): Promise<string>;

	/** Remove the artifact file from storage. No-ops if not found. */
	deleteObject(ref: ArtifactRef): Promise<void>;
}
