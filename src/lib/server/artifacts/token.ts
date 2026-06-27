/**
 * Stateless HMAC-SHA256 token for local artifact download authorization.
 *
 * Both the web process (which serves `/api/artifacts/[artifactId]`) and the
 * Worker process (which calls `getSignedUrl` via the artifact store) share the
 * same `ARTIFACT_TOKEN_SECRET`, so tokens minted in either process are
 * verifiable in either. No in-memory store is needed and tokens survive a
 * process restart for their remaining lifetime.
 *
 * Token format (URL-safe base64, dot-separated):
 *   `{base64url(JSON payload)}.{base64url(HMAC-SHA256 of payload)}`
 *
 * Payload: `{ artifactId: string; exp: number }` where `exp` is a Unix
 * timestamp in seconds.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'sha256';

function toBase64Url(value: Buffer | string): string {
	const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
	return buf.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
	return Buffer.from(value, 'base64url');
}

function sign(payload: string, secret: string): string {
	return toBase64Url(createHmac(ALGORITHM, secret).update(payload).digest());
}

type TokenPayload = {
	artifactId: string;
	/** Unix timestamp (seconds) after which the token is invalid. */
	exp: number;
};

/**
 * Mint an opaque HMAC token for the given artifact.
 *
 * @param artifactId - The artifact's primary key.
 * @param expiresInSeconds - Validity window in seconds (default 3600).
 * @param secret - HMAC signing secret.
 */
export function mintToken(artifactId: string, expiresInSeconds: number, secret: string): string {
	const payload: TokenPayload = {
		artifactId,
		exp: Math.floor(Date.now() / 1000) + expiresInSeconds
	};
	const encodedPayload = toBase64Url(JSON.stringify(payload));
	const signature = sign(encodedPayload, secret);
	return `${encodedPayload}.${signature}`;
}

type VerifyResult =
	| { valid: true; artifactId: string }
	| { valid: false; reason: 'malformed' | 'tampered' | 'expired' };

/**
 * Verify an opaque artifact token.
 *
 * Returns `{ valid: true, artifactId }` on success; otherwise a typed failure
 * reason so callers can respond with the right HTTP status.
 */
export function verifyToken(token: string, secret: string): VerifyResult {
	const dotIndex = token.lastIndexOf('.');
	if (dotIndex < 1) return { valid: false, reason: 'malformed' };

	const encodedPayload = token.slice(0, dotIndex);
	const suppliedSig = token.slice(dotIndex + 1);

	// Constant-time comparison to prevent timing attacks.
	const expectedSig = sign(encodedPayload, secret);
	const expectedBuf = fromBase64Url(expectedSig);
	const suppliedBuf = fromBase64Url(suppliedSig);

	if (expectedBuf.length !== suppliedBuf.length || !timingSafeEqual(expectedBuf, suppliedBuf)) {
		return { valid: false, reason: 'tampered' };
	}

	let payload: TokenPayload;
	try {
		payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8')) as TokenPayload;
	} catch {
		return { valid: false, reason: 'malformed' };
	}

	if (Math.floor(Date.now() / 1000) > payload.exp) {
		return { valid: false, reason: 'expired' };
	}

	return { valid: true, artifactId: payload.artifactId };
}
