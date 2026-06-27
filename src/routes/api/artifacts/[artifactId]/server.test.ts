/**
 * Unit tests for GET /api/artifacts/[artifactId].
 *
 * The route handler is imported directly. Dependencies (db, config, local store)
 * are mocked so the test suite is fast and hermetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { mintToken } from '$lib/server/artifacts/token';
import { GET } from './+server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const TEST_SECRET = 'route-test-hmac-secret';

vi.mock('$lib/server/config', () => ({
	ARTIFACT_TOKEN_SECRET: 'route-test-hmac-secret'
}));

// db mock — select().from().where().limit() resolves to whatever dbRows holds.
let dbRows: Array<{ id: string; objectKey: string; mimeType: string; sizeBytes: number }> = [];

vi.mock('$lib/server/db/client', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(dbRows)
				})
			})
		})
	}
}));

// LocalArtifactStore mock — getObject is a vi.fn() we control per test.
const mockGetObject = vi.fn();

vi.mock('$lib/server/artifacts/local-artifact-store', () => ({
	LocalArtifactStore: class {
		getObject(...args: unknown[]) {
			return mockGetObject(...args);
		}
	}
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(artifactId: string, token?: string): Parameters<typeof GET>[0] {
	const urlStr = token
		? `http://localhost/api/artifacts/${artifactId}?token=${encodeURIComponent(token)}`
		: `http://localhost/api/artifacts/${artifactId}`;

	return {
		params: { artifactId },
		url: new URL(urlStr),
		request: new Request(urlStr)
	} as Parameters<typeof GET>[0];
}

function readableFrom(content: string): NodeJS.ReadableStream {
	return Readable.from([Buffer.from(content, 'utf8')]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/artifacts/[artifactId]', () => {
	beforeEach(() => {
		dbRows = [];
		mockGetObject.mockReset();
	});

	it('returns 401 when no token query parameter is provided', async () => {
		await expect(GET(makeRequest('art-123'))).rejects.toMatchObject({ status: 401 });
	});

	it('returns 401 for an expired token', async () => {
		const expired = mintToken('art-123', -1, TEST_SECRET);
		await expect(GET(makeRequest('art-123', expired))).rejects.toMatchObject({ status: 401 });
	});

	it('returns 401 when token artifactId does not match the route parameter', async () => {
		const token = mintToken('art-DIFFERENT', 3600, TEST_SECRET);
		await expect(GET(makeRequest('art-123', token))).rejects.toMatchObject({ status: 401 });
	});

	it('returns 401 for a tampered token', async () => {
		const token = mintToken('art-123', 3600, TEST_SECRET);
		// Corrupt the signature portion.
		const lastDot = token.lastIndexOf('.');
		const tampered = `${token.slice(0, lastDot)}.invalidsignature`;
		await expect(GET(makeRequest('art-123', tampered))).rejects.toMatchObject({ status: 401 });
	});

	it('returns 400 for an artifactId that fails the format guard', async () => {
		// Slashes are not allowed in artifactId — they would escape the route segment.
		const token = mintToken('../../etc/passwd', 3600, TEST_SECRET);
		await expect(GET(makeRequest('../../etc/passwd', token))).rejects.toMatchObject({
			status: 400
		});
	});

	it('returns 404 when the artifact is not in the database', async () => {
		dbRows = [];
		const token = mintToken('art-missing', 3600, TEST_SECRET);
		await expect(GET(makeRequest('art-missing', token))).rejects.toMatchObject({ status: 404 });
	});

	it('streams artifact content with correct headers for a valid request', async () => {
		const artifactId = 'art-valid-001';
		const content = 'hello artifact';

		dbRows = [
			{
				id: artifactId,
				objectKey: `sessions/s1/runs/r1/artifacts/${artifactId}`,
				mimeType: 'text/plain',
				sizeBytes: Buffer.byteLength(content)
			}
		];

		mockGetObject.mockResolvedValueOnce(readableFrom(content));

		const token = mintToken(artifactId, 3600, TEST_SECRET);
		const response = await GET(makeRequest(artifactId, token));

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(content)));

		const body = await response.text();
		expect(body).toBe(content);
	});

	it('passes the correct ArtifactRef to getObject', async () => {
		const artifactId = 'art-ref-check';
		const objectKey = `sessions/s1/runs/r1/artifacts/${artifactId}`;

		dbRows = [{ id: artifactId, objectKey, mimeType: 'application/json', sizeBytes: 2 }];
		mockGetObject.mockResolvedValueOnce(readableFrom('{}'));

		const token = mintToken(artifactId, 3600, TEST_SECRET);
		await GET(makeRequest(artifactId, token));

		expect(mockGetObject).toHaveBeenCalledWith({
			artifactId,
			objectKey,
			storageProvider: 'local'
		});
	});
});
