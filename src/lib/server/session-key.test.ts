import { describe, expect, it } from 'vitest';
import {
	assertValidSessionKey,
	isValidSessionKey,
	mintSessionKey,
	SESSION_KEY_RE
} from './session-key';

describe('SESSION_KEY_RE', () => {
	it.each([
		// UUIDv4 produced by crypto.randomUUID()
		['550e8400-e29b-41d4-a716-446655440000', true],
		// Typical interactive session key (UUID)
		['a1b2c3d4-e5f6-7890-abcd-ef1234567890', true],
		// Scheduled session key format: sched-{scheduleId}
		['sched-schedule-550e8400-e29b-41d4-a716-446655440000', true],
		// Alphanumeric only
		['abc123', true],
		// With underscores and hyphens
		['my_session-001', true],
		// Single character (minimum length)
		['a', true],
		// 128 characters (maximum length)
		['a'.repeat(128), true],
		// Starts with digit
		['0abc', true]
	])('accepts %s → %s', (key, expected) => {
		expect(isValidSessionKey(key)).toBe(expected);
	});

	it.each([
		// Empty string
		['', false],
		// Colon (was used in legacy scheduled: prefix)
		['scheduled:schedule-001', false],
		// Path traversal
		['../../evil', false],
		// Leading slash
		['/etc/passwd', false],
		// Leading underscore (does not start with alphanumeric)
		['_leading-underscore', false],
		// 129 characters (one over the limit)
		['a'.repeat(129), false],
		// Contains dot
		['my.session', false],
		// Contains space
		['my session', false],
		// Contains percent-encoding
		['my%20session', false],
		// Null byte
		['bad\x00key', false]
	])('rejects %s → %s', (key, expected) => {
		expect(isValidSessionKey(key)).toBe(expected);
	});
});

describe('assertValidSessionKey', () => {
	it('does not throw for a valid key', () => {
		expect(() => assertValidSessionKey('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
	});

	it('throws for a key with a colon (the legacy scheduled: format)', () => {
		expect(() => assertValidSessionKey('scheduled:schedule-001')).toThrow(/Invalid session key/);
	});

	it('throws for path traversal keys', () => {
		expect(() => assertValidSessionKey('../../etc/passwd')).toThrow(/Invalid session key/);
	});

	it('throws for an empty key', () => {
		expect(() => assertValidSessionKey('')).toThrow(/Invalid session key/);
	});
});

describe('mintSessionKey', () => {
	it('returns a string satisfying SESSION_KEY_RE', () => {
		const key = mintSessionKey();
		expect(SESSION_KEY_RE.test(key)).toBe(true);
	});

	it('returns a different key on each call', () => {
		const keys = new Set(Array.from({ length: 10 }, () => mintSessionKey()));
		expect(keys.size).toBe(10);
	});

	it('returns a UUIDv4-shaped string (32 hex digits with 4 hyphens)', () => {
		const key = mintSessionKey();
		expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
