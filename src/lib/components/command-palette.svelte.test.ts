import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPaletteHost from './command-palette.svelte';

describe('CommandPalette host', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith('/api/schedules')) {
					return new Response(JSON.stringify({ schedules: [] }), { status: 200 });
				}
				if (url.endsWith('/api/sessions')) {
					return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
				}
				return new Response(JSON.stringify({ approvals: [], notes: [], candidates: [] }), {
					status: 200
				});
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	it('opens on meta+k and closes on escape', async () => {
		const component = mount(CommandPaletteHost, {
			target: document.body,
			props: { open: false }
		});

		const dialog = () =>
			document.querySelector<HTMLDialogElement>('dialog[aria-label="Command palette"]');
		expect(dialog()?.open ?? false).toBe(false);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
		flushSync();
		await vi.waitFor(() => expect(dialog()?.open).toBe(true));

		expect(document.body.textContent).toContain('New session');
		expect(document.body.textContent).toContain('Open Temporal Web');
		expect(document.body.textContent).toContain('every action here is durable');

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
		flushSync();
		await vi.waitFor(() => expect(dialog()?.open ?? false).toBe(false));

		unmount(component);
	});
});
