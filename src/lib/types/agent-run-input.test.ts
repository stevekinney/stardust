/**
 * Type-level regression tests for AgentRunInput.
 *
 * The type-error suppression directive below is load-bearing: it is validated
 * by svelte-check at typecheck time. If someone adds a `toolCalls` field to
 * AgentRunInput the error disappears, the directive becomes unused, and
 * svelte-check fails — catching the regression that broke the chaos.ts
 * crash/resume demo.
 *
 * See: scripts/devtools/chaos.ts — chaos recovery demo
 *      src/lib/types/index.ts — AgentRunInput definition
 */
import { describe, expect, it } from 'vitest';
import type { AgentRunInput } from '$lib/types';

describe('AgentRunInput contract', () => {
	it('rejects a toolCalls field (excess-property guard for chaos.ts regression)', () => {
		// A valid AgentRunInput must have the required fields and must not accept
		// a toolCalls field. Tool calls come only from the real model API response
		// and are never part of the run input — passing them silently corrupts the
		// approval flow (the hardcoded id can never match the live Anthropic block id).
		const validInput: AgentRunInput = {
			sessionKey: 'session-001',
			runId: 'run-001',
			message: 'regression guard'
		};

		// Runtime sanity: the required fields are present.
		expect(validInput.sessionKey).toBe('session-001');
		expect(validInput.runId).toBe('run-001');
		expect(validInput.message).toBe('regression guard');

		// If toolCalls is ever added to AgentRunInput the directive below becomes
		// unused and typecheck fails, catching the phantom-field regression.
		const _withPhantomField: AgentRunInput = {
			sessionKey: 'session-001',
			runId: 'run-001',
			message: 'regression guard',
			// @ts-expect-error -- toolCalls is not a field of AgentRunInput
			toolCalls: [{ id: 'x', name: 'y', idempotencyKey: 'z', arguments: {} }]
		};
		void _withPhantomField;
	});
});
