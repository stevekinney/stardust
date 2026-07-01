import { ApplicationFailure } from '@temporalio/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCS_LOOKUP_TOOL } from '../policy/risk';
import { defineContext7Tools, lookupLibraryDocs, resetContext7ClientForTests } from './context7';

const { connectMock, transportCtorSpy } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	transportCtorSpy: vi.fn()
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: vi.fn().mockImplementation(function MockClient(this: Record<string, unknown>) {
		this.connect = connectMock;
		this.listTools = vi.fn(async () => ({ tools: [] as Array<{ name: string }> }));
		this.callTool = vi.fn(async () => ({}));
	})
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(function MockTransport(
		this: unknown,
		url: URL,
		opts: unknown
	) {
		transportCtorSpy(url, opts);
	})
}));

type FakeClient = {
	listTools: () => Promise<{ tools: Array<{ name: string; description?: string }> }>;
	callTool: (input: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
};

function createFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
	return {
		listTools: vi.fn(async () => ({
			tools: [{ name: 'resolve-library-id' }, { name: 'query-docs' }]
		})),
		callTool: vi.fn(async (input: { name: string }) => {
			if (input.name === 'resolve-library-id') {
				return { structuredContent: [{ id: '/vercel/next.js' }] };
			}
			return { structuredContent: { documentation: 'next.js docs excerpt' } };
		}),
		...overrides
	};
}

describe('lookupLibraryDocs', () => {
	it('resolves the library id, then queries docs scoped to the topic', async () => {
		const client = createFakeClient();

		const result = await lookupLibraryDocs({ library: 'Next.js', topic: 'routing', client });

		expect(client.listTools).toHaveBeenCalled();
		expect(client.callTool).toHaveBeenNthCalledWith(1, {
			name: 'resolve-library-id',
			arguments: { libraryName: 'Next.js', query: 'routing' }
		});
		expect(client.callTool).toHaveBeenNthCalledWith(2, {
			name: 'query-docs',
			arguments: { libraryId: '/vercel/next.js', query: 'routing' }
		});
		expect(result).toEqual({
			library: 'Next.js',
			resolvedId: '/vercel/next.js',
			topic: 'routing',
			documentation: 'next.js docs excerpt'
		});
	});

	it('defaults the query to the library name when no topic is given, and reports a null topic', async () => {
		const client = createFakeClient();

		const result = await lookupLibraryDocs({ library: 'Next.js', client });

		expect(client.callTool).toHaveBeenNthCalledWith(1, {
			name: 'resolve-library-id',
			arguments: { libraryName: 'Next.js', query: 'Next.js' }
		});
		expect(result.topic).toBeNull();
	});

	it('throws a clear error listing available tools when neither expected tool name is exposed', async () => {
		const client = createFakeClient({
			listTools: vi.fn(async () => ({ tools: [{ name: 'some-other-tool' }] }))
		});

		await expect(lookupLibraryDocs({ library: 'Next.js', client })).rejects.toThrow(
			/does not expose any of \[resolve-library-id\]\. Available tools: some-other-tool/
		);
	});

	it('caps documentation at roughly 24k characters', async () => {
		const longDocumentation = 'x'.repeat(30_000);
		const client = createFakeClient({
			callTool: vi.fn(async (input: { name: string }) => {
				if (input.name === 'resolve-library-id') return { structuredContent: [{ id: '/a/b' }] };
				return { structuredContent: { documentation: longDocumentation } };
			})
		});

		const result = await lookupLibraryDocs({ library: 'a', client });

		expect(result.documentation.length).toBe(24_000);
	});

	it('wraps unexpected client failures in a descriptive docs.lookup error', async () => {
		const client = createFakeClient({
			listTools: vi.fn(async () => {
				throw ApplicationFailure.nonRetryable('ECONNREFUSED');
			})
		});

		await expect(lookupLibraryDocs({ library: 'Next.js', client })).rejects.toThrow(
			'docs.lookup failed: could not reach Context7 (ECONNREFUSED)'
		);
	});
});

describe('getContext7Client (module-internal connection wiring)', () => {
	beforeEach(() => {
		resetContext7ClientForTests();
		connectMock.mockReset();
		transportCtorSpy.mockClear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('does not cache a failed connection — a subsequent call retries connect()', async () => {
		connectMock.mockRejectedValueOnce(new Error('connect failed'));
		connectMock.mockResolvedValueOnce(undefined);

		await expect(lookupLibraryDocs({ library: 'react' })).rejects.toThrow(
			'docs.lookup failed: could not reach Context7 (connect failed)'
		);

		// The second call must attempt to connect again — the mocked client's
		// listTools() returns no tools, so the request now fails on tool-name
		// mismatch rather than on the (would-be-cached) connection failure. That
		// proves connect() was retried instead of reusing a failed client.
		await expect(lookupLibraryDocs({ library: 'react' })).rejects.toThrow(
			/does not expose any of \[resolve-library-id\]/
		);
		expect(connectMock).toHaveBeenCalledTimes(2);
	});

	it('sends CONTEXT7_API_KEY as a header when the env var is set', async () => {
		vi.stubEnv('CONTEXT7_API_KEY', 'test-key-123');
		connectMock.mockResolvedValue(undefined);

		await expect(lookupLibraryDocs({ library: 'react' })).rejects.toThrow();

		expect(transportCtorSpy).toHaveBeenCalledWith(
			new URL('https://mcp.context7.com/mcp'),
			expect.objectContaining({
				requestInit: { headers: { CONTEXT7_API_KEY: 'test-key-123' } }
			})
		);
	});

	it('omits the header entirely when CONTEXT7_API_KEY is not set', async () => {
		vi.stubEnv('CONTEXT7_API_KEY', '');
		connectMock.mockResolvedValue(undefined);

		await expect(lookupLibraryDocs({ library: 'react' })).rejects.toThrow();

		expect(transportCtorSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ requestInit: { headers: {} } })
		);
	});
});

describe('defineContext7Tools', () => {
	it('exposes a single docs.lookup tool backed by DOCS_LOOKUP_TOOL metadata', () => {
		const tools = defineContext7Tools();

		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ name: 'docs.lookup', metadata: DOCS_LOOKUP_TOOL });
	});

	it('requires a non-empty library and allows an optional non-empty topic', () => {
		const [tool] = defineContext7Tools();

		expect(tool.schema.safeParse({ library: 'React' }).success).toBe(true);
		expect(tool.schema.safeParse({ library: 'React', topic: 'hooks' }).success).toBe(true);
		expect(tool.schema.safeParse({}).success).toBe(false);
		expect(tool.schema.safeParse({ library: '' }).success).toBe(false);
		expect(tool.schema.safeParse({ library: 'React', topic: '' }).success).toBe(false);
	});
});
