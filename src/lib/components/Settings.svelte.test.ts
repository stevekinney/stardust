import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Settings from './Settings.svelte';
import { viewMode } from '$lib/view-mode.svelte';

describe('Settings', () => {
	beforeEach(() => {
		localStorage.clear();
		viewMode.set('operator');
	});

	afterEach(() => {
		document.body.innerHTML = '';
		localStorage.clear();
		viewMode.set('operator');
		document.documentElement.removeAttribute('data-theme');
	});

	it('renders the settings drawer when open', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const drawer = document.querySelector('dialog');
		expect(drawer).not.toBeNull();

		unmount(component);
	});

	it('does not show drawer content when closed', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: false }
		});
		flushSync();

		// The dialog element should not exist when closed
		const openDialog = document.querySelector('dialog[open]');
		expect(openDialog).toBeNull();

		unmount(component);
	});

	it('renders model and budget sections when open', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toContain('Model');
		expect(text).toContain('Budget');
		expect(text).toContain('Appearance');
		expect(text).toContain('Local Data');

		unmount(component);
	});

	it('renders theme control with system/light/dark options', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toContain('System');
		expect(text).toContain('Light');
		expect(text).toContain('Dark');

		unmount(component);
	});

	it('renders default view control with operator/engineer options', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toContain('Operator');
		expect(text).toContain('Engineer');

		unmount(component);
	});

	it('renders clear local data button', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const buttons = Array.from(document.querySelectorAll('button'));
		const clearButton = buttons.find((b) => b.textContent?.includes('Clear local data'));
		expect(clearButton).not.toBeUndefined();

		unmount(component);
	});

	it('renders save and cancel buttons', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const buttons = Array.from(document.querySelectorAll('button'));
		const saveButton = buttons.find((b) => b.textContent?.includes('Save'));
		const cancelButton = buttons.find((b) => b.textContent?.includes('Cancel'));
		expect(saveButton).not.toBeUndefined();
		expect(cancelButton).not.toBeUndefined();

		unmount(component);
	});

	it('save persists settings to localStorage', () => {
		const component = mount(Settings, {
			target: document.body,
			props: { open: true }
		});
		flushSync();

		const buttons = Array.from(document.querySelectorAll('button'));
		const saveButton = buttons.find((b) => b.textContent?.includes('Save settings'));
		saveButton?.click();
		flushSync();

		const stored = localStorage.getItem('stardust-settings');
		expect(stored).not.toBeNull();

		unmount(component);
	});
});
