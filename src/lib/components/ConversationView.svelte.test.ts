import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConversationView, { type StreamEvent } from './ConversationView.svelte';

function makeEvent(id: number, kind: string, payload: Record<string, unknown>): StreamEvent {
	return { id, kind, payload: JSON.stringify(payload) };
}

describe('ConversationView', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders nothing when there are no events and no user message', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { events: [] }
		});

		const conversation = document.querySelector('[aria-label="Conversation"]');
		expect(conversation).toBeInstanceOf(HTMLElement);
		// No messages rendered
		expect(document.querySelector('[aria-label="User message"]')).toBeNull();
		expect(document.querySelector('[aria-label="Assistant message"]')).toBeNull();

		unmount(component);
	});

	it('renders the user message when provided', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { userMessage: { text: 'Hello, what can you do?' }, events: [] }
		});

		const userEl = document.querySelector('[aria-label="User message"]');
		expect(userEl).toBeInstanceOf(HTMLElement);
		expect(userEl!.textContent).toContain('Hello, what can you do?');

		unmount(component);
	});

	it('accumulates assistant.delta events into a single assistant message', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'assistant.delta', { text: 'Hello' }),
			makeEvent(2, 'assistant.delta', { text: ', ' }),
			makeEvent(3, 'assistant.delta', { text: 'world!' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const assistantEl = document.querySelector('[aria-label="Assistant message"]');
		expect(assistantEl).toBeInstanceOf(HTMLElement);
		expect(assistantEl!.textContent).toContain('Hello, world!');

		unmount(component);
	});

	it('renders an assistant.message event as the assistant response', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'assistant.message', { text: 'The full answer is 42.' })
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const assistantEl = document.querySelector('[aria-label="Assistant message"]');
		expect(assistantEl).toBeInstanceOf(HTMLElement);
		expect(assistantEl!.textContent).toContain('The full answer is 42.');

		unmount(component);
	});

	it('shows a thinking indicator when running and no assistant text yet', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { events: [], running: true }
		});

		const thinkingEl = document.querySelector('[aria-label="Assistant thinking"]');
		expect(thinkingEl).toBeInstanceOf(HTMLElement);
		expect(thinkingEl!.textContent).toContain('Thinking');

		unmount(component);
	});

	it('does not show the thinking indicator when not running', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { events: [], running: false }
		});

		expect(document.querySelector('[aria-label="Assistant thinking"]')).toBeNull();

		unmount(component);
	});

	it('renders tool call cards with the tool name', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-001',
				name: 'workspace.readFile',
				input: { path: 'notes.md' }
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const toolCard = document.querySelector('[aria-label="Tool: workspace.readFile"]');
		expect(toolCard).toBeInstanceOf(HTMLElement);
		expect(toolCard!.textContent).toContain('workspace.readFile');

		unmount(component);
	});

	it('renders tool input in the tool card', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-001',
				name: 'workspace.writeFile',
				input: { path: 'out.txt', content: 'hello' }
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const toolCard = document.querySelector('[aria-label="Tool: workspace.writeFile"]');
		expect(toolCard!.textContent).toContain('"path"');
		expect(toolCard!.textContent).toContain('"out.txt"');

		unmount(component);
	});

	it('renders tool result when a matching tool.result event follows', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'tool.call', {
				id: 'tc-001',
				name: 'workspace.readFile',
				input: { path: 'notes.md' }
			}),
			makeEvent(2, 'tool.result', {
				callId: 'tc-001',
				content: '# Notes\nsome content here',
				isError: false
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const toolCard = document.querySelector('[aria-label="Tool: workspace.readFile"]');
		expect(toolCard).toBeInstanceOf(HTMLElement);
		expect(toolCard!.textContent).toContain('done');
		expect(toolCard!.textContent).toContain('# Notes');

		unmount(component);
	});

	it('renders the lifecycle started marker', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'started' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const marker = document.querySelector('[aria-label="Run started"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders the lifecycle complete terminal marker', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'complete' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const marker = document.querySelector('[aria-label="Run complete"]');
		expect(marker).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders subagent lanes', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'subagent.start', {
				subagentRunId: 'sub-001',
				kind: 'research',
				label: 'Research: climate change'
			}),
			makeEvent(2, 'subagent.complete', {
				subagentRunId: 'sub-001',
				kind: 'research',
				label: 'Research: climate change',
				status: 'complete'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const lane = document.querySelector('[aria-label="Subagent: Research: climate change"]');
		expect(lane).toBeInstanceOf(HTMLElement);
		expect(lane!.textContent).toContain('research');
		expect(lane!.textContent).toContain('complete');

		unmount(component);
	});

	it('renders an approval notice for approval.request events', () => {
		const events: StreamEvent[] = [
			makeEvent(1, 'approval.request', {
				approvalId: 'apr-001',
				toolName: 'shell.exec'
			})
		];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const notice = document.querySelector('[aria-label="Approval required: shell.exec"]');
		expect(notice).toBeInstanceOf(HTMLElement);
		expect(notice!.textContent).toContain('shell.exec');

		unmount(component);
	});

	it('renders a failure banner when run status is failed', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const banner = document.querySelector('[aria-label="Run failed"]');
		expect(banner).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('renders a cancellation banner when run status is cancelled', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'cancelled' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		const banner = document.querySelector('[aria-label="Run cancelled"]');
		expect(banner).toBeInstanceOf(HTMLElement);

		unmount(component);
	});

	it('does not render a failure banner for completed runs', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'complete' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		expect(document.querySelector('[aria-label="Run failed"]')).toBeNull();
		expect(document.querySelector('[aria-label="Run cancelled"]')).toBeNull();

		unmount(component);
	});

	it('renders a retry button when onRetry is provided and run is failed', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const onRetry = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: { events, onRetry }
		});

		const button = document.querySelector('.run-failure-retry');
		expect(button).toBeInstanceOf(HTMLElement);
		expect(button!.textContent?.trim()).toBe('Retry');

		unmount(component);
	});

	it('calls onRetry when the retry button is clicked', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const onRetry = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: { events, onRetry }
		});

		const button = document.querySelector('.run-failure-retry') as HTMLButtonElement;
		button.click();
		expect(onRetry).toHaveBeenCalledOnce();

		unmount(component);
	});

	it('does not render a retry button when onRetry is not provided', () => {
		const events: StreamEvent[] = [makeEvent(1, 'lifecycle', { status: 'failed' })];
		const component = mount(ConversationView, {
			target: document.body,
			props: { events }
		});

		expect(document.querySelector('.run-failure-retry')).toBeNull();

		unmount(component);
	});
});
