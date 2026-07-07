import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReplayScrubber from './replay-scrubber.svelte';

describe('ReplayScrubber', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('shows the LIVE badge when the cursor is pinned to the latest event', () => {
		const component = mount(ReplayScrubber, {
			target: document.body,
			props: { maxSequence: 18, cursor: null, onScrub: vi.fn() }
		});

		expect(document.body.textContent).toContain('LIVE');
		expect(document.body.textContent).toContain('18 / 18 events durable');
		expect(document.body.textContent).not.toContain('REPLAY');

		unmount(component);
	});

	it('shows REPLAY, the cursor summary, and a jump-to-live affordance while scrubbed back', () => {
		const onScrub = vi.fn();
		const component = mount(ReplayScrubber, {
			target: document.body,
			props: {
				maxSequence: 18,
				cursor: 7,
				onScrub,
				cursorSummary: 'tool_call · read_ci_runs'
			}
		});

		expect(document.body.textContent).toContain('REPLAY');
		expect(document.body.textContent).toContain('7 / 18 events durable');
		expect(document.body.textContent).toContain('State rebuilt at event 7');
		expect(document.body.textContent).toContain('tool_call · read_ci_runs');

		const jump = Array.from(document.querySelectorAll('button')).find(
			(button) => button.textContent?.trim() === 'Jump to live'
		);
		expect(jump).toBeDefined();
		jump!.click();
		expect(onScrub).toHaveBeenCalledWith(null);

		unmount(component);
	});

	it('reports null when scrubbed all the way to the latest event', () => {
		const onScrub = vi.fn();
		const component = mount(ReplayScrubber, {
			target: document.body,
			props: { maxSequence: 10, cursor: 4, onScrub }
		});

		const slider = document.querySelector('[role="slider"]') as HTMLElement;
		expect(slider).toBeInstanceOf(HTMLElement);
		expect(slider.getAttribute('aria-valuenow')).toBe('4');
		expect(slider.getAttribute('aria-valuemax')).toBe('10');

		unmount(component);
	});
});
