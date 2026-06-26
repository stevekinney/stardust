/**
 * SSR regression tests for ViewModeStore.
 *
 * This file intentionally has no `.svelte.` in its name so that vitest routes it
 * to the node project (environment: 'node') rather than the browser (chromium) project.
 * All six tests in view-mode.svelte.test.ts run only in an environment where
 * `window` is always defined, so a regression back to the old `typeof localStorage`
 * guard would not be caught there.
 *
 * The critical regression scenario: the old guard was `typeof localStorage !== 'undefined'`.
 * In some server runtimes (and in this test) `localStorage` can be defined while
 * `window` is not. The old guard would enter the constructor body and call
 * `localStorage.getItem`, which is incorrect in an SSR context. The new guard
 * (`typeof window !== 'undefined'`) skips that block entirely.
 *
 * How the test proves the guard matters:
 *   - A `localStorage` stub with a spy is installed on `globalThis` before each test.
 *   - `window` is absent (we assert this explicitly).
 *   - With the old guard: the spy would be called → test FAILS (red).
 *   - With the new guard: the spy is never called → test PASSES (green).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewModeStore } from './view-mode.svelte';

describe('ViewModeStore – SSR (no window)', () => {
	let getItemSpy: ReturnType<typeof vi.fn>;
	let setItemSpy: ReturnType<typeof vi.fn>;
	let originalDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		getItemSpy = vi.fn().mockReturnValue(null);
		setItemSpy = vi.fn();

		originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

		// Install a localStorage stub while window remains absent.
		// With the old `typeof localStorage` guard this spy would be called,
		// proving the test is a genuine regression gate.
		Object.defineProperty(globalThis, 'localStorage', {
			value: {
				getItem: getItemSpy,
				setItem: setItemSpy,
				removeItem: vi.fn(),
				clear: vi.fn()
			},
			configurable: true,
			writable: true
		});
	});

	afterEach(() => {
		if (originalDescriptor !== undefined) {
			Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
		} else {
			try {
				delete (globalThis as Record<string, unknown>)['localStorage'];
			} catch {
				// Non-configurable in this runtime — best-effort reset to undefined.
				(globalThis as Record<string, unknown>)['localStorage'] = undefined;
			}
		}
	});

	it('runs in a node environment where window is absent', () => {
		expect(typeof window).toBe('undefined');
	});

	it('defaults to operator mode without reading localStorage when window is absent', () => {
		const store = new ViewModeStore();
		expect(store.mode).toBe('operator');
		expect(getItemSpy).not.toHaveBeenCalled();
	});

	it('does not throw when constructed in a window-less SSR environment', () => {
		expect(() => new ViewModeStore()).not.toThrow();
	});

	it('set() updates mode in memory without writing to localStorage when window is absent', () => {
		const store = new ViewModeStore();
		store.set('engineer');
		expect(store.mode).toBe('engineer');
		expect(setItemSpy).not.toHaveBeenCalled();
	});

	it('isEngineer reflects the in-memory mode correctly in SSR', () => {
		const store = new ViewModeStore();
		expect(store.isEngineer).toBe(false);
		store.set('engineer');
		expect(store.isEngineer).toBe(true);
	});
});
