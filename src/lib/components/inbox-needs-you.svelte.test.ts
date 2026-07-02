import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InboxNeedsYou from './inbox-needs-you.svelte';
import type { ApprovalEntry } from '$lib/types';

const approval: ApprovalEntry = {
	approvalId: 'apr-001',
	sessionId: 'sess-key-1',
	toolCall: {
		id: 'call-1',
		name: 'run_command',
		arguments: { command: 'git push origin main' }
	},
	status: 'pending',
	createdAt: new Date().toISOString(),
	expiresAt: new Date(Date.now() + 60_000).toISOString()
};

describe('InboxNeedsYou', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders a pending approval card with its session context line', () => {
		const onResolve = vi.fn();
		const component = mount(InboxNeedsYou, {
			target: document.body,
			props: { approvals: [approval], resolvedNow: [], onResolve }
		});

		expect(document.body.textContent).toContain('signal human_approval');
		expect(document.body.textContent).toContain('git push origin main');

		const sessionLink = document.querySelector('a.session-link');
		expect(sessionLink?.getAttribute('href')).toBe('/sessions/sess-key-1');

		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		expect(approveButton).toBeDefined();
		approveButton!.click();
		expect(onResolve).toHaveBeenCalledWith('apr-001', 'approve');

		unmount(component);
	});

	it('renders resolved banners and an empty state', () => {
		const component = mount(InboxNeedsYou, {
			target: document.body,
			props: {
				approvals: [],
				resolvedNow: [
					{ approvalId: 'apr-001', action: 'approve' as const, toolName: 'run_command' }
				],
				onResolve: vi.fn()
			}
		});

		expect(document.body.textContent).toContain('Approved — the signal woke the workflow');
		expect(document.body.textContent).toContain('signal delivered');

		unmount(component);
	});

	it('shows the empty state when nothing needs the user', () => {
		const component = mount(InboxNeedsYou, {
			target: document.body,
			props: { approvals: [], resolvedNow: [], onResolve: vi.fn() }
		});

		expect(document.body.textContent).toContain('Nothing needs you right now.');

		unmount(component);
	});
});
