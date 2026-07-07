import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '$lib/stream-to-conversation';
import ConversationView from './conversation-view.svelte';

function makeEvent(id: number, kind: string, payload: Record<string, unknown>): StreamEvent {
	return { id, kind, payload: JSON.stringify(payload) };
}

const defaultProps = {
	sessionId: 'test-session',
	onSubmit: vi.fn()
};

describe('ConversationView', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the conversation container', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		const conversation = document.querySelector('[aria-label="Conversation"]');
		expect(conversation).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders the Cinder Chat component with the correct id', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		const chatContainer = document.querySelector('[id^="session-test-session"]');
		expect(chatContainer).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders lifecycle markers with custom row override', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'started' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run started"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders lifecycle complete marker', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'complete' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run complete"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders lifecycle failed marker with reason', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'lifecycle', { status: 'failed', reason: 'Timeout exceeded' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const marker = document.querySelector('[aria-label="Run failed"]');
		expect(marker).toBeInstanceOf(HTMLElement);
		expect(marker!.textContent).toContain('Timeout exceeded');

		unmount(component);
	});

	it('renders subagent lanes', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'subagent.start', {
				subagentRunId: 'sub-001',
				kind: 'research',
				label: 'Research: climate change'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const lane = document.querySelector('[aria-label="Subagent: Research: climate change"]');
		expect(lane).toBeInstanceOf(HTMLElement);
		expect(lane!.textContent).toContain('research');

		unmount(component);
	});

	it('renders approval notices', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', {
				approvalId: 'apr-001',
				toolName: 'shell.exec'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const notice = document.querySelector('[aria-label="Approval required: shell.exec"]');
		expect(notice).toBeInstanceOf(HTMLElement);
		expect(notice!.textContent).toContain('shell.exec');

		unmount(component);
	});

	it('renders memory candidate notices', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'memory.candidate', { content: 'User prefers dark theme' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		const notice = document.querySelector('[aria-label="Memory candidate"]');
		expect(notice).toBeInstanceOf(HTMLElement);
		expect(notice!.textContent).toContain('User prefers dark theme');

		unmount(component);
	});

	it('renders a retry button on failed lifecycle when onRetry is provided', () => {
		const onRetry = vi.fn();
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events, onRetry }
		});

		const button = document.querySelector('.lifecycle-retry') as HTMLButtonElement;
		expect(button).toBeInstanceOf(HTMLElement);
		button.click();
		expect(onRetry).toHaveBeenCalledOnce();

		unmount(component);
	});

	it('does not render a retry button when onRetry is not provided', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		expect(document.querySelector('.lifecycle-retry')).toBeNull();

		unmount(component);
	});

	it('renders an inline ApprovalCard for a pending approval and resolves through it', () => {
		const onResolveApproval = vi.fn();
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git push origin main' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval
			}
		});

		expect(document.body.textContent).toContain('git push origin main');
		expect(document.body.textContent).toContain('the same durable signal');

		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		expect(approveButton).toBeDefined();
		approveButton!.click();
		expect(onResolveApproval).toHaveBeenCalledWith('apr-001', 'approve');

		unmount(component);
	});

	it('BUG-004: announces a pending inline approval in a dedicated polite live region', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git push origin main' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval: vi.fn()
			}
		});

		const announcer = Array.from(
			document.querySelectorAll('[aria-live="polite"][aria-atomic="true"]')
		).find((region) => region.textContent?.includes('Approval required'));
		expect(announcer).toBeInstanceOf(HTMLElement);
		expect(announcer!.textContent).toContain('Approval required: run_command');

		unmount(component);
	});

	it('preserves edited arguments from the inline ApprovalCard', async () => {
		const onResolveApproval = vi.fn();
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: {
					approvalId: 'apr-001',
					sessionId: 'sess-001',
					toolCall: {
						id: 'call-001',
						name: 'run_command',
						arguments: { command: 'git status' }
					},
					status: 'pending' as const,
					createdAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString()
				},
				onResolveApproval
			}
		});

		const editButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve with edits'
		);
		expect(editButton).toBeDefined();
		editButton!.click();
		await Promise.resolve();

		const textarea = document.querySelector('textarea') as HTMLTextAreaElement | null;
		expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
		textarea!.value = JSON.stringify({ command: 'git status --short' });
		textarea!.dispatchEvent(new Event('input', { bubbles: true }));

		const confirmButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Confirm edited approval'
		);
		expect(confirmButton).toBeDefined();
		confirmButton!.click();
		await Promise.resolve();

		expect(onResolveApproval).toHaveBeenCalledWith('apr-001', 'approve_with_edits', {
			command: 'git status --short'
		});

		unmount(component);
	});

	it('renders canonical approval requests with the nested toolCall name and settles on resolution', () => {
		const events: StreamEvent[] = [
			{
				...makeEvent(1, 'approval.request', {
					approvalId: 'apr-002',
					toolCall: { id: 'call-9', name: 'workspace.writeFile', arguments: {} }
				}),
				sequence: 5
			},
			{
				...makeEvent(2, 'approval.resolution', { approvalId: 'apr-002', action: 'approve' }),
				sequence: 6
			}
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events }
		});

		expect(document.body.textContent).toContain(
			'Approved — the signal woke the workflow and workspace.writeFile ran'
		);
		expect(document.body.textContent).not.toContain('Waiting for approval');

		unmount(component);
	});

	it('renders a settled banner after the approval is resolved', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', { approvalId: 'apr-001', toolName: 'run_command' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: {
				...defaultProps,
				events,
				pendingApproval: null,
				approvalResolution: 'approve' as const,
				onResolveApproval: vi.fn()
			}
		});

		expect(document.body.textContent).toContain('Approved — the signal woke the workflow');

		unmount(component);
	});

	it('dims rows whose durable sequence is past the replay cursor', () => {
		const events: StreamEvent[] = [
			{ ...makeEvent(1, 'lifecycle', { status: 'started' }), sequence: 2 },
			{ ...makeEvent(2, 'lifecycle', { status: 'complete' }), sequence: 6 }
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events, dimAfterSequence: 3 }
		});

		const dimmed = document.querySelectorAll('.row-dimmed');
		expect(dimmed).toHaveLength(1);
		expect(dimmed[0].textContent).toContain('Run complete');

		unmount(component);
	});
});
