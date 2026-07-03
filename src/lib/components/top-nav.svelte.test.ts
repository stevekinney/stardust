import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TopNav from './top-nav.svelte';

describe('TopNav', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the primary navigation with the section tabs', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const nav = document.querySelector('nav[aria-label="Primary"]');
		expect(nav).not.toBeNull();

		const labels = Array.from(nav!.querySelectorAll('a[data-cinder-navigation-item]')).map((link) =>
			link.textContent?.trim()
		);
		expect(labels).toEqual(['Sessions', 'Inbox', 'Schedules', 'Artifacts', 'Insights']);

		unmount(component);
	});

	it('marks the tab matching the current path as active', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/schedules' }
		});

		const active = document.querySelector('[data-cinder-navigation-item][aria-current]');
		expect(active).not.toBeNull();
		expect(active!.textContent?.trim()).toBe('Schedules');

		unmount(component);
	});

	it('marks Sessions active for session detail paths', () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/sessions/ses-7af3' }
		});

		const active = document.querySelector('[data-cinder-navigation-item][aria-current]');
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

	// Regression: the nav overflows onto the search/health/settings controls at
	// narrow container widths. Cinder's NavigationBar collapses the tab list
	// behind a menu toggle to prevent that, but only if the bar opts in via a
	// `menuToggle` snippet and forwards the `variant` it hands the `items`
	// snippet — both were previously missing.
	it('opens the mobile tab list from the menu toggle with the mobile variant applied', async () => {
		const component = mount(TopNav, {
			target: document.body,
			props: { currentPath: '/' }
		});

		const toggle = document.querySelector('button[aria-label="Toggle navigation menu"]');
		expect(toggle).not.toBeNull();
		expect(toggle!.getAttribute('aria-expanded')).toBe('false');

		(toggle as HTMLButtonElement).click();
		await vi.waitFor(() => expect(toggle!.getAttribute('aria-expanded')).toBe('true'));

		const items = document.querySelectorAll('a[data-cinder-navigation-item]');
		expect(items).toHaveLength(5);
		for (const item of items) {
			expect(item.getAttribute('data-variant')).toBe('mobile');
		}

		unmount(component);
	});
});
