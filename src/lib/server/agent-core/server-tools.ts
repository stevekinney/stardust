/**
 * A server-side tool parameter as accepted by the Anthropic Messages API
 * `tools` array (e.g. `web_search`, `web_fetch`). Deliberately not typed
 * against the SDK's tool union — the request already casts `tools` as
 * `never` before it reaches `client.messages.stream`.
 */
export type ServerToolParam = {
	type: string;
	name: string;
	max_uses?: number;
};

/** Server tools and any beta headers required to enable them for a model. */
export type ServerToolsForModel = {
	tools: ServerToolParam[];
	betaHeaders: string[];
};

/**
 * Model-ID substrings for models that support the dynamic-filtering
 * `_20260209` web_search / web_fetch tool variants with no beta header.
 * Anything else falls back to the basic variants, which require a beta
 * header for web_fetch.
 */
const MODERN_MODEL_SUBSTRINGS = [
	'opus-4-6',
	'opus-4-7',
	'opus-4-8',
	'sonnet-4-6',
	'sonnet-5',
	'fable-5'
];

const MAX_SERVER_TOOL_USES = 8;

/**
 * Selects the web_search and web_fetch server-tool definitions (and any
 * beta headers they require) for the given model. Modern models get the
 * dynamic-filtering `_20260209` variants with no beta header; older models
 * (including the project default, `claude-sonnet-4-5-20250929`) fall back to
 * the basic variants, where web_fetch is still beta.
 */
export function serverToolsForModel(model: string): ServerToolsForModel {
	const isModern = MODERN_MODEL_SUBSTRINGS.some((substring) => model.includes(substring));

	if (isModern) {
		return {
			tools: [
				{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SERVER_TOOL_USES },
				{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: MAX_SERVER_TOOL_USES }
			],
			betaHeaders: []
		};
	}

	return {
		tools: [
			{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SERVER_TOOL_USES },
			{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: MAX_SERVER_TOOL_USES }
		],
		betaHeaders: ['web-fetch-2025-09-10']
	};
}
