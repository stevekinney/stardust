import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionRow from './session-row.svelte';
import type { SessionRow as SessionRowData } from '$lib/types';

function makeSession(overrides: Partial<SessionRowData> = {}): SessionRowData {
	return {
		id: 'sess-1',
		sessionKey: 'demo-seed-mr2hx0la',
		status: 'active',
		workflowId: 'agent-session:demo-seed-mr2hx0la',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		name: 'Demonstrate Temporal durability',
		temporalWebUrl:
			'http://localhost:8233/namespaces/default/workflows/agent-session%3Ademo-seed-mr2hx0la',
		...overrides
	};
}

describe('SessionRow', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	// Regression: the workflow-key link had no truncation floor, so at narrow
	// widths the flex layout squeezed the session title down to a couple of
	// characters instead of shrinking the link. The link's session-key text
	// now lives in its own `.wf-chip-key` span (hidden below phone width via
	// CSS) with the full key preserved as an always-present aria-label, so
	// the link stays identifiable to assistive tech regardless of what's
	// visually shown.
	it('renders the workflow link with a stable label independent of the visible key text', () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {} }
		});

		const link = document.querySelector('a.wf-chip');
		expect(link).not.toBeNull();
		expect(link!.getAttribute('aria-label')).toBe('Open demo-seed-mr2hx0la in Temporal Web');
		expect(link!.querySelector('.wf-chip-key')?.textContent).toBe('demo-seed-mr2hx0la');
		expect(link!.getAttribute('href')).toBe(makeSession().temporalWebUrl);

		unmount(component);
	});

	it('omits the workflow link when there is no Temporal Web URL', () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession({ temporalWebUrl: undefined }), onOpen: () => {} }
		});

		expect(document.querySelector('a.wf-chip')).toBeNull();

		unmount(component);
	});

	it('omits the rename trigger when onRename is not provided', () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {} }
		});

		expect(document.querySelector('.rename-trigger')).toBeNull();

		unmount(component);
	});

	it('swaps the title for an editable input when the rename trigger is clicked', async () => {
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {}, onRename: () => {} }
		});

		const trigger = document.querySelector('.rename-trigger') as HTMLButtonElement;
		expect(trigger).toBeInstanceOf(HTMLElement);
		trigger.click();
		await Promise.resolve();

		const input = document.querySelector('.title-input') as HTMLInputElement | null;
		expect(input).toBeInstanceOf(HTMLInputElement);
		expect(input!.value).toBe('Demonstrate Temporal durability');

		unmount(component);
	});

	it('commits a rename on Enter and calls onRename with the trimmed value', async () => {
		const onRename = vi.fn();
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {}, onRename }
		});

		(document.querySelector('.rename-trigger') as HTMLButtonElement).click();
		await Promise.resolve();

		const input = document.querySelector('.title-input') as HTMLInputElement;
		input.value = '  Renamed session  ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		input.dispatchEvent(new Event('blur', { bubbles: true }));
		await Promise.resolve();

		expect(onRename).toHaveBeenCalledWith(makeSession(), 'Renamed session');
		expect(document.querySelector('.title-input')).toBeNull();
		expect(document.querySelector('.title')?.textContent).toBe('Demonstrate Temporal durability');

		unmount(component);
	});

	it('cancels a rename on Escape without calling onRename', async () => {
		const onRename = vi.fn();
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {}, onRename }
		});

		(document.querySelector('.rename-trigger') as HTMLButtonElement).click();
		await Promise.resolve();

		const input = document.querySelector('.title-input') as HTMLInputElement;
		input.value = 'Ignored edit';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await Promise.resolve();

		expect(onRename).not.toHaveBeenCalled();
		expect(document.querySelector('.title-input')).toBeNull();

		unmount(component);
	});

	it('does not commit an empty rename', async () => {
		const onRename = vi.fn();
		const component = mount(SessionRow, {
			target: document.body,
			props: { session: makeSession(), onOpen: () => {}, onRename }
		});

		(document.querySelector('.rename-trigger') as HTMLButtonElement).click();
		await Promise.resolve();

		const input = document.querySelector('.title-input') as HTMLInputElement;
		input.value = '   ';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('blur', { bubbles: true }));
		await Promise.resolve();

		expect(onRename).not.toHaveBeenCalled();

		unmount(component);
	});
});
