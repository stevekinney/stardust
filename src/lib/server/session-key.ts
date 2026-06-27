/**
 * Canonical session key utilities.
 *
 * A session key must be:
 *   - URL-safe  (no `%`, `?`, `#`, or other reserved URL characters)
 *   - Path-safe (no `/`, `\`, `.`, or `..` components)
 *   - Artifact-key-safe (same as path-safe — keys become path segments under the artifact root)
 *   - Sandbox-name-safe (must start with an alphanumeric character; `sd-{sessionKey}` stays valid)
 *
 * Accepted format: `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`
 *   - Starts with a letter or digit (satisfies sandbox-name prefix requirement).
 *   - Subsequent characters may be letters, digits, underscores, or hyphens.
 *   - Maximum 128 characters total.
 *
 * Minting strategy: `mintSessionKey()` returns a UUIDv4 produced by
 * `node:crypto`'s `randomUUID()`. No external uuid library is required —
 * UUIDv7 was considered but the project has no uuidv7 dependency, and UUIDv4
 * satisfies all format constraints (hex digits 0–9 a–f plus hyphens, starts
 * with a hex digit). If UUIDv7 is added in a future task its output will also
 * satisfy `SESSION_KEY_RE` and `mintSessionKey()` can be updated in-place.
 *
 * Scheduled session keys follow the mapping `sched-{scheduleId}`.  The colon
 * historically used (`scheduled:{scheduleId}`) is path-unsafe and
 * sandbox-unsafe.  The `sched-` prefix round-trips: given a key starting with
 * `sched-`, the originating scheduleId is `key.slice('sched-'.length)`.
 */

import { randomUUID } from 'node:crypto';

/** The single accepted session key pattern, enforced across all code paths. */
export const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Returns `true` when `key` satisfies the canonical session key format.
 */
export function isValidSessionKey(key: string): boolean {
	return SESSION_KEY_RE.test(key);
}

/**
 * Throws an `Error` when `key` does not satisfy the canonical session key format.
 * Call this at every code path that receives a session key from an untrusted source.
 */
export function assertValidSessionKey(key: string): void {
	if (!SESSION_KEY_RE.test(key)) {
		throw new Error(`Invalid session key: ${JSON.stringify(key)}`);
	}
}

/**
 * Mints a new session key on the server.
 *
 * Returns a UUIDv4 string (e.g. `"550e8400-e29b-41d4-a716-446655440000"`).
 * UUIDv4 keys are 36 characters long, start with a hex digit, and contain only
 * hex digits and hyphens — all of which satisfy `SESSION_KEY_RE`.
 */
export function mintSessionKey(): string {
	return randomUUID();
}
