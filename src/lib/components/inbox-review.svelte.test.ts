import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InboxReview from './inbox-review.svelte';
import type { InboxMemoryCandidate } from '$lib/types';

const candidate: InboxMemoryCandidate = {
	id: 'cand-001',
	sessionId: 'uuid-1',
	sessionKey: 'sess-key-1',
	runId: 'run-1',
	layer: 'durable',
	content: 'Prefers Bun over npm for all commands',
	tags: [],
	reason: null,
	createdAt: new Date().toISOString()
};

describe('InboxReview', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders pending candidates with save and discard actions', () => {
		const onSave = vi.fn();
		const onDiscard = vi.fn();
		const component = mount(InboxReview, {
			target: document.body,
			props: { candidates: [candidate], decisions: {}, onSave, onDiscard }
		});

		expect(document.body.textContent).toContain('Prefers Bun over npm');
		expect(document.body.textContent).toContain('from sess-key-1');

		const buttons = Array.from(document.querySelectorAll('button'));
		buttons.find((b) => b.textContent?.trim() === 'Save')!.click();
		expect(onSave).toHaveBeenCalledWith(candidate);
		buttons.find((b) => b.textContent?.trim() === 'Discard')!.click();
		expect(onDiscard).toHaveBeenCalledWith(candidate);

		unmount(component);
	});

	it('shows decided candidates struck through without actions', () => {
		const component = mount(InboxReview, {
			target: document.body,
			props: {
				candidates: [candidate],
				decisions: { 'cand-001': 'saved' as const },
				onSave: vi.fn(),
				onDiscard: vi.fn()
			}
		});

		expect(document.querySelector('.candidate-text.decided')).not.toBeNull();
		expect(document.body.textContent).toContain('saved to memory');
		expect(document.querySelectorAll('button')).toHaveLength(0);

		unmount(component);
	});

	it('renders an empty state when there are no candidates', () => {
		const component = mount(InboxReview, {
			target: document.body,
			props: { candidates: [], decisions: {}, onSave: vi.fn(), onDiscard: vi.fn() }
		});

		expect(document.body.textContent).toContain('No memory candidates waiting for review.');

		unmount(component);
	});
});
