import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { viewMode } from './view-mode.svelte';

describe('viewMode store', () => {
	beforeEach(() => {
		localStorage.clear();
		viewMode.set();
	});

	afterEach(() => {
		localStorage.clear();
		viewMode.set();
	});

	it('defaults to engineer mode', () => {
		expect(viewMode.mode).toBe('engineer');
	});

	it('isEngineer is always true', () => {
		expect(viewMode.isEngineer).toBe(true);
	});

	it('set() persists engineer mode to localStorage', () => {
		viewMode.set();
		expect(localStorage.getItem('stardust-view-mode')).toBe('engineer');
	});

	it('set() ignores attempts to switch back to operator', () => {
		viewMode.set();
		expect(viewMode.mode).toBe('engineer');
		expect(viewMode.isEngineer).toBe(true);
		expect(localStorage.getItem('stardust-view-mode')).toBe('engineer');
	});
});
