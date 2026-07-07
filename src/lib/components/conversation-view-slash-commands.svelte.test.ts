import { mount, unmount, flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConversationView from './conversation-view.svelte';

const gotoMock = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto: gotoMock }));

/** Finds the real composer textarea Cinder renders inside `.chat-input-editor`. */
function composer(): HTMLTextAreaElement {
	const element = document.querySelector<HTMLTextAreaElement>('.chat-input-editor');
	expect(element).toBeInstanceOf(HTMLTextAreaElement);
	return element as HTMLTextAreaElement;
}

/** Types text into the composer the way a user would — sets the value, then fires `input`. */
function typeInComposer(text: string): void {
	const element = composer();
	element.focus();
	element.value = text;
	element.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function pressKey(key: string): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	composer().dispatchEvent(event);
	flushSync();
	return event;
}

function palette(): HTMLElement | null {
	return document.querySelector('.slash-palette');
}

function options(): HTMLElement[] {
	return Array.from(document.querySelectorAll('[role="option"]'));
}

const defaultProps = {
	sessionId: 'diag',
	onSubmit: vi.fn()
};

describe('ConversationView slash commands', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		vi.unstubAllGlobals();
		gotoMock.mockClear();
	});

	it('opens the palette when typing "/" at the start of an empty composer', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		expect(palette()).toBeNull();
		typeInComposer('/');
		expect(palette()).toBeInstanceOf(HTMLElement);
		expect(options().length).toBeGreaterThan(0);

		unmount(component);
	});

	it('does not open the palette when "/" appears mid-message', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('check src/lib');
		expect(palette()).toBeNull();

		unmount(component);
	});

	it('fuzzy-filters the visible commands as the query grows', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/');
		expect(options().map((el) => el.textContent)).toEqual(
			expect.arrayContaining([expect.stringContaining('/stop')])
		);

		typeInComposer('/stop');
		const names = options().map((el) => el.querySelector('.slash-name')?.textContent);
		expect(names).toEqual(['/stop']);

		unmount(component);
	});

	it('closes the palette if the text stops starting with "/"', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/');
		expect(palette()).toBeInstanceOf(HTMLElement);
		typeInComposer('hello');
		expect(palette()).toBeNull();

		unmount(component);
	});

	it('supports keyboard-only navigation and selection (ArrowDown + Enter, no mouse)', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }))
		);
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/');
		const firstActive = () => document.querySelector('[aria-selected="true"]');
		expect(firstActive()?.querySelector('.slash-name')?.textContent).toBe('/help');

		pressKey('ArrowDown');
		expect(firstActive()?.querySelector('.slash-name')?.textContent).toBe('/new');

		pressKey('ArrowDown');
		expect(firstActive()?.querySelector('.slash-name')?.textContent).toBe('/tools');

		pressKey('ArrowUp');
		expect(firstActive()?.querySelector('.slash-name')?.textContent).toBe('/new');

		const enterEvent = pressKey('Enter');
		expect(enterEvent.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(palette()).toBeNull());

		unmount(component);
	});

	it('dismisses on Escape and returns focus to the composer', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/');
		expect(palette()).toBeInstanceOf(HTMLElement);

		const escEvent = pressKey('Escape');
		expect(escEvent.defaultPrevented).toBe(true);
		expect(palette()).toBeNull();
		expect(document.activeElement).toBe(composer());

		unmount(component);
	});

	it('exposes combobox ARIA semantics on the composer while the palette is open', () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/');
		const input = composer();
		expect(input.getAttribute('role')).toBe('combobox');
		expect(input.getAttribute('aria-expanded')).toBe('true');
		expect(input.getAttribute('aria-controls')).toBe('session-diag-slash-listbox');
		const activeOption = document.querySelector('[aria-selected="true"]');
		expect(activeOption?.id).toBeTruthy();
		expect(input.getAttribute('aria-activedescendant')).toBe(activeOption?.id);

		const listbox = document.querySelector('#session-diag-slash-listbox');
		expect(listbox).toBeInstanceOf(HTMLElement);
		expect(listbox?.getAttribute('role')).toBe('listbox');

		pressKey('Escape');
		expect(input.getAttribute('aria-expanded')).toBe('false');
		expect(input.hasAttribute('aria-activedescendant')).toBe(false);

		unmount(component);
	});

	it('dispatches /stop to the interrupt handler', async () => {
		const onInterrupt = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [], running: true, onInterrupt }
		});

		typeInComposer('/stop');
		pressKey('Enter');
		await vi.waitFor(() => expect(onInterrupt).toHaveBeenCalledOnce());

		unmount(component);
	});

	it('shows an unavailable reason instead of running /stop when no run is active', async () => {
		const onInterrupt = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [], running: false, onInterrupt }
		});

		typeInComposer('/stop');
		pressKey('Enter');
		await vi.waitFor(() => expect(document.body.textContent).toContain('No run in progress'));
		expect(onInterrupt).not.toHaveBeenCalled();

		unmount(component);
	});

	it('dispatches /retry to the retry handler', async () => {
		const onRetry = vi.fn();
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [], onRetry }
		});

		typeInComposer('/retry');
		pressKey('Enter');
		await vi.waitFor(() => expect(onRetry).toHaveBeenCalledOnce());

		unmount(component);
	});

	it('dispatches /new to POST /api/sessions and navigates', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/api/sessions') && init?.method === 'POST') {
				return new Response(JSON.stringify({ sessionKey: 'ses_new' }), { status: 200 });
			}
			return new Response('{}', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/new');
		pressKey('Enter');

		await vi.waitFor(() =>
			expect(fetchMock).toHaveBeenCalledWith('/api/sessions', { method: 'POST' })
		);

		unmount(component);
	});

	it('dispatches /tools to GET /api/tools and shows the results inline', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/api/tools')) {
				return new Response(
					JSON.stringify({
						tools: [{ name: 'shell.exec', description: 'Runs a shell command', risk: 'high' }]
					}),
					{ status: 200 }
				);
			}
			return new Response('{}', { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/tools');
		pressKey('Enter');

		await vi.waitFor(() => expect(document.body.textContent).toContain('shell.exec'));

		unmount(component);
	});

	it('/help lists every available command inline', async () => {
		const component = mount(ConversationView, {
			target: document.body,
			props: { ...defaultProps, events: [] }
		});

		typeInComposer('/help');
		pressKey('Enter');

		await vi.waitFor(() => expect(document.body.textContent).toContain('/stop'));
		expect(document.body.textContent).toContain('/retry');
		expect(document.body.textContent).toContain('/approvals');

		unmount(component);
	});
});
