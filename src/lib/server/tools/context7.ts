import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { DOCS_LOOKUP_TOOL } from '../policy/risk';
import type { RegisteredTool } from '../policy/policy-engine';
import { defineStardustTool } from './define-tool';

const CONTEXT7_URL = 'https://mcp.context7.com/mcp';
const MAX_DOCUMENTATION_CHARS = 24_000;

/**
 * Candidate names for Context7's two tools. Discovered at runtime via
 * `client.listTools()` rather than hardcoded, since the exact exposed name can
 * vary by server version — confirmed live names are `resolve-library-id` and
 * `query-docs`, with `get-library-docs` kept as a fallback candidate.
 */
const RESOLVE_TOOL_CANDIDATES = ['resolve-library-id'];
const DOCS_TOOL_CANDIDATES = ['query-docs', 'get-library-docs'];

type Context7ClientLike = {
	listTools(): Promise<{ tools: Array<{ name: string; description?: string }> }>;
	callTool(input: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
};

const context7LookupInput = z.object({
	library: z.string().min(1),
	topic: z.string().min(1).optional()
});

let cachedClient: Context7ClientLike | null = null;

/**
 * Test-only hook: clears the cached Context7 client singleton so the next
 * `lookupLibraryDocs` call (without an injected `client`) reconnects from
 * scratch. Production code never needs this — the cache clears itself on
 * connect failure.
 */
export function resetContext7ClientForTests(): void {
	cachedClient = null;
}

/**
 * Looks up library documentation through the Context7 remote MCP server: resolves
 * `library` to a Context7 library ID via its resolve tool, then queries
 * documentation via its docs tool (optionally scoped to `topic`). Documentation is
 * capped at roughly 24,000 characters. Network and protocol failures are surfaced
 * as a single descriptive error rather than crashing the process.
 */
export async function lookupLibraryDocs(input: {
	library: string;
	topic?: string;
	client?: Context7ClientLike;
}): Promise<{ library: string; resolvedId: string; topic: string | null; documentation: string }> {
	try {
		const client = input.client ?? (await getContext7Client());
		const { tools } = await client.listTools();
		const resolveToolName = pickToolName(tools, RESOLVE_TOOL_CANDIDATES);
		const docsToolName = pickToolName(tools, DOCS_TOOL_CANDIDATES);

		const query = input.topic ?? input.library;

		const resolveResult = normalizeMcpResult(
			await client.callTool({
				name: resolveToolName,
				arguments: { libraryName: input.library, query }
			})
		);
		const resolvedId = extractLibraryId(resolveResult);

		const docsResult = normalizeMcpResult(
			await client.callTool({
				name: docsToolName,
				arguments: { libraryId: resolvedId, query }
			})
		);
		const documentation = extractDocumentationText(docsResult).slice(0, MAX_DOCUMENTATION_CHARS);

		return {
			library: input.library,
			resolvedId,
			topic: input.topic ?? null,
			documentation
		};
	} catch (error) {
		if (error instanceof ToolNameMismatchError) throw error;
		throw new Error(
			`docs.lookup failed: could not reach Context7 (${error instanceof Error ? error.message : String(error)})`,
			{ cause: error }
		);
	}
}

/** Builds the `docs.lookup` registered tool definition. */
export function defineContext7Tools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'docs.lookup',
			description:
				'Look up current library or framework documentation through the Context7 remote MCP ' +
				'server. Resolves a library name to a Context7 library ID and returns documentation, ' +
				'optionally scoped to a topic.',
			schema: context7LookupInput,
			metadata: DOCS_LOOKUP_TOOL
		})
	];
}

class ToolNameMismatchError extends Error {}

function pickToolName(tools: Array<{ name: string }>, candidates: string[]): string {
	const match = tools.find((tool) => candidates.includes(tool.name));
	if (!match) {
		const available = tools.map((tool) => tool.name).join(', ') || '(none)';
		throw new ToolNameMismatchError(
			`docs.lookup failed: Context7 does not expose any of [${candidates.join(', ')}]. ` +
				`Available tools: ${available}`
		);
	}
	return match.name;
}

async function getContext7Client(): Promise<Context7ClientLike> {
	if (cachedClient) return cachedClient;

	const headers: Record<string, string> = {};
	const apiKey = process.env.CONTEXT7_API_KEY;
	if (apiKey) headers.CONTEXT7_API_KEY = apiKey;

	const client = new Client({ name: 'stardust-context7-client', version: '0.0.1' });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(CONTEXT7_URL), {
				requestInit: { headers }
			})
		);
	} catch (error) {
		// Do not cache a failed connection — the next call should retry.
		cachedClient = null;
		throw error;
	}
	cachedClient = client;
	return client;
}

/** Pulls a Context7 library ID (e.g. `/vercel/next.js`) out of a resolve-tool result. */
function extractLibraryId(result: unknown): string {
	const candidate = firstListItem(result);
	if (candidate && typeof candidate === 'object') {
		const record = candidate as Record<string, unknown>;
		for (const key of ['id', 'libraryId', 'slug'] as const) {
			if (typeof record[key] === 'string') return record[key];
		}
	}
	const text = typeof candidate === 'string' ? candidate : JSON.stringify(result);
	const match = /\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?/.exec(text);
	if (match) return match[0];
	throw new Error('could not determine a Context7 library ID from the resolve result');
}

function firstListItem(result: unknown): unknown {
	if (Array.isArray(result)) return result[0];
	if (result && typeof result === 'object') {
		const record = result as Record<string, unknown>;
		if (Array.isArray(record.content)) return firstListItem(record.content);
		if (Array.isArray(record.libraries)) return firstListItem(record.libraries);
		if (Array.isArray(record.results)) return firstListItem(record.results);
	}
	return result;
}

/** Pulls documentation text out of a docs-tool result, regardless of its exact shape. */
function extractDocumentationText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (result && typeof result === 'object') {
		const record = result as Record<string, unknown>;
		if (typeof record.documentation === 'string') return record.documentation;
		if (typeof record.text === 'string') return record.text;
		if (Array.isArray(record.content)) {
			return record.content
				.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
				.join('\n\n');
		}
	}
	return JSON.stringify(result);
}

function normalizeMcpResult(result: unknown) {
	if (!result || typeof result !== 'object') return result;
	const record = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
	if (record.structuredContent !== undefined) return record.structuredContent;
	if (!Array.isArray(record.content)) return result;
	return {
		isError: record.isError === true,
		content: record.content.map((item) => {
			if (!item || typeof item !== 'object') return item;
			const block = item as Record<string, unknown>;
			if (block.type === 'text' && typeof block.text === 'string') {
				try {
					return JSON.parse(block.text) as unknown;
				} catch {
					return block.text;
				}
			}
			return block;
		})
	};
}
