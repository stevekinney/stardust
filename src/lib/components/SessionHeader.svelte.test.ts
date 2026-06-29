import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionHeader from './SessionHeader.svelte';

function getByLabel(label: string): Element | null {
	return document.querySelector(`[aria-label="${label}"]`);
}

describe('SessionHeader', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders a link back to the sessions list', () => {
		const component = mount(SessionHeader, {
			target: document.body,
			props: { sessionKey: 'my-session', onNewSession: vi.fn() }
		});

		const link = getByLabel('Back to sessions list') as HTMLAnchorElement;
		expect(link).toBeInstanceOf(HTMLAnchorElement);
		expect(link.href).toBeTruthy();

		unmount(component);
	});

	it('renders a "New Session" button', () => {
		const component = mount(SessionHeader, {
			target: document.body,
			props: { sessionKey: 'my-session', onNewSession: vi.fn() }
		});

		const btn = getByLabel('New session') as HTMLButtonElement;
		expect(btn).toBeInstanceOf(HTMLButtonElement);

		unmount(component);
	});

	it('calls onNewSession when the New Session button is clicked', () => {
		const onNewSession = vi.fn();

		const component = mount(SessionHeader, {
			target: document.body,
			props: { sessionKey: 'my-session', onNewSession }
		});

		(getByLabel('New session') as HTMLButtonElement).click();
		expect(onNewSession).toHaveBeenCalledTimes(1);

		unmount(component);
	});

	it('renders the session key in the title', () => {
		const component = mount(SessionHeader, {
			target: document.body,
			props: { sessionKey: 'abc-123', onNewSession: vi.fn() }
		});

		expect(document.body.textContent).toContain('abc-123');

		unmount(component);
	});

	it('renders an Ops link', () => {
		const component = mount(SessionHeader, {
			target: document.body,
			props: { sessionKey: 'my-session', onNewSession: vi.fn() }
		});

		const link = getByLabel('Open operator console') as HTMLAnchorElement;
		expect(link).toBeInstanceOf(HTMLAnchorElement);

		unmount(component);
	});
});
