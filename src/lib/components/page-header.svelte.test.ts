import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import PageHeader from './page-header.svelte';

describe('PageHeader', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the title as an h1', () => {
		const component = mount(PageHeader, {
			target: document.body,
			props: { title: 'Schedules' }
		});

		const heading = document.querySelector('h1');
		expect(heading).not.toBeNull();
		expect(heading!.textContent).toBe('Schedules');

		unmount(component);
	});

	it('renders the meta text when provided', () => {
		const component = mount(PageHeader, {
			target: document.body,
			props: { title: 'Approvals', meta: '3 pending' }
		});

		const meta = document.querySelector('.page-meta');
		expect(meta).not.toBeNull();
		expect(meta!.textContent).toBe('3 pending');

		unmount(component);
	});

	it('does not render meta when not provided', () => {
		const component = mount(PageHeader, {
			target: document.body,
			props: { title: 'Settings' }
		});

		const meta = document.querySelector('.page-meta');
		expect(meta).toBeNull();

		unmount(component);
	});

	it('has the banner role', () => {
		const component = mount(PageHeader, {
			target: document.body,
			props: { title: 'Memory' }
		});

		const banner = document.querySelector('[role="banner"]');
		expect(banner).not.toBeNull();

		unmount(component);
	});
});
