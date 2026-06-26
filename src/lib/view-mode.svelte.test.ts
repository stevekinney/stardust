import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { viewMode } from './view-mode.svelte';

describe('viewMode store', () => {
	beforeEach(() => {
		localStorage.clear();
		// Reset to default after each suite bootstraps
		viewMode.set('operator');
	});

	afterEach(() => {
		localStorage.clear();
		viewMode.set('operator');
	});

	it('defaults to operator mode', () => {
		expect(viewMode.mode).toBe('operator');
	});

	it('isEngineer is false in operator mode', () => {
		expect(viewMode.isEngineer).toBe(false);
	});

	it('set() changes mode to engineer', () => {
		viewMode.set('engineer');
		expect(viewMode.mode).toBe('engineer');
	});

	it('isEngineer is true in engineer mode', () => {
		viewMode.set('engineer');
		expect(viewMode.isEngineer).toBe(true);
	});

	it('set() persists mode to localStorage', () => {
		viewMode.set('engineer');
		expect(localStorage.getItem('stardust-view-mode')).toBe('engineer');
	});

	it('set() can switch back to operator', () => {
		viewMode.set('engineer');
		viewMode.set('operator');
		expect(viewMode.mode).toBe('operator');
		expect(localStorage.getItem('stardust-view-mode')).toBe('operator');
	});
});
