import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_DATA_TOOL } from '../policy/risk';
import {
	definePublicDataTools,
	feedReadInput,
	hackerNewsReadInput,
	lookupWeather,
	lookupWikipedia,
	readFeed,
	readHackerNews,
	weatherLookupInput,
	wikipediaLookupInput
} from './public-data';

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
	<channel>
		<title>Example RSS Feed</title>
		<item>
			<title>First post</title>
			<link>https://example.test/1</link>
			<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
			<description><![CDATA[A <b>short</b> summary]]></description>
		</item>
		<item>
			<title>Second post</title>
			<link>https://example.test/2</link>
		</item>
	</channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Example Atom Feed</title>
	<entry>
		<title>Atom entry</title>
		<link rel="self" href="https://example.test/self"/>
		<link rel="alternate" href="https://example.test/entry-1"/>
		<updated>2024-02-02T00:00:00Z</updated>
		<summary>Atom summary text</summary>
	</entry>
</feed>`;

function textResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'content-type': 'application/xml' } });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('public-data tools', () => {
	// ── feed.read ───────────────────────────────────────────────────────────────

	describe('feed.read', () => {
		it('parses RSS 2.0 feeds, tolerating missing fields', async () => {
			const fetcher = vi.fn(async () => textResponse(RSS_FEED));

			const result = await readFeed(
				{ url: 'https://example.test/feed.xml', maxItems: 10 },
				{ fetcher }
			);

			expect(result.feedTitle).toBe('Example RSS Feed');
			expect(result.items).toEqual([
				{
					title: 'First post',
					link: 'https://example.test/1',
					publishedAt: 'Mon, 01 Jan 2024 00:00:00 GMT',
					summary: 'A <b>short</b> summary'
				},
				{
					title: 'Second post',
					link: 'https://example.test/2',
					publishedAt: null,
					summary: ''
				}
			]);
		});

		it('parses Atom feeds, preferring the alternate link', async () => {
			const fetcher = vi.fn(async () => textResponse(ATOM_FEED));

			const result = await readFeed(
				{ url: 'https://example.test/atom.xml', maxItems: 10 },
				{ fetcher }
			);

			expect(result.feedTitle).toBe('Example Atom Feed');
			expect(result.items).toEqual([
				{
					title: 'Atom entry',
					link: 'https://example.test/entry-1',
					publishedAt: '2024-02-02T00:00:00Z',
					summary: 'Atom summary text'
				}
			]);
		});

		it('truncates long summaries to ~500 characters', async () => {
			const longSummary = 'x'.repeat(1000);
			const feed = `<rss version="2.0"><channel><title>T</title><item><title>I</title><link>https://example.test</link><description>${longSummary}</description></item></channel></rss>`;
			const fetcher = vi.fn(async () => textResponse(feed));

			const result = await readFeed(
				{ url: 'https://example.test/feed.xml', maxItems: 1 },
				{ fetcher }
			);

			expect(result.items[0]?.summary.length).toBeLessThanOrEqual(501);
			expect(result.items[0]?.summary.endsWith('…')).toBe(true);
		});

		it('caps returned items at maxItems', async () => {
			const feed = `<rss version="2.0"><channel><title>T</title>${Array.from(
				{ length: 5 },
				(_, index) =>
					`<item><title>Item ${index}</title><link>https://example.test/${index}</link></item>`
			).join('')}</channel></rss>`;
			const fetcher = vi.fn(async () => textResponse(feed));

			const result = await readFeed(
				{ url: 'https://example.test/feed.xml', maxItems: 2 },
				{ fetcher }
			);

			expect(result.items).toHaveLength(2);
		});

		it('throws a descriptive error on a non-OK HTTP response', async () => {
			const fetcher = vi.fn(async () => textResponse('not found', 404));

			await expect(
				readFeed({ url: 'https://example.test/missing.xml', maxItems: 10 }, { fetcher })
			).rejects.toThrow('feed.read failed with HTTP 404');
		});

		it('throws when the document is neither RSS nor Atom', async () => {
			const fetcher = vi.fn(async () => textResponse('<html><body>not a feed</body></html>'));

			await expect(
				readFeed({ url: 'https://example.test/not-a-feed.html', maxItems: 10 }, { fetcher })
			).rejects.toThrow(/recognize the document/);
		});

		it('rejects SSRF-unsafe hosts (cloud metadata) before making a request', async () => {
			const fetcher = vi.fn(async () => textResponse(RSS_FEED));

			await expect(
				readFeed({ url: 'http://169.254.169.254/latest/meta-data', maxItems: 10 }, { fetcher })
			).rejects.toThrow(/blocked unsafe host/);
			expect(fetcher).not.toHaveBeenCalled();
		});

		it('rejects SSRF-unsafe hosts (localhost) before making a request', async () => {
			const fetcher = vi.fn(async () => textResponse(RSS_FEED));

			await expect(
				readFeed({ url: 'http://localhost:8080/feed.xml', maxItems: 10 }, { fetcher })
			).rejects.toThrow(/blocked unsafe host/);
			expect(fetcher).not.toHaveBeenCalled();
		});

		it('applies schema defaults and enforces the maxItems cap', () => {
			expect(feedReadInput.parse({ url: 'https://example.test/feed.xml' })).toMatchObject({
				maxItems: 10
			});
			expect(
				feedReadInput.safeParse({ url: 'https://example.test/feed.xml', maxItems: 26 }).success
			).toBe(false);
			expect(feedReadInput.safeParse({ url: 'not-a-url' }).success).toBe(false);
		});
	});

	// ── hackernews.read ─────────────────────────────────────────────────────────

	describe('hackernews.read', () => {
		it('fetches the story list then item details concurrently, capped at limit', async () => {
			const fetcher = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.endsWith('/topstories.json')) {
					return jsonResponse([1, 2, 3]);
				}
				if (url.endsWith('/item/1.json')) {
					return jsonResponse({
						id: 1,
						title: 'Story one',
						url: 'https://example.test/1',
						score: 100,
						by: 'alice',
						descendants: 12,
						time: 1_700_000_000
					});
				}
				if (url.endsWith('/item/2.json')) {
					return jsonResponse({
						id: 2,
						title: 'Story two',
						by: 'bob',
						score: 5,
						time: 1_700_000_100
					});
				}
				return jsonResponse({ error: `unexpected request: ${url}` }, 500);
			});

			const result = await readHackerNews({ feed: 'top', limit: 2 }, { fetcher });

			expect(result).toEqual([
				{
					id: 1,
					title: 'Story one',
					url: 'https://example.test/1',
					score: 100,
					by: 'alice',
					commentCount: 12,
					postedAt: new Date(1_700_000_000 * 1000).toISOString()
				},
				{
					id: 2,
					title: 'Story two',
					url: null,
					score: 5,
					by: 'bob',
					commentCount: 0,
					postedAt: new Date(1_700_000_100 * 1000).toISOString()
				}
			]);
			// Only 2 item detail requests should fire even though 3 ids were returned.
			expect(fetcher).toHaveBeenCalledTimes(3);
		});

		it('uses the requested feed endpoint', async () => {
			const fetcher = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes('/askstories.json')) return jsonResponse([42]);
				return jsonResponse({
					id: 42,
					title: 'Ask HN',
					by: 'carol',
					score: 1,
					time: 1_700_000_000
				});
			});

			await readHackerNews({ feed: 'ask', limit: 1 }, { fetcher });

			expect(fetcher).toHaveBeenCalledWith('https://hacker-news.firebaseio.com/v0/askstories.json');
		});

		it('throws a descriptive error on a non-OK HTTP response', async () => {
			const fetcher = vi.fn(async () => jsonResponse({ error: 'unavailable' }, 502));

			await expect(readHackerNews({ feed: 'top', limit: 5 }, { fetcher })).rejects.toThrow(
				'hackernews.read failed with HTTP 502'
			);
		});

		it('applies schema defaults and enforces the limit cap', () => {
			expect(hackerNewsReadInput.parse({})).toEqual({ feed: 'top', limit: 10 });
			expect(hackerNewsReadInput.safeParse({ limit: 31 }).success).toBe(false);
			expect(hackerNewsReadInput.safeParse({ feed: 'invalid' }).success).toBe(false);
		});
	});

	// ── weather.lookup ───────────────────────────────────────────────────────────

	describe('weather.lookup', () => {
		it('geocodes a location then returns current conditions and a forecast', async () => {
			const fetcher = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes('geocoding-api.open-meteo.com')) {
					return jsonResponse({
						results: [
							{ name: 'Boulder', country: 'United States', latitude: 40.01, longitude: -105.27 }
						]
					});
				}
				return jsonResponse({
					current: { temperature_2m: 22.5 },
					daily: {
						time: ['2024-06-01', '2024-06-02'],
						temperature_2m_max: [28, 27],
						temperature_2m_min: [15, 14],
						precipitation_probability_max: [10, 40],
						weather_code: [1, 61]
					}
				});
			});

			const result = await lookupWeather({ location: 'Boulder', days: 2 }, { fetcher });

			expect(result.location).toEqual({
				name: 'Boulder',
				country: 'United States',
				latitude: 40.01,
				longitude: -105.27
			});
			expect(result.current).toEqual({ temperatureC: 22.5 });
			expect(result.daily).toEqual([
				{
					date: '2024-06-01',
					temperatureMaxC: 28,
					temperatureMinC: 15,
					precipitationProbabilityPercent: 10,
					weatherCode: 1,
					description: 'Mainly clear'
				},
				{
					date: '2024-06-02',
					temperatureMaxC: 27,
					temperatureMinC: 14,
					precipitationProbabilityPercent: 40,
					weatherCode: 61,
					description: 'Slight rain'
				}
			]);
		});

		it('throws a descriptive error when geocoding finds no results', async () => {
			const fetcher = vi.fn(async () => jsonResponse({ results: [] }));

			await expect(
				lookupWeather({ location: 'Nowhereville', days: 3 }, { fetcher })
			).rejects.toThrow(/found no location matching/);
		});

		it('throws a descriptive error on a non-OK HTTP response', async () => {
			const fetcher = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));

			await expect(lookupWeather({ location: 'Boulder', days: 3 }, { fetcher })).rejects.toThrow(
				'weather.lookup failed with HTTP 500'
			);
		});

		it('applies schema defaults and enforces the days cap', () => {
			expect(weatherLookupInput.parse({ location: 'Boulder' })).toEqual({
				location: 'Boulder',
				days: 3
			});
			expect(weatherLookupInput.safeParse({ location: 'Boulder', days: 8 }).success).toBe(false);
			expect(weatherLookupInput.safeParse({ location: '' }).success).toBe(false);
		});
	});

	// ── wikipedia.lookup ─────────────────────────────────────────────────────────

	describe('wikipedia.lookup', () => {
		it('searches then fetches page summaries, setting the required User-Agent header', async () => {
			const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const headers = init?.headers as Record<string, string> | undefined;
				expect(headers?.['User-Agent']).toBe('stardust-agent/0.0.1 (local dev agent)');
				if (url.includes('/search/page')) {
					return jsonResponse({ pages: [{ key: 'Svelte', title: 'Svelte' }] });
				}
				return jsonResponse({
					title: 'Svelte',
					description: 'Web framework',
					extract: 'Svelte is a free and open-source component-based front-end framework.',
					content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Svelte' } }
				});
			});

			const result = await lookupWikipedia({ query: 'svelte', limit: 1 }, { fetcher });

			expect(result).toEqual([
				{
					title: 'Svelte',
					description: 'Web framework',
					extract: 'Svelte is a free and open-source component-based front-end framework.',
					url: 'https://en.wikipedia.org/wiki/Svelte'
				}
			]);
		});

		it('tolerates missing description and content_urls fields', async () => {
			const fetcher = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes('/search/page')) return jsonResponse({ pages: [{ key: 'Foo' }] });
				return jsonResponse({ title: 'Foo', extract: 'Foo extract' });
			});

			const result = await lookupWikipedia({ query: 'foo', limit: 1 }, { fetcher });

			expect(result).toEqual([
				{
					title: 'Foo',
					description: null,
					extract: 'Foo extract',
					url: 'https://en.wikipedia.org/wiki/Foo'
				}
			]);
		});

		it('throws a descriptive error on a non-OK HTTP response', async () => {
			const fetcher = vi.fn(async () => jsonResponse({ error: 'boom' }, 503));

			await expect(lookupWikipedia({ query: 'svelte', limit: 1 }, { fetcher })).rejects.toThrow(
				'wikipedia.lookup failed with HTTP 503'
			);
		});

		it('applies schema defaults and enforces the limit cap', () => {
			expect(wikipediaLookupInput.parse({ query: 'svelte' })).toEqual({
				query: 'svelte',
				limit: 1
			});
			expect(wikipediaLookupInput.safeParse({ query: 'svelte', limit: 6 }).success).toBe(false);
			expect(wikipediaLookupInput.safeParse({ query: '' }).success).toBe(false);
		});
	});

	// ── registration ──────────────────────────────────────────────────────────────

	describe('definePublicDataTools', () => {
		it('registers all four tools with PUBLIC_DATA_TOOL metadata', () => {
			const tools = definePublicDataTools();

			expect(tools.map((tool) => tool.name).sort()).toEqual([
				'feed.read',
				'hackernews.read',
				'weather.lookup',
				'wikipedia.lookup'
			]);
			for (const tool of tools) {
				expect(tool.metadata).toEqual(PUBLIC_DATA_TOOL);
				expect(tool.inputSchema.type).toBe('object');
				expect(tool.schema).toBeDefined();
			}
		});
	});
});
