import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from './+page.svelte';

const SETTINGS_KEY = 'stardust-settings';

function mountSettingsPage() {
	return mount(SettingsPage, {
		target: document.body,
		props: {
			params: {},
			data: {
				localDataPaths: [
					{ label: 'Database', value: '/project/local.db' },
					{ label: 'Artifacts', value: '/project/artifacts' },
					{ label: 'Workspaces', value: '/project/workspaces' }
				]
			},
			form: undefined
		}
	});
}

function findButton(label: string) {
	const button = Array.from(document.querySelectorAll('button')).find(
		(candidate) => candidate.textContent?.trim() === label
	);
	expect(button).toBeDefined();
	return button as HTMLButtonElement;
}

async function openResetDialog() {
	findButton('Reset all local state').click();
	flushSync();
	await vi.waitFor(() =>
		expect(document.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true)
	);
}

describe('Settings', () => {
	afterEach(() => {
		document.body.innerHTML = '';
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('renders the page heading in a banner landmark', () => {
		const component = mountSettingsPage();

		const banner = document.querySelector('[role="banner"]');
		expect(banner?.querySelector('h1')?.textContent).toBe('Settings');

		unmount(component);
	});

	it('opens the Cinder confirmation dialog before resetting local data', async () => {
		const confirm = vi.spyOn(window, 'confirm');
		localStorage.setItem('stardust-workspace', 'preserved');
		const component = mountSettingsPage();

		await openResetDialog();

		expect(document.body.textContent).toContain('Reset all local state?');
		expect(document.body.textContent).toContain('Reset local state');
		expect(localStorage.getItem('stardust-workspace')).toBe('preserved');
		expect(confirm).not.toHaveBeenCalled();

		unmount(component);
	});

	it('uses an app-owned class for the reset button layout hook', () => {
		const component = mountSettingsPage();

		expect(findButton('Reset all local state').classList.contains('reset-local-state-button')).toBe(
			true
		);

		unmount(component);
	});

	it('renders configured local data paths from route data', () => {
		const component = mountSettingsPage();

		expect(document.body.textContent).toContain('/project/local.db');
		expect(document.body.textContent).toContain('/project/artifacts');
		expect(document.body.textContent).toContain('/project/workspaces');
		expect(document.body.textContent).not.toContain('~/.stardust/stardust.db');

		unmount(component);
	});

	it('leaves local data unchanged when the dialog is cancelled', async () => {
		localStorage.setItem('stardust-workspace', 'preserved');
		const component = mountSettingsPage();

		await openResetDialog();
		findButton('Cancel').click();
		flushSync();
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLDialogElement>('dialog')?.open ?? false).toBe(false)
		);

		expect(localStorage.getItem('stardust-workspace')).toBe('preserved');

		unmount(component);
	});

	it('leaves local data unchanged when the dialog is dismissed with Escape', async () => {
		localStorage.setItem('stardust-workspace', 'preserved');
		const component = mountSettingsPage();

		await openResetDialog();
		document.querySelector<HTMLDialogElement>('dialog')?.dispatchEvent(new KeyboardEvent('cancel'));
		flushSync();
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLDialogElement>('dialog')?.open ?? false).toBe(false)
		);

		expect(localStorage.getItem('stardust-workspace')).toBe('preserved');

		unmount(component);
	});

	it('leaves local data unchanged when the dialog is dismissed from the backdrop', async () => {
		localStorage.setItem('stardust-workspace', 'preserved');
		const component = mountSettingsPage();

		await openResetDialog();
		document.querySelector<HTMLDialogElement>('dialog')?.click();
		flushSync();
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLDialogElement>('dialog')?.open ?? false).toBe(false)
		);

		expect(localStorage.getItem('stardust-workspace')).toBe('preserved');

		unmount(component);
	});

	it('leaves local data unchanged when the dialog is closed from the close button', async () => {
		localStorage.setItem('stardust-workspace', 'preserved');
		const component = mountSettingsPage();

		await openResetDialog();
		const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]');
		expect(close).not.toBeNull();
		close!.click();
		flushSync();
		await vi.waitFor(() =>
			expect(document.querySelector<HTMLDialogElement>('dialog')?.open ?? false).toBe(false)
		);

		expect(localStorage.getItem('stardust-workspace')).toBe('preserved');

		unmount(component);
	});

	it('clears local data when the dialog is confirmed', async () => {
		localStorage.setItem('stardust-workspace', 'deleted');
		localStorage.setItem(
			SETTINGS_KEY,
			JSON.stringify({
				model: 'claude-opus-4-8',
				theme: 'light',
				maxBudgetUsd: 19,
				tokensPerRun: 900000
			})
		);
		const component = mountSettingsPage();

		await openResetDialog();
		findButton('Reset local state').click();
		flushSync();

		expect(localStorage.getItem('stardust-workspace')).toBeNull();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		unmount(component);
	});
});
