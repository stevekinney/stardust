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
});
