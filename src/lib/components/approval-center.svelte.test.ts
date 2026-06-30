import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_QUEUE_SANDBOX, type ApprovalCardState } from '$lib/types';
import ApprovalCenter from './approval-center.svelte';

function makeApproval(
	id: string,
	status: ApprovalCardState['status'] = 'pending'
): ApprovalCardState {
	return {
		approvalId: id,
		sessionId: 'session-001',
		runId: 'run-001',
		toolCall: {
			id: `tool-${id}`,
			name: 'workspace.writeFile',
			arguments: { path: 'out.txt', content: 'data' }
		},
		tool: {
			name: 'workspace.writeFile',
			description: 'Write a file.',
			inputSchema: {},
			metadata: {
				risk: 'medium',
				requiresApproval: true,
				taskQueue: TASK_QUEUE_SANDBOX,
				timeoutMs: 15_000,
				retry: { maximumAttempts: 1 },
				idempotencyBehavior: 'key-required'
			}
		},
		policyVersion: '2026-06-26',
		proposedArguments: { path: 'out.txt', content: 'data' },
		argsHash: `hash-${id}`,
		expiresAt: '2026-06-27T00:00:00.000Z',
		createdAt: '2026-06-26T00:00:00.000Z',
		status
	};
}

describe('ApprovalCenter', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders a list of pending approvals using ApprovalCard', () => {
		const approvals = [makeApproval('approval-001'), makeApproval('approval-002')];
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: { approvals }
		});

		// Both approval cards should be rendered
		const articles = document.querySelectorAll('article');
		expect(articles.length).toBeGreaterThanOrEqual(2);
		expect(document.body.textContent).toContain('workspace.writeFile');

		unmount(component);
	});

	it('shows an empty state when there are no pending approvals', () => {
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: { approvals: [] }
		});

		expect(document.body.textContent).toContain('No pending');

		unmount(component);
	});

	it('renders a section heading for the approval center', () => {
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: { approvals: [makeApproval('approval-001')] }
		});

		const heading = document.querySelector('h2');
		expect(heading?.textContent?.toLowerCase()).toContain('approval');

		unmount(component);
	});

	it('passes a custom onResolve to each ApprovalCard', async () => {
		const resolved: string[] = [];
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: {
				approvals: [makeApproval('approval-001')],
				onResolve: vi.fn((resolution) => {
					resolved.push(resolution.approvalId);
				})
			}
		});

		// Click the Approve button of the rendered ApprovalCard
		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		approveButton?.click();
		await Promise.resolve();
		flushSync();

		expect(resolved).toEqual(['approval-001']);

		unmount(component);
	});

	it('shows resolved approvals with their terminal status', () => {
		const expired = makeApproval('approval-expired', 'expired');
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: { approvals: [expired] }
		});

		expect(document.body.textContent).toContain('expired');

		unmount(component);
	});
});
