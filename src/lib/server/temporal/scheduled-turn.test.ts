/**
 * Regression tests for the scheduled session key format.
 *
 * The old format `scheduled:${scheduleId}` contained a colon, which is
 * forbidden by the canonical session key validator and by the sandbox session
 * key pattern.  Any scheduled session that reached a workspace or shell-backed
 * tool would throw SandboxSessionKeyError.
 *
 * These tests verify that the new `sched-${scheduleId}` format satisfies:
 *  - The canonical session key format
 *  - sandboxNameForSession (would previously have thrown)
 *  - workspacePathForSession (would previously have thrown)
 */

import { describe, expect, it } from 'vitest';
import { getScheduledSessionKey } from './scheduled-turn';
import { isValidSessionKey } from '../session-key';
import { sandboxNameForSession, workspacePathForSession } from '../sandbox/sandbox-names';

/** A representative schedule ID as minted by createScheduleId(). */
const EXAMPLE_SCHEDULE_ID = 'schedule-550e8400-e29b-41d4-a716-446655440000';

describe('getScheduledSessionKey', () => {
	it('returns a key with the sched- prefix', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(key).toBe(`sched-${EXAMPLE_SCHEDULE_ID}`);
	});

	it('satisfies the canonical session key format', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(isValidSessionKey(key)).toBe(true);
	});

	it('does NOT contain a colon (the old format was path/sandbox-unsafe)', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(key).not.toContain(':');
	});

	it('round-trips: the scheduleId can be recovered by stripping the sched- prefix', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		const recovered = key.slice('sched-'.length);
		expect(recovered).toBe(EXAMPLE_SCHEDULE_ID);
	});
});

describe('sandbox safety for scheduled session keys', () => {
	it('sandboxNameForSession does not throw for a scheduled session key', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(() => sandboxNameForSession(key)).not.toThrow();
	});

	it('sandboxNameForSession returns the expected sandbox name', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(sandboxNameForSession(key)).toBe(`sd-${key}`);
	});

	it('workspacePathForSession does not throw for a scheduled session key', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		expect(() => workspacePathForSession('/workspace/root', key)).not.toThrow();
	});

	it('workspacePathForSession returns a path under the workspace root', () => {
		const key = getScheduledSessionKey(EXAMPLE_SCHEDULE_ID);
		const path = workspacePathForSession('/workspace/root', key);
		expect(path).toBe(`/workspace/root/${key}`);
	});
});
