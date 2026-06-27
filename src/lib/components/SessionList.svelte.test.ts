import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionList, { type SessionRow } from './SessionList.svelte';

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: 'sess-001',
		sessionKey: 'my-test-session',
		status: 'idle',
		workflowId: 'agent-session:my-test-session',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides
	};
}

function getByLabel(label: string): Element | null {
	return document.querySelector(`[aria-label="${label}"]`);
}

describe('SessionList', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the panel with heading, new-conversation button, and search input', () => {
		const component = mount(SessionList, {
			target: document.body,
			props: { sessions: [], onSelect: vi.fn(), onCreate: vi.fn() }
		});

		expect(document.querySelector('h2')?.textContent).toBe('Sessions');
		expect(getByLabel('New conversation')).toBeTruthy();
		expect(getByLabel('Search sessions')).toBeTruthy();

		unmount(component);
	});

	it('shows empty-state message when there are no sessions', () => {
		const component = mount(SessionList, {
			target: document.body,
			props: { sessions: [], onSelect: vi.fn(), onCreate: vi.fn() }
		});

		expect(document.body.textContent).toMatch(/No sessions yet/);

		unmount(component);
	});

	it('renders a button for each session', () => {
		const sessions = [
			makeSession({ id: 'sess-1', sessionKey: 'session-alpha' }),
			makeSession({ id: 'sess-2', sessionKey: 'session-beta' })
		];

		const component = mount(SessionList, {
			target: document.body,
			props: { sessions, onSelect: vi.fn(), onCreate: vi.fn() }
		});

		expect(document.body.textContent).toContain('session-alpha');
		expect(document.body.textContent).toContain('session-beta');

		unmount(component);
	});

	it('calls onSelect with the session when a session button is clicked', () => {
		const onSelect = vi.fn();
		const session = makeSession({ sessionKey: 'clickable-session' });

		const component = mount(SessionList, {
			target: document.body,
			props: { sessions: [session], onSelect, onCreate: vi.fn() }
		});

		// Find the button by session key text content.
		const btn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('clickable-session')
		) as HTMLButtonElement;
		expect(btn).toBeInstanceOf(HTMLButtonElement);

		btn.click();
		expect(onSelect).toHaveBeenCalledWith(session);

		unmount(component);
	});

	it('calls onCreate when the New conversation button is clicked', () => {
		const onCreate = vi.fn();

		const component = mount(SessionList, {
			target: document.body,
			props: { sessions: [], onSelect: vi.fn(), onCreate }
		});

		(getByLabel('New conversation') as HTMLButtonElement).click();
		expect(onCreate).toHaveBeenCalledTimes(1);

		unmount(component);
	});

	it('filters sessions by sessionKey as the user types', () => {
		const sessions = [
			makeSession({ id: 'sess-1', sessionKey: 'project-alpha' }),
			makeSession({ id: 'sess-2', sessionKey: 'project-beta' }),
			makeSession({ id: 'sess-3', sessionKey: 'something-else' })
		];

		const component = mount(SessionList, {
			target: document.body,
			props: { sessions, onSelect: vi.fn(), onCreate: vi.fn() }
		});

		const input = getByLabel('Search sessions') as HTMLInputElement;
		input.value = 'project';
		input.dispatchEvent(new Event('input'));
		flushSync();

		expect(document.body.textContent).toContain('project-alpha');
		expect(document.body.textContent).toContain('project-beta');
		expect(document.body.textContent).not.toContain('something-else');

		unmount(component);
	});

	it('shows a no-match message when search has no results', () => {
		const sessions = [makeSession({ sessionKey: 'project-alpha' })];

		const component = mount(SessionList, {
			target: document.body,
			props: { sessions, onSelect: vi.fn(), onCreate: vi.fn() }
		});

		const input = getByLabel('Search sessions') as HTMLInputElement;
		input.value = 'zzz';
		input.dispatchEvent(new Event('input'));
		flushSync();

		expect(document.body.textContent).toMatch(/No sessions match/);

		unmount(component);
	});

	it('shows loading state when loading=true', () => {
		const component = mount(SessionList, {
			target: document.body,
			props: { sessions: [], loading: true, onSelect: vi.fn(), onCreate: vi.fn() }
		});

		expect(document.body.textContent).toMatch(/Loading sessions/);

		unmount(component);
	});

	it('shows an error message when error is set', () => {
		const component = mount(SessionList, {
			target: document.body,
			props: {
				sessions: [],
				error: 'Failed to fetch',
				onSelect: vi.fn(),
				onCreate: vi.fn()
			}
		});

		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Failed to fetch');

		unmount(component);
	});

	it('marks the selected session with aria-current', () => {
		const sessions = [
			makeSession({ id: 'sess-1', sessionKey: 'active-session' }),
			makeSession({ id: 'sess-2', sessionKey: 'other-session' })
		];

		const component = mount(SessionList, {
			target: document.body,
			props: {
				sessions,
				selectedSessionKey: 'active-session',
				onSelect: vi.fn(),
				onCreate: vi.fn()
			}
		});

		const buttons = Array.from(document.querySelectorAll('button'));
		const activeBtn = buttons.find((b) => b.textContent?.includes('active-session'));
		const otherBtn = buttons.find((b) => b.textContent?.includes('other-session'));

		expect(activeBtn?.getAttribute('aria-current')).toBe('true');
		expect(otherBtn?.getAttribute('aria-current')).toBeNull();

		unmount(component);
	});
});
