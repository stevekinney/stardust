import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	TASK_QUEUE_SANDBOX,
	type ApprovalCardState,
	type ApprovalResolutionInput
} from '$lib/types';
import ApprovalCenter, { toCinderApprovalOperation } from './approval-center.svelte';

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
		expiresAt: '2099-06-27T00:00:00.000Z',
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

		expect(document.querySelectorAll('.cinder-approval-card')).toHaveLength(2);
		expect(document.body.textContent).toContain('workspace.writeFile');

		unmount(component);
	});

	it('maps Stardust approval arguments into Cinder operation props', () => {
		expect(toCinderApprovalOperation(makeApproval('approval-command'))).toEqual({
			kind: 'file-write',
			filesTouched: ['out.txt'],
			argsPreview: { path: 'out.txt', content: 'data' }
		});

		expect(
			toCinderApprovalOperation({
				...makeApproval('approval-patch'),
				diff: '--- a/out.txt\n+++ b/out.txt'
			})
		).toEqual({
			kind: 'patch',
			diff: '--- a/out.txt\n+++ b/out.txt',
			argsPreview: { path: 'out.txt', content: 'data' }
		});
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
		const resolved: ApprovalResolutionInput[] = [];
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: {
				approvals: [makeApproval('approval-001')],
				onResolve: vi.fn((resolution) => {
					resolved.push(resolution);
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

		expect(resolved).toEqual([
			{
				approvalId: 'approval-001',
				action: 'approve',
				editedArguments: undefined,
				reason: undefined,
				remember: false,
				actor: 'user'
			}
		]);

		unmount(component);
	});

	it('keeps remembered approvals executable when approving', async () => {
		const resolved: ApprovalResolutionInput[] = [];
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: {
				approvals: [makeApproval('approval-001')],
				onResolve: vi.fn((resolution) => {
					resolved.push(resolution);
				})
			}
		});
		flushSync();

		const rememberCheckbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(rememberCheckbox).toBeInstanceOf(HTMLInputElement);
		rememberCheckbox!.click();
		await Promise.resolve();
		flushSync();
		expect(rememberCheckbox!.checked).toBe(true);

		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		approveButton?.click();
		await Promise.resolve();
		flushSync();

		expect(resolved).toEqual([
			{
				approvalId: 'approval-001',
				action: 'approve',
				editedArguments: undefined,
				reason: undefined,
				remember: true,
				actor: 'user'
			}
		]);

		unmount(component);
	});

	it('passes edited arguments, remember, and reason from Cinder ApprovalCard', async () => {
		const resolved: ApprovalResolutionInput[] = [];
		const component = mount(ApprovalCenter, {
			target: document.body,
			props: {
				approvals: [makeApproval('approval-001')],
				onResolve: vi.fn((resolution) => {
					resolved.push(resolution);
				})
			}
		});

		const editButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve with edits'
		);
		editButton?.click();
		flushSync();

		const textarea = Array.from(document.querySelectorAll('textarea')).find((element) =>
			element.value.includes('"content"')
		);
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		textarea!.value = JSON.stringify({ path: 'out.txt', content: 'approved' });
		textarea!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		const confirmButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Confirm edited approval'
		);
		confirmButton?.click();
		await Promise.resolve();
		flushSync();

		expect(resolved).toEqual([
			{
				approvalId: 'approval-001',
				action: 'approve_with_edits',
				editedArguments: { path: 'out.txt', content: 'approved' },
				reason: undefined,
				remember: false,
				actor: 'user'
			}
		]);

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
