/**
 * Permanent accessibility gate for the chat surface, driven by deterministic
 * fixture transcripts (no live Temporal backend). Runs axe-core against three
 * states of ConversationView: idle, streaming, and tool-call-in-progress
 * (pending approval). Fails on any "critical" or "serious" violation.
 *
 * Also encodes the specific assertions from state/BUGS.md / the a11y audit:
 *  - the streaming transcript region announces via aria-live="polite", not "assertive"
 *  - focus is never stolen when new content streams in
 *  - the composer regains focus after a message is sent
 *  - BUG-004: a pending inline approval is announced through Cinder Chat
 */
import axe, { type AxeResults, type Result } from 'axe-core';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '$lib/stream-to-conversation';
import type { PendingApprovalEntry } from '$lib/types';
import ConversationView from './conversation-view.svelte';

function makeEvent(id: number, kind: string, payload: Record<string, unknown>): StreamEvent {
	return { id, kind, payload: JSON.stringify(payload) };
}

/** Serious+ impact violations, formatted for a readable assertion failure. */
function seriousViolations(results: AxeResults): Result[] {
	return results.violations.filter(
		(violation) => violation.impact === 'critical' || violation.impact === 'serious'
	);
}

function formatViolations(violations: Result[]): string {
	return violations
		.map(
			(violation) =>
				`${violation.id} (${violation.impact}): ${violation.help}\n` +
				violation.nodes.map((node) => `  - ${node.target.join(' ')}`).join('\n')
		)
		.join('\n\n');
}

async function runAxe(container: HTMLElement): Promise<AxeResults> {
	return axe.run(container);
}

const pendingApproval: PendingApprovalEntry = {
	approvalId: 'apr-001',
	sessionId: 'sess-001',
	toolCall: {
		id: 'call-001',
		name: 'run_command',
		arguments: { command: 'git push origin main' }
	},
	status: 'pending',
	createdAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe('ConversationView accessibility', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	describe('idle state (loaded session, no run)', () => {
		it('has no critical or serious axe violations', async () => {
			const events: StreamEvent[] = [
				makeEvent(1, 'user.message', { text: 'What is the deploy status?' }),
				makeEvent(2, 'assistant.message', { text: 'Everything is green as of the last check.' })
			];
			const component = mount(ConversationView, {
				target: document.body,
				props: { sessionId: 'idle-session', onSubmit: vi.fn(), events, running: false }
			});
			flushSync();

			const results = await runAxe(document.body);
			const violations = seriousViolations(results);
			expect(violations, formatViolations(violations)).toHaveLength(0);

			unmount(component);
		});
	});

	describe('streaming state (assistant message in progress)', () => {
		function mountStreaming() {
			const events: StreamEvent[] = [
				makeEvent(1, 'user.message', { text: 'Summarize the last run.' }),
				makeEvent(2, 'assistant.delta', { text: 'The run completed in 4 steps and' })
			];
			return mount(ConversationView, {
				target: document.body,
				props: { sessionId: 'streaming-session', onSubmit: vi.fn(), events, running: true }
			});
		}

		it('has no critical or serious axe violations', async () => {
			const component = mountStreaming();
			flushSync();

			const results = await runAxe(document.body);
			const violations = seriousViolations(results);
			expect(violations, formatViolations(violations)).toHaveLength(0);

			unmount(component);
		});

		it('announces the transcript region politely, not assertively', () => {
			const component = mountStreaming();
			flushSync();

			const log = document.querySelector('[role="log"]');
			expect(log).toBeInstanceOf(HTMLElement);
			expect(log!.getAttribute('aria-live')).toBe('polite');
			expect(log!.getAttribute('aria-live')).not.toBe('assertive');

			unmount(component);
		});

		it('does not steal focus when new streamed content arrives', () => {
			const events: StreamEvent[] = [
				makeEvent(1, 'user.message', { text: 'Summarize the last run.' }),
				makeEvent(2, 'assistant.delta', { text: 'The run completed' })
			];
			const props = $state({
				sessionId: 'streaming-session',
				onSubmit: vi.fn(),
				events,
				running: true
			});
			const component = mount(ConversationView, { target: document.body, props });
			flushSync();

			// The composer is disabled while streaming, so focus a different
			// focusable control (the "Stop generating" button) to prove new
			// streamed content doesn't yank focus away from wherever it was.
			const stopButton = document.querySelector(
				'[aria-label="Stop generating"]'
			) as HTMLButtonElement | null;
			expect(stopButton).toBeInstanceOf(HTMLButtonElement);
			stopButton!.focus();
			expect(document.activeElement).toBe(stopButton);

			// Simulate more content streaming in.
			props.events = [
				...events,
				makeEvent(3, 'assistant.delta', { text: ' in 4 steps and finished cleanly.' })
			];
			flushSync();

			expect(document.activeElement).toBe(stopButton);

			unmount(component);
		});
	});

	describe('tool-call-in-progress state (pending approval)', () => {
		function mountToolCall(onResolveApproval = vi.fn()) {
			const events: StreamEvent[] = [
				makeEvent(1, 'user.message', { text: 'Push the release branch.' }),
				makeEvent(2, 'tool.call', {
					id: 'call-001',
					name: 'run_command',
					input: { command: 'git push origin main' }
				}),
				makeEvent(3, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
			];
			return mount(ConversationView, {
				target: document.body,
				props: {
					sessionId: 'toolcall-session',
					onSubmit: vi.fn(),
					events,
					running: true,
					pendingApproval,
					onResolveApproval
				}
			});
		}

		it('has no critical or serious axe violations', async () => {
			const component = mountToolCall();
			flushSync();

			const results = await runAxe(document.body);
			const violations = seriousViolations(results);
			expect(violations, formatViolations(violations)).toHaveLength(0);

			unmount(component);
		});

		it('BUG-004: announces a newly pending approval through the Cinder Chat announcer', async () => {
			const props = $state({
				sessionId: 'toolcall-session',
				onSubmit: vi.fn(),
				events: [
					makeEvent(1, 'user.message', { text: 'Push the release branch.' })
				] as StreamEvent[],
				running: true,
				pendingApproval: null as PendingApprovalEntry | null,
				onResolveApproval: vi.fn()
			});
			const component = mount(ConversationView, { target: document.body, props });
			flushSync();

			// No approval pending yet, so Cinder's polite announcer has no approval text.
			const liveRegions = Array.from(
				document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')
			);
			const approvalAnnouncer = liveRegions.find((region) =>
				region.textContent?.includes('Approval required')
			);
			expect(approvalAnnouncer).toBeUndefined();

			// A new approval becomes pending.
			props.pendingApproval = pendingApproval;
			flushSync();
			await tick();
			flushSync();

			const announcer = Array.from(
				document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')
			).find((region) => region.textContent?.includes('Approval required'));
			expect(announcer).toBeInstanceOf(HTMLElement);
			expect(announcer!.textContent).toContain('Approval required: run_command');

			unmount(component);
		});
	});

	describe('composer focus retention', () => {
		it('retains focus on the composer input after send', () => {
			const onSubmit = vi.fn();
			const component = mount(ConversationView, {
				target: document.body,
				props: { sessionId: 'compose-session', onSubmit, events: [] }
			});
			flushSync();

			const composer = document.querySelector('textarea') as HTMLTextAreaElement | null;
			expect(composer).toBeInstanceOf(HTMLTextAreaElement);
			composer!.focus();
			composer!.value = 'Run the smoke tests';
			composer!.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();

			composer!.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			flushSync();

			expect(onSubmit).toHaveBeenCalledWith('Run the smoke tests', undefined);
			expect(document.activeElement).toBe(composer);

			unmount(component);
		});
	});
});
