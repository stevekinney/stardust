import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { PUBLIC_DATA_TOOL } from '../policy/risk';
import { fetchWithSsrfGuard } from '../policy/ssrf';
import type { RegisteredTool } from '../policy/policy-engine';
import { defineStardustTool } from './define-tool';

type Fetcher = typeof fetch;

const WIKIPEDIA_USER_AGENT = 'stardust-agent/0.0.1 (local dev agent)';
const SUMMARY_MAX_LENGTH = 500;
const WIKIPEDIA_EXTRACT_MAX_LENGTH = 2_000;
const FEED_MAX_RESPONSE_BYTES = 2_000_000;

/** Truncates `text` to `maxLength` characters, appending an ellipsis when cut. */
function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

// ── feed.read ───────────────────────────────────────────────────────────────

/** Input schema for `feed.read` — fetches and parses an RSS 2.0 or Atom feed. */
export const feedReadInput = z.object({
	url: z.string().url(),
	maxItems: z.number().int().positive().max(25).default(10)
});

/** A single normalized entry from an RSS or Atom feed. */
export type FeedItem = {
	title: string;
	link: string;
	publishedAt: string | null;
	summary: string;
};

/** Normalized result of reading a feed via `feed.read`. */
export type FeedReadResult = {
	feedTitle: string;
	items: FeedItem[];
};

type XmlNode = Record<string, unknown>;

/** Wraps a possibly-singular fast-xml-parser node in an array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

/** Extracts the text content of a fast-xml-parser node, tolerant of missing values. */
function textOf(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value && typeof value === 'object' && '#text' in (value as XmlNode)) {
		const text = (value as XmlNode)['#text'];
		return typeof text === 'string' ? text : '';
	}
	return '';
}

/** Extracts the href from an Atom `<link>` element, preferring `rel="alternate"`. */
function extractAtomLink(link: unknown): string {
	const candidates = asArray(link as XmlNode | XmlNode[] | undefined);
	let fallbackHref = '';
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== 'object') continue;
		const href = (candidate as XmlNode)['@_href'];
		if (typeof href !== 'string') continue;
		const rel = (candidate as XmlNode)['@_rel'];
		if (rel === undefined || rel === 'alternate') return href;
		if (!fallbackHref) fallbackHref = href;
	}
	return fallbackHref || textOf(link);
}

function parseRssFeed(rss: XmlNode, maxItems: number): FeedReadResult {
	const channel = (rss.channel ?? {}) as XmlNode;
	const items = asArray(channel.item as XmlNode | XmlNode[] | undefined)
		.slice(0, maxItems)
		.map((item) => ({
			title: textOf(item.title) || '(untitled)',
			link: textOf(item.link),
			publishedAt: textOf(item.pubDate) || null,
			summary: truncate(textOf(item.description ?? item['content:encoded']), SUMMARY_MAX_LENGTH)
		}));
	return { feedTitle: textOf(channel.title) || '(untitled feed)', items };
}

function parseAtomFeed(feed: XmlNode, maxItems: number): FeedReadResult {
	const items = asArray(feed.entry as XmlNode | XmlNode[] | undefined)
		.slice(0, maxItems)
		.map((entry) => ({
			title: textOf(entry.title) || '(untitled)',
			link: extractAtomLink(entry.link),
			publishedAt: textOf(entry.published) || textOf(entry.updated) || null,
			summary: truncate(textOf(entry.summary ?? entry.content), SUMMARY_MAX_LENGTH)
		}));
	return { feedTitle: textOf(feed.title) || '(untitled feed)', items };
}

/** Parses an RSS 2.0 or Atom document into a normalized `FeedReadResult`. */
function parseFeed(xml: string, maxItems: number): FeedReadResult {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: '@_',
		textNodeName: '#text'
	});
	const parsed = parser.parse(xml) as XmlNode;

	if (parsed.feed && typeof parsed.feed === 'object') {
		return parseAtomFeed(parsed.feed as XmlNode, maxItems);
	}
	if (parsed.rss && typeof parsed.rss === 'object') {
		return parseRssFeed(parsed.rss as XmlNode, maxItems);
	}
	throw new Error('feed.read could not recognize the document as RSS or Atom');
}

/**
 * Fetches a model-supplied feed URL (guarded against SSRF via `fetchWithSsrfGuard`)
 * and parses it as RSS 2.0 or Atom, tolerant of missing fields.
 */
export async function readFeed(
	args: z.infer<typeof feedReadInput>,
	{ fetcher }: { fetcher?: Fetcher } = {}
): Promise<FeedReadResult> {
	const response = await fetchWithSsrfGuard(
		{ url: args.url, maxBytes: FEED_MAX_RESPONSE_BYTES },
		fetcher ?? fetch
	);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`feed.read failed with HTTP ${response.status}`);
	}
	return parseFeed(response.body, args.maxItems);
}

// ── hackernews.read ─────────────────────────────────────────────────────────

/** Input schema for `hackernews.read` — reads stories from a Hacker News feed. */
export const hackerNewsReadInput = z.object({
	feed: z.enum(['top', 'new', 'best', 'ask', 'show']).default('top'),
	limit: z.number().int().positive().max(30).default(10)
});

/** A normalized Hacker News story. */
export type HackerNewsItem = {
	id: number;
	title: string;
	url: string | null;
	score: number;
	by: string;
	commentCount: number;
	postedAt: string;
};

const HACKER_NEWS_FEED_ENDPOINTS = {
	top: 'topstories',
	new: 'newstories',
	best: 'beststories',
	ask: 'askstories',
	show: 'showstories'
} as const;

function normalizeHackerNewsItem(raw: Record<string, unknown>): HackerNewsItem {
	return {
		id: typeof raw.id === 'number' ? raw.id : 0,
		title: typeof raw.title === 'string' ? raw.title : '(untitled)',
		url: typeof raw.url === 'string' ? raw.url : null,
		score: typeof raw.score === 'number' ? raw.score : 0,
		by: typeof raw.by === 'string' ? raw.by : 'unknown',
		commentCount: typeof raw.descendants === 'number' ? raw.descendants : 0,
		postedAt:
			typeof raw.time === 'number'
				? new Date(raw.time * 1000).toISOString()
				: new Date(0).toISOString()
	};
}

/**
 * Reads the Hacker News Firebase API: fetches a story-id feed, then fetches
 * item details for up to `limit` stories concurrently.
 */
export async function readHackerNews(
	args: z.infer<typeof hackerNewsReadInput>,
	{ fetcher }: { fetcher?: Fetcher } = {}
): Promise<HackerNewsItem[]> {
	const fetchFn = fetcher ?? fetch;
	const endpoint = HACKER_NEWS_FEED_ENDPOINTS[args.feed];
	const listResponse = await fetchFn(`https://hacker-news.firebaseio.com/v0/${endpoint}.json`);
	if (!listResponse.ok) {
		throw new Error(`hackernews.read failed with HTTP ${listResponse.status}`);
	}
	const ids = (await listResponse.json()) as unknown;
	if (!Array.isArray(ids)) {
		throw new Error('hackernews.read received a malformed story list');
	}
	const capped = ids.slice(0, args.limit).filter((id): id is number => typeof id === 'number');

	return Promise.all(
		capped.map(async (id) => {
			const itemResponse = await fetchFn(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
			if (!itemResponse.ok) {
				throw new Error(`hackernews.read failed with HTTP ${itemResponse.status}`);
			}
			const raw = (await itemResponse.json()) as Record<string, unknown>;
			return normalizeHackerNewsItem(raw);
		})
	);
}

// ── weather.lookup ───────────────────────────────────────────────────────────

/** Input schema for `weather.lookup` — geocodes a location, then fetches its forecast. */
export const weatherLookupInput = z.object({
	location: z.string().min(1),
	days: z.number().int().positive().max(7).default(3)
});

/** A geocoded location returned by the Open-Meteo geocoding API. */
export type WeatherLocation = {
	name: string;
	country: string;
	latitude: number;
	longitude: number;
};

/** A single day's forecast entry. */
export type WeatherDay = {
	date: string;
	temperatureMaxC: number | null;
	temperatureMinC: number | null;
	precipitationProbabilityPercent: number | null;
	weatherCode: number;
	description: string;
};

/** Result of a `weather.lookup` call: geocoded location, current conditions, and forecast. */
export type WeatherLookupResult = {
	location: WeatherLocation;
	current: { temperatureC: number | null };
	daily: WeatherDay[];
};

// https://open-meteo.com/en/docs#weathervariables — WMO weather interpretation codes.
const WMO_WEATHER_DESCRIPTIONS: Record<number, string> = {
	0: 'Clear sky',
	1: 'Mainly clear',
	2: 'Partly cloudy',
	3: 'Overcast',
	45: 'Fog',
	48: 'Depositing rime fog',
	51: 'Light drizzle',
	53: 'Moderate drizzle',
	55: 'Dense drizzle',
	56: 'Light freezing drizzle',
	57: 'Dense freezing drizzle',
	61: 'Slight rain',
	63: 'Moderate rain',
	65: 'Heavy rain',
	66: 'Light freezing rain',
	67: 'Heavy freezing rain',
	71: 'Slight snow fall',
	73: 'Moderate snow fall',
	75: 'Heavy snow fall',
	77: 'Snow grains',
	80: 'Slight rain showers',
	81: 'Moderate rain showers',
	82: 'Violent rain showers',
	85: 'Slight snow showers',
	86: 'Heavy snow showers',
	95: 'Thunderstorm',
	96: 'Thunderstorm with slight hail',
	99: 'Thunderstorm with heavy hail'
};

/** Maps a WMO weather code to a short human-readable description. */
function describeWeatherCode(code: number): string {
	return WMO_WEATHER_DESCRIPTIONS[code] ?? 'Unknown conditions';
}

/**
 * Geocodes `location` via the Open-Meteo geocoding API, then fetches a current
 * conditions + daily forecast from the Open-Meteo forecast API.
 */
export async function lookupWeather(
	args: z.infer<typeof weatherLookupInput>,
	{ fetcher }: { fetcher?: Fetcher } = {}
): Promise<WeatherLookupResult> {
	const fetchFn = fetcher ?? fetch;

	const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
	geocodeUrl.searchParams.set('name', args.location);
	geocodeUrl.searchParams.set('count', '1');
	const geocodeResponse = await fetchFn(geocodeUrl);
	if (!geocodeResponse.ok) {
		throw new Error(`weather.lookup failed with HTTP ${geocodeResponse.status}`);
	}
	const geocodePayload = (await geocodeResponse.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	const first = geocodePayload.results?.[0];
	if (!first) {
		throw new Error(`weather.lookup found no location matching "${args.location}"`);
	}
	const location: WeatherLocation = {
		name: typeof first.name === 'string' ? first.name : args.location,
		country: typeof first.country === 'string' ? first.country : '',
		latitude: typeof first.latitude === 'number' ? first.latitude : 0,
		longitude: typeof first.longitude === 'number' ? first.longitude : 0
	};

	const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
	forecastUrl.searchParams.set('latitude', String(location.latitude));
	forecastUrl.searchParams.set('longitude', String(location.longitude));
	forecastUrl.searchParams.set('current', 'temperature_2m');
	forecastUrl.searchParams.set(
		'daily',
		'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code'
	);
	forecastUrl.searchParams.set('forecast_days', String(args.days));
	forecastUrl.searchParams.set('timezone', 'auto');

	const forecastResponse = await fetchFn(forecastUrl);
	if (!forecastResponse.ok) {
		throw new Error(`weather.lookup failed with HTTP ${forecastResponse.status}`);
	}
	const forecastPayload = (await forecastResponse.json()) as {
		current?: { temperature_2m?: number };
		daily?: {
			time?: string[];
			temperature_2m_max?: number[];
			temperature_2m_min?: number[];
			precipitation_probability_max?: number[];
			weather_code?: number[];
		};
	};

	const daily = forecastPayload.daily;
	const days: WeatherDay[] = (daily?.time ?? []).slice(0, args.days).map((date, index) => {
		const code = daily?.weather_code?.[index];
		return {
			date,
			temperatureMaxC: daily?.temperature_2m_max?.[index] ?? null,
			temperatureMinC: daily?.temperature_2m_min?.[index] ?? null,
			precipitationProbabilityPercent: daily?.precipitation_probability_max?.[index] ?? null,
			weatherCode: code ?? -1,
			description: describeWeatherCode(code ?? -1)
		};
	});

	return {
		location,
		current: { temperatureC: forecastPayload.current?.temperature_2m ?? null },
		daily: days
	};
}

// ── wikipedia.lookup ─────────────────────────────────────────────────────────

/** Input schema for `wikipedia.lookup` — searches Wikipedia and returns page summaries. */
export const wikipediaLookupInput = z.object({
	query: z.string().min(1),
	limit: z.number().int().positive().max(5).default(1)
});

/** A normalized Wikipedia page summary. */
export type WikipediaResult = {
	title: string;
	description: string | null;
	extract: string;
	url: string;
};

/**
 * Searches Wikipedia's REST search API for `query`, then fetches a page
 * summary for each of the top `limit` results.
 */
export async function lookupWikipedia(
	args: z.infer<typeof wikipediaLookupInput>,
	{ fetcher }: { fetcher?: Fetcher } = {}
): Promise<WikipediaResult[]> {
	const fetchFn = fetcher ?? fetch;
	const requestHeaders = { 'User-Agent': WIKIPEDIA_USER_AGENT };

	const searchUrl = new URL('https://en.wikipedia.org/w/rest.php/v1/search/page');
	searchUrl.searchParams.set('q', args.query);
	searchUrl.searchParams.set('limit', String(args.limit));
	const searchResponse = await fetchFn(searchUrl, { headers: requestHeaders });
	if (!searchResponse.ok) {
		throw new Error(`wikipedia.lookup failed with HTTP ${searchResponse.status}`);
	}
	const searchPayload = (await searchResponse.json()) as {
		pages?: Array<{ key?: unknown; title?: unknown }>;
	};
	const pages = (searchPayload.pages ?? []).slice(0, args.limit);

	const results = await Promise.all(
		pages.map(async (page) => {
			const key =
				typeof page.key === 'string' ? page.key : typeof page.title === 'string' ? page.title : '';
			if (!key) return null;

			const summaryResponse = await fetchFn(
				`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`,
				{ headers: requestHeaders }
			);
			if (!summaryResponse.ok) {
				throw new Error(`wikipedia.lookup failed with HTTP ${summaryResponse.status}`);
			}
			const summary = (await summaryResponse.json()) as {
				title?: unknown;
				description?: unknown;
				extract?: unknown;
				content_urls?: { desktop?: { page?: unknown } };
			};
			const pageUrl = summary.content_urls?.desktop?.page;
			return {
				title: typeof summary.title === 'string' ? summary.title : key,
				description: typeof summary.description === 'string' ? summary.description : null,
				extract:
					typeof summary.extract === 'string'
						? truncate(summary.extract, WIKIPEDIA_EXTRACT_MAX_LENGTH)
						: '',
				url:
					typeof pageUrl === 'string'
						? pageUrl
						: `https://en.wikipedia.org/wiki/${encodeURIComponent(key)}`
			} satisfies WikipediaResult;
		})
	);

	return results.filter((result): result is WikipediaResult => result !== null);
}

// ── registration ──────────────────────────────────────────────────────────────

/** Defines the keyless public-data tools: `feed.read`, `hackernews.read`, `weather.lookup`, `wikipedia.lookup`. */
export function definePublicDataTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'feed.read',
			description: 'Fetch and parse an RSS 2.0 or Atom feed URL into normalized items.',
			schema: feedReadInput,
			metadata: PUBLIC_DATA_TOOL
		}),
		defineStardustTool({
			name: 'hackernews.read',
			description: 'Read stories from a Hacker News feed (top, new, best, ask, or show).',
			schema: hackerNewsReadInput,
			metadata: PUBLIC_DATA_TOOL
		}),
		defineStardustTool({
			name: 'weather.lookup',
			description: 'Look up current conditions and a multi-day forecast for a location.',
			schema: weatherLookupInput,
			metadata: PUBLIC_DATA_TOOL
		}),
		defineStardustTool({
			name: 'wikipedia.lookup',
			description: 'Search Wikipedia and return page summaries for the top matches.',
			schema: wikipediaLookupInput,
			metadata: PUBLIC_DATA_TOOL
		})
	];
}
