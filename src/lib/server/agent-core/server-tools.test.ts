import { describe, expect, it } from 'vitest';
import { serverToolsForModel } from './server-tools';

describe('serverToolsForModel', () => {
	it.each([
		'claude-opus-4-6',
		'claude-opus-4-7',
		'claude-opus-4-8',
		'claude-sonnet-4-6',
		'claude-sonnet-5',
		'claude-fable-5'
	])('returns the dynamic-filtering variants with no beta header for %s', (model) => {
		expect(serverToolsForModel(model)).toEqual({
			tools: [
				{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
				{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 }
			],
			betaHeaders: []
		});
	});

	it.each([
		'claude-sonnet-4-5-20250929',
		'claude-haiku-4-5-20251001',
		'claude-sonnet-4-20250514',
		'claude-opus-4-1-20250805'
	])('returns the basic variants with the web-fetch beta header for %s', (model) => {
		expect(serverToolsForModel(model)).toEqual({
			tools: [
				{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
				{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 }
			],
			betaHeaders: ['web-fetch-2025-09-10']
		});
	});
});
