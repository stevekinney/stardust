import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	TASK_QUEUE_SANDBOX,
	type ApprovalCardState,
	type ApprovalResolutionInput
} from '$lib/types';
import ApprovalCard from './ApprovalCard.svelte';

const approval: ApprovalCardState = {
	approvalId: 'approval-001',
	sessionId: 'session-001',
	runId: 'run-001',
	toolCall: {
		id: 'tool-call-001',
		name: 'workspace.writeFile',
		arguments: { path: 'notes.txt', content: 'draft' }
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
			retry: { maximumAttempts: 1 }
		}
	},
	policyVersion: '2026-06-26',
	proposedArguments: { path: 'notes.txt', content: 'draft' },
	argsHash: 'hash-001',
	expiresAt: '2026-06-27T00:00:00.000Z',
	createdAt: '2026-06-26T00:00:00.000Z',
	status: 'pending'
};

function buttonNamed(name: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll('button')).find(
		(candidate) => candidate.textContent?.trim() === name
	);
	expect(button).toBeInstanceOf(HTMLButtonElement);
	return button as HTMLButtonElement;
}

function textareaNamed(name: string): HTMLTextAreaElement {
	const label = Array.from(document.querySelectorAll('label')).find((candidate) =>
		candidate.textContent?.includes(name)
	);
	const textarea = label?.querySelector('textarea');
	expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
	return textarea as HTMLTextAreaElement;
}

function checkboxNamed(name: string): HTMLInputElement {
	const label = Array.from(document.querySelectorAll('label')).find((candidate) =>
		candidate.textContent?.includes(name)
	);
	const checkbox = label?.querySelector('input[type="checkbox"]');
	expect(checkbox).toBeInstanceOf(HTMLInputElement);
	return checkbox as HTMLInputElement;
}

describe('ApprovalCard', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders approval metadata, expiry, proposed arguments, and action controls', () => {
		const component = mount(ApprovalCard, {
			target: document.body,
			props: { approval }
		});

		expect(document.body.textContent).toContain('workspace.writeFile');
		expect(document.body.textContent).toContain('Policy version');
		expect(document.body.textContent).toContain('2026-06-26');
		expect(document.body.textContent).toContain('Arguments hash');
		expect(document.body.textContent).toContain('hash-001');
		expect(document.body.textContent).toContain('"content": "draft"');
		expect(buttonNamed('Approve').disabled).toBe(false);
		expect(buttonNamed('Approve with edits').disabled).toBe(false);
		expect(buttonNamed('Deny').disabled).toBe(false);
		expect(buttonNamed('Remember').disabled).toBe(false);
		expect(buttonNamed('Cancel run').disabled).toBe(false);

		unmount(component);
	});

	it('submits edited arguments as canonical approval input with remember and reason fields', async () => {
		const resolutions: ApprovalResolutionInput[] = [];
		const component = mount(ApprovalCard, {
			target: document.body,
			props: {
				approval,
				onResolve: vi.fn((resolution: ApprovalResolutionInput) => {
					resolutions.push(resolution);
				})
			}
		});

		const editedArguments = textareaNamed('Edited arguments');
		editedArguments.value = JSON.stringify({ path: 'notes.txt', content: 'approved' });
		editedArguments.dispatchEvent(new Event('input', { bubbles: true }));
		const reason = textareaNamed('Reason');
		reason.value = 'Looks scoped.';
		reason.dispatchEvent(new Event('input', { bubbles: true }));
		const remember = checkboxNamed('Remember this approval boundary');
		remember.click();
		buttonNamed('Approve with edits').click();
		await Promise.resolve();
		flushSync();

		expect(resolutions).toEqual([
			{
				approvalId: 'approval-001',
				action: 'approve_with_edits',
				editedArguments: { path: 'notes.txt', content: 'approved' },
				reason: 'Looks scoped.',
				remember: true,
				actor: 'user'
			}
		]);

		unmount(component);
	});

	it('shows an error instead of resolving approve-with-edits when edited JSON is invalid', async () => {
		const onResolve = vi.fn();
		const component = mount(ApprovalCard, {
			target: document.body,
			props: { approval, onResolve }
		});

		const editedArguments = textareaNamed('Edited arguments');
		editedArguments.value = '{not valid json';
		editedArguments.dispatchEvent(new Event('input', { bubbles: true }));
		buttonNamed('Approve with edits').click();
		await Promise.resolve();
		flushSync();

		expect(onResolve).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			'Edited arguments must be valid JSON.'
		);

		unmount(component);
	});

	it('disables actions for an expired approval', () => {
		const component = mount(ApprovalCard, {
			target: document.body,
			props: {
				approval: {
					...approval,
					status: 'expired'
				}
			}
		});

		expect(buttonNamed('Approve').disabled).toBe(true);
		expect(buttonNamed('Approve with edits').disabled).toBe(true);
		expect(buttonNamed('Deny').disabled).toBe(true);
		expect(buttonNamed('Remember').disabled).toBe(true);
		expect(buttonNamed('Cancel run').disabled).toBe(true);

		unmount(component);
	});
});
