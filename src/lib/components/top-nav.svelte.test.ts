import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TopNavRouteChangeHarness from './top-nav-route-change-harness.svelte';
import TopNav from './top-nav.svelte';

const getPrimaryNavigation = () => document.querySelector('nav[aria-label="Primary"]');

const getNavigationItem = (href: string) =>
	getPrimaryNavigation()?.querySelector<HTMLAnchorElement>(
		`a[href="${href}"]:not([aria-label="Stardust home"])`
	) ?? null;

const activateNavigationItem = (link: HTMLAnchorElement, init?: MouseEventInit) => {
	document.addEventListener('click', (event) => event.preventDefault(), { once: true });
	link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
};

describe('TopNav', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the primary navigation with the section tabs', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const nav = getPrimaryNavigation();
		expect(nav).not.toBeNull();

		const labels = ['/', '/inbox', '/schedules', '/artifacts', '/insights'].map((href) =>
			getNavigationItem(href)?.textContent?.trim()
		);
		expect(labels).toEqual(['Sessions', 'Inbox', 'Schedules', 'Artifacts', 'Insights']);

		unmount(component);
	});

	it('marks the tab matching the current path as active', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/schedules' }
		});

		const active = getPrimaryNavigation()?.querySelector('a[aria-current]');
		expect(active).not.toBeNull();
		expect(active!.textContent?.trim()).toBe('Schedules');

		unmount(component);
	});

	it('marks Sessions active for session detail paths', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/sessions/ses-7af3' }
		});

		const active = getPrimaryNavigation()?.querySelector('a[aria-current]');
		expect(active!.textContent?.trim()).toBe('Sessions');

		unmount(component);
	});

	it('renders the health cluster trigger and the settings link', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const cluster = Array.from(document.querySelectorAll('button')).find((button) =>
			button.textContent?.includes('temporal :7233')
		);
		expect(cluster).toBeDefined();

		const settings = document.querySelector('a[aria-label="Settings"]');
		expect(settings).not.toBeNull();
		expect(settings!.getAttribute('href')).toBe('/settings');

		unmount(component);
	});

	it('uses an app-owned responsive hook for the command shortcut', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/', onOpenPalette: vi.fn() }
		});

		const search = document.querySelector('button[aria-label="Search or run a command"]');
		const shortcut = search?.querySelector('.palette-shortcut');
		expect(shortcut).not.toBeNull();
		expect(shortcut?.textContent).toContain('⌘K');

		unmount(component);
	});

	// Regression: the nav overflows onto the search/health/settings controls at
	// narrow container widths. Cinder's NavigationBar collapses the tab list
	// behind a menu toggle to prevent that, but only if the bar opts in via a
	// `menuToggle` snippet and forwards the `variant` it hands the `items`
	// snippet — both were previously missing.
	it('opens the mobile tab list with every primary navigation destination', async () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const toggle = document.querySelector('button[aria-label="Toggle navigation menu"]');
		expect(toggle).not.toBeNull();
		expect(toggle!.getAttribute('aria-expanded')).toBe('false');

		(toggle as HTMLButtonElement).click();
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('true'));

		const destinations = ['/', '/inbox', '/schedules', '/artifacts', '/insights'];
		for (const destination of destinations) {
			expect(getNavigationItem(destination)).not.toBeNull();
		}

		unmount(component);
	});

	it('lets Cinder close the mobile menu after normal item activation', async () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const toggle = document.querySelector('button[aria-label="Toggle navigation menu"]');
		expect(toggle).not.toBeNull();
		(toggle as HTMLButtonElement).click();
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('true'));

		const inboxLink = getNavigationItem('/inbox');
		expect(inboxLink).not.toBeNull();
		activateNavigationItem(inboxLink!);
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('false'));
		expect(document.querySelector('.menu-backdrop')).toBeNull();

		unmount(component);
	});

	it('keeps the mobile menu open for modified item activation', async () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const toggle = document.querySelector('button[aria-label="Toggle navigation menu"]');
		expect(toggle).not.toBeNull();
		(toggle as HTMLButtonElement).click();
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('true'));

		const inboxLink = getNavigationItem('/inbox');
		expect(inboxLink).not.toBeNull();
		activateNavigationItem(inboxLink!, { metaKey: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(toggle!.getAttribute('aria-expanded')).toBe('true');
		expect(document.querySelector('.menu-backdrop')).not.toBeNull();

		unmount(component);
	});

	it('closes the mobile menu when navigation changes outside navigation item activation', async () => {
		const component = mount(TopNavRouteChangeHarness, { target: document.body });

		const toggle = document.querySelector('button[aria-label="Toggle navigation menu"]');
		expect(toggle).not.toBeNull();
		(toggle as HTMLButtonElement).click();
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('true'));

		const routeChange = document.querySelector<HTMLButtonElement>('[data-testid="route-change"]');
		expect(routeChange).not.toBeNull();
		routeChange!.click();
		flushSync();

		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('false'));
		expect(document.querySelector('.menu-backdrop')).toBeNull();

		unmount(component);
	});
});
