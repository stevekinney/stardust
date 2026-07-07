import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KeyboardShortcutsDialog from './keyboard-shortcuts-dialog.svelte';
import { KEYBOARD_SHORTCUTS } from '$lib/keyboard-shortcuts';

describe('KeyboardShortcutsDialog', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	function dialog() {
		return document.querySelector<HTMLDialogElement>('dialog');
	}

	it('is closed by default', () => {
		const component = mount(KeyboardShortcutsDialog, {
			target: document.body,
			props: { open: false }
		});

		expect(dialog()?.open ?? false).toBe(false);

		unmount(component);
	});

	it('opens on "?" and closes on Escape', async () => {
		const component = mount(KeyboardShortcutsDialog, {
			target: document.body,
			props: { open: false }
		});

		window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
		flushSync();
		await vi.waitFor(() => expect(dialog()?.open).toBe(true));

		expect(document.body.textContent).toContain('Keyboard shortcuts');
		for (const shortcut of KEYBOARD_SHORTCUTS) {
			expect(document.body.textContent).toContain(shortcut.description);
		}

		dialog()?.dispatchEvent(new KeyboardEvent('cancel'));
		flushSync();
		await vi.waitFor(() => expect(dialog()?.open ?? false).toBe(false));

		unmount(component);
	});

	it('does not open on "?" when typed inside an editable field', async () => {
		const component = mount(KeyboardShortcutsDialog, {
			target: document.body,
			props: { open: false }
		});

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
		flushSync();

		expect(dialog()?.open ?? false).toBe(false);

		unmount(component);
	});
});
