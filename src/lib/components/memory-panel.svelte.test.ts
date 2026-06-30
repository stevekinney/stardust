import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryNote, MemoryCandidate } from '$lib/server/memory/memory-store';
import MemoryPanel from './memory-panel.svelte';

const sessionNote: MemoryNote = {
	id: 'note-001',
	sessionId: 'session-001',
	layer: 'session',
	content: 'User is working on a data pipeline project.',
	tags: ['summary'],
	runId: null,
	confirmedAt: '2026-06-26T00:00:00.000Z',
	createdAt: '2026-06-26T00:00:00.000Z',
	updatedAt: '2026-06-26T00:00:00.000Z'
};

const durableNote: MemoryNote = {
	id: 'note-002',
	sessionId: 'session-001',
	layer: 'durable',
	content: 'User prefers verbose error messages.',
	tags: ['preference'],
	runId: null,
	confirmedAt: '2026-06-26T00:00:00.000Z',
	createdAt: '2026-06-26T00:00:00.000Z',
	updatedAt: '2026-06-26T00:00:00.000Z'
};

const actionNote: MemoryNote = {
	id: 'note-003',
	sessionId: 'session-001',
	layer: 'action_sensitive',
	content: 'Do not delete files in /prod without explicit approval.',
	tags: ['boundary'],
	runId: 'run-001',
	confirmedAt: '2026-06-26T00:00:00.000Z',
	createdAt: '2026-06-26T00:00:00.000Z',
	updatedAt: '2026-06-26T00:00:00.000Z'
};

const candidate: MemoryCandidate = {
	id: 'cand-001',
	sessionId: 'session-001',
	runId: 'run-001',
	layer: 'durable',
	content: 'User wants log output trimmed to 200 lines.',
	tags: ['preference'],
	reason: 'Stated during run.',
	createdAt: '2026-06-26T00:00:30.000Z'
};

describe('MemoryPanel', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders session, durable, and action-sensitive memory notes by layer', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [sessionNote, durableNote, actionNote], candidates: [] }
		});

		expect(document.body.textContent).toContain('Session');
		expect(document.body.textContent).toContain('Durable');
		expect(document.body.textContent).toContain('Action-Sensitive');
		expect(document.body.textContent).toContain('User is working on a data pipeline project.');
		expect(document.body.textContent).toContain('User prefers verbose error messages.');
		expect(document.body.textContent).toContain('Do not delete files in /prod');

		unmount(component);
	});

	it('renders candidate review controls: approve, edit, discard', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [], candidates: [candidate] }
		});

		expect(document.body.textContent).toContain('User wants log output trimmed to 200 lines.');
		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		const discardButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Discard'
		);
		expect(approveButton).not.toBeUndefined();
		expect(discardButton).not.toBeUndefined();

		unmount(component);
	});

	it('fires onApproveCandidate with candidate id when Approve is clicked', () => {
		const approved: string[] = [];
		const component = mount(MemoryPanel, {
			target: document.body,
			props: {
				notes: [],
				candidates: [candidate],
				onApproveCandidate: (id: string) => {
					approved.push(id);
				}
			}
		});

		const approveButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Approve'
		);
		approveButton?.click();
		flushSync();

		expect(approved).toEqual(['cand-001']);

		unmount(component);
	});

	it('fires onEditCandidate with candidate id when Edit is clicked', () => {
		const edited: string[] = [];
		const component = mount(MemoryPanel, {
			target: document.body,
			props: {
				notes: [],
				candidates: [candidate],
				onEditCandidate: (id: string) => {
					edited.push(id);
				}
			}
		});

		const editButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Edit'
		);
		editButton?.click();
		flushSync();

		expect(edited).toEqual(['cand-001']);

		unmount(component);
	});

	it('fires onDiscardCandidate with candidate id when Discard is clicked', () => {
		const discarded: string[] = [];
		const component = mount(MemoryPanel, {
			target: document.body,
			props: {
				notes: [],
				candidates: [candidate],
				onDiscardCandidate: (id: string) => {
					discarded.push(id);
				}
			}
		});

		const discardButton = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Discard'
		);
		discardButton?.click();
		flushSync();

		expect(discarded).toEqual(['cand-001']);

		unmount(component);
	});

	it('shows empty state when no notes and no candidates', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [], candidates: [] }
		});

		expect(document.body.textContent).toContain('No memory');

		unmount(component);
	});

	it('shows candidate reason when provided', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [], candidates: [candidate] }
		});

		expect(document.body.textContent).toContain('Stated during run.');

		unmount(component);
	});

	it('shows runId provenance when note.runId is set', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [actionNote], candidates: [] }
		});

		const el = document.querySelector('[data-run-id]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toContain('run-001');

		unmount(component);
	});

	it('omits runId provenance when note.runId is null', () => {
		const component = mount(MemoryPanel, {
			target: document.body,
			props: { notes: [sessionNote], candidates: [] }
		});

		const el = document.querySelector('[data-run-id]');
		expect(el).toBeNull();

		unmount(component);
	});
});
