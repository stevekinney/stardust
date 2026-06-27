import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactStore } from './local-artifact-store';
import { mintToken, verifyToken } from './token';
import { spillLargeOutput } from './spill';
import type { ToolExecutionResult } from '@src/lib/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer | string) => {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		});
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});
}

const TEST_SECRET = 'test-hmac-secret-for-unit-tests';

function makeStore(root: string) {
	return new LocalArtifactStore({ storageRoot: root, tokenSecret: TEST_SECRET });
}

// ── Token unit tests ──────────────────────────────────────────────────────────

describe('artifact token', () => {
	it('mints a token that verifies for the same artifactId', () => {
		const token = mintToken('art-123', 3600, TEST_SECRET);
		const result = verifyToken(token, TEST_SECRET);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.artifactId).toBe('art-123');
		}
	});

	it('rejects a token with a wrong secret', () => {
		const token = mintToken('art-123', 3600, TEST_SECRET);
		const result = verifyToken(token, 'wrong-secret');
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toBe('tampered');
		}
	});

	it('rejects an expired token', () => {
		// expiresInSeconds = -1 means it expired one second ago.
		const token = mintToken('art-expired', -1, TEST_SECRET);
		const result = verifyToken(token, TEST_SECRET);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toBe('expired');
		}
	});

	it('rejects a malformed token with no dot separator', () => {
		const result = verifyToken('not-a-valid-token', TEST_SECRET);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toBe('malformed');
		}
	});

	it('rejects a token with tampered payload', () => {
		const token = mintToken('art-real', 3600, TEST_SECRET);
		// Flip one character in the payload portion.
		const dotIndex = token.lastIndexOf('.');
		const payload = token.slice(0, dotIndex);
		const sig = token.slice(dotIndex + 1);
		const lastChar = payload.slice(-1);
		const tampered = payload.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
		const result = verifyToken(`${tampered}.${sig}`, TEST_SECRET);
		expect(result.valid).toBe(false);
	});
});

// ── LocalArtifactStore tests ─────────────────────────────────────────────────

describe('LocalArtifactStore', () => {
	let tmpDir: string;
	let store: LocalArtifactStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'artifact-test-'));
		store = makeStore(tmpDir);
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('round-trips a string artifact', async () => {
		const ref = await store.putObject({
			artifactId: 'art-001',
			objectKey: 'sessions/s1/runs/r1/artifacts/art-001',
			content: 'hello world',
			mimeType: 'text/plain'
		});

		expect(ref.artifactId).toBe('art-001');
		expect(ref.storageProvider).toBe('local');

		const stream = await store.getObject(ref);
		const buf = await readAll(stream);
		expect(buf.toString('utf8')).toBe('hello world');
	});

	it('round-trips a Buffer artifact', async () => {
		const content = Buffer.from([0x00, 0x01, 0x02, 0xff]);
		const ref = await store.putObject({
			artifactId: 'art-002',
			objectKey: 'sessions/s1/runs/r1/artifacts/art-002',
			content,
			mimeType: 'application/octet-stream'
		});

		const stream = await store.getObject(ref);
		const buf = await readAll(stream);
		expect(buf).toEqual(content);
	});

	it('overwrites an existing artifact on a second put', async () => {
		const objectKey = 'sessions/s1/runs/r1/artifacts/art-003';
		await store.putObject({
			artifactId: 'art-003',
			objectKey,
			content: 'v1',
			mimeType: 'text/plain'
		});
		await store.putObject({
			artifactId: 'art-003',
			objectKey,
			content: 'v2',
			mimeType: 'text/plain'
		});

		const ref = { artifactId: 'art-003', objectKey, storageProvider: 'local' as const };
		const buf = await readAll(await store.getObject(ref));
		expect(buf.toString('utf8')).toBe('v2');
	});

	it('creates intermediate directories for nested object keys', async () => {
		await expect(
			store.putObject({
				artifactId: 'art-deep',
				objectKey: 'sessions/s1/runs/r1/artifacts/art-deep',
				content: 'deep content',
				mimeType: 'text/plain'
			})
		).resolves.toBeDefined();
	});

	it('deleteObject removes the file from disk', async () => {
		const ref = await store.putObject({
			artifactId: 'art-004',
			objectKey: 'sessions/s1/runs/r1/artifacts/art-004',
			content: 'to be deleted',
			mimeType: 'text/plain'
		});

		await store.deleteObject(ref);

		// After deletion, getObject returns a stream that errors on read.
		const stream = await store.getObject(ref);
		await expect(readAll(stream)).rejects.toThrow();
	});

	it('deleteObject is a no-op for a non-existent artifact', async () => {
		await expect(
			store.deleteObject({
				artifactId: 'missing',
				objectKey: 'sessions/s1/runs/r1/artifacts/missing',
				storageProvider: 'local'
			})
		).resolves.toBeUndefined();
	});

	it('getSignedUrl returns a URL with artifact ID and token query param', async () => {
		const ref = await store.putObject({
			artifactId: 'art-005',
			objectKey: 'sessions/s1/runs/r1/artifacts/art-005',
			content: 'signed',
			mimeType: 'text/plain'
		});

		const url = await store.getSignedUrl(ref, { expiresInSeconds: 3600 });
		expect(url).toMatch(/^\/api\/artifacts\/art-005\?token=/);

		// Extract token and verify it.
		const tokenParam = new URL(url, 'http://localhost').searchParams.get('token');
		expect(tokenParam).toBeTruthy();
		const verification = verifyToken(tokenParam!, TEST_SECRET);
		expect(verification.valid).toBe(true);
		if (verification.valid) {
			expect(verification.artifactId).toBe('art-005');
		}
	});

	it('rejects object keys that escape the storage root', () => {
		// Access the private method for test purposes via type cast.
		const privateStore = store as unknown as { filePath(key: string): string };
		expect(() => privateStore.filePath('../etc/passwd')).toThrow(/escapes storage root/);
	});

	it('getObject rejects with ENOENT when the artifact file does not exist', async () => {
		const stream = await store.getObject({
			artifactId: 'missing-file',
			objectKey: 'sessions/s1/runs/r1/artifacts/missing-file',
			storageProvider: 'local'
		});
		// createReadStream surfaces ENOENT as a stream error event, not a sync throw.
		// Consuming the stream via readAll lets us assert the rejection.
		await expect(readAll(stream)).rejects.toThrow();
	});
});

// ── Spill path tests ──────────────────────────────────────────────────────────

describe('spillLargeOutput', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'spill-test-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function makeBaseResult(content: string): ToolExecutionResult {
		return { callId: 'call-1', toolName: 'shell.exec', outcome: 'success', content };
	}

	it('returns the result unchanged when content is within the inline limit', async () => {
		const store = makeStore(tmpDir);
		const smallContent = 'A'.repeat(100);
		const result = await spillLargeOutput(makeBaseResult(smallContent), {
			sessionId: 'session-id-1',
			sessionKey: 'session-key-1',
			runId: 'run-1',
			toolCallId: 'call-1',
			artifactStore: store,
			inlineLimit: 8_000
		});

		expect(result.content).toBe(smallContent);
		expect(result.metadata?.truncated).toBeUndefined();
		expect(result.metadata?.spilledArtifactId).toBeUndefined();
	});

	it('spills large output to an artifact and returns an excerpt', async () => {
		const store = makeStore(tmpDir);
		const largeContent = 'X'.repeat(10_000);
		const result = await spillLargeOutput(makeBaseResult(largeContent), {
			sessionId: 'session-id-1',
			sessionKey: 'session-key-1',
			runId: 'run-1',
			toolCallId: 'call-1',
			artifactStore: store,
			inlineLimit: 8_000
		});

		expect(result.metadata?.truncated).toBe(true);
		expect(result.metadata?.originalCharacters).toBe(10_000);
		expect(result.metadata?.spilledArtifactId).toBeTypeOf('string');
		expect(result.metadata?.spilledBytes).toBeTypeOf('number');

		// Model-facing content includes artifact reference and head/tail labels.
		expect(typeof result.content).toBe('string');
		const content = result.content as string;
		expect(content).toContain(`artifact:${result.metadata?.spilledArtifactId as string}`);
		expect(content).toContain('head');
		expect(content).toContain('tail');
	});

	it('persists the full artifact content to disk', async () => {
		const store = makeStore(tmpDir);
		const largeContent = 'Y'.repeat(10_000);
		const result = await spillLargeOutput(makeBaseResult(largeContent), {
			sessionId: 'sid',
			sessionKey: 'skey',
			runId: 'rid',
			toolCallId: 'cid',
			artifactStore: store,
			inlineLimit: 8_000
		});

		const artifactId = result.metadata?.spilledArtifactId as string;
		const objectKey = `sessions/skey/runs/rid/artifacts/${artifactId}`;
		const stream = await store.getObject({ artifactId, objectKey, storageProvider: 'local' });
		const buf = await readAll(stream);
		expect(buf.toString('utf8')).toBe(largeContent);
	});

	it('handles object content that serializes above the limit', async () => {
		const store = makeStore(tmpDir);
		// An object that when JSON-stringified exceeds the limit.
		const bigObj = { data: 'Z'.repeat(9_000) };
		const result = await spillLargeOutput(
			{ callId: 'call-2', toolName: 'web.fetch', outcome: 'success', content: bigObj },
			{
				sessionId: 'sid',
				sessionKey: 'skey',
				runId: 'rid',
				toolCallId: 'call-2',
				artifactStore: store,
				inlineLimit: 8_000
			}
		);

		expect(result.metadata?.truncated).toBe(true);
	});
});
