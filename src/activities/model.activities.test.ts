import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../lib/server/db/schema';
import {
	appendTranscriptEvent,
	persistToolResult,
	readStreamEventsAfterCursor,
	reconstructSessionTranscript
} from '../lib/server/stream';
import {
	classifyModelProviderError,
	formatToolsForAnthropic,
	runModelCall,
	type ModelProviderClient
} from '../lib/server/agent-core/model-runner';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t4-activity-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	sqlite
		.prepare(`INSERT INTO sessions (id, session_key, status, workflow_id) VALUES (?, ?, ?, ?)`)
		.run('session-001', 'session-001', 'active', 'agent-session:session-001');
	sqlite
		.prepare(`INSERT INTO runs (id, session_id, workflow_id, status) VALUES (?, ?, ?, ?)`)
		.run('run-001', 'session-001', 'agent-run:run-001', 'running');
});

afterEach(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe('model activity', () => {
	it('formats tool schemas through the armorer Anthropic adapter', () => {
		expect(
			formatToolsForAnthropic([
				{
					identity: { namespace: 'workspace', name: 'readFile' },
					display: { description: 'Read a workspace file' },
					input: {
						type: 'object',
						properties: {
							path: { type: 'string' }
						},
						required: ['path'],
						additionalProperties: false
					}
				}
			])
		).toEqual([
			{
				name: 'readFile',
				description: 'Read a workspace file',
				input_schema: {
					type: 'object',
					properties: {
						path: { type: 'string' }
					},
					required: ['path'],
					additionalProperties: false
				}
			}
		]);
	});

	it('refuses unknown model ids before calling the provider', async () => {
		const provider: ModelProviderClient = {
			createMessage: vi.fn()
		};

		await expect(
			runModelCall(
				{
					sessionId: 'session-001',
					runId: 'run-001',
					model: 'claude-unknown'
				},
				{ database, provider, apiKey: 'test-key' }
			)
		).rejects.toThrow('Unknown model price configuration');
		expect(provider.createMessage).not.toHaveBeenCalled();
	});

	it('loads the API key at call time, normalizes output, computes cost, and stores deltas', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Say hello.' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		vi.stubEnv('MODEL_API_KEY', 'runtime-key');
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (request) => {
				expect(request.messages).toEqual([{ role: 'user', content: 'Say hello.' }]);
				return {
					deltas: ['hel', 'lo'],
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: 'hello' }],
						usage: {
							input_tokens: 1_000,
							output_tokens: 200
						}
					}
				};
			})
		};

		const result = await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				model: 'claude-sonnet-4-5-20250929'
			},
			{ database, provider }
		);
		const replay = await readStreamEventsAfterCursor(database, { runId: 'run-001' });

		expect(result).toEqual({
			runId: 'run-001',
			model: 'claude-sonnet-4-5-20250929',
			message: {
				text: 'hello',
				toolCalls: []
			},
			usage: {
				inputTokens: 1_000,
				outputTokens: 200,
				estimatedCostUsd: 0.006
			}
		});
		expect(replay.events).toHaveLength(1);
		expect(replay.events[0]?.kind).toBe('assistant.delta');
		expect(JSON.parse(replay.events[0]!.payload)).toEqual({ text: 'hello' });
	});

	it('writes a tool_call transcript event and tool.call stream events when the model requests tools', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Fetch https://example.com' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const provider: ModelProviderClient = {
			createMessage: vi.fn(async () => ({
				deltas: [],
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'call-1',
							name: 'web.fetch',
							input: { url: 'https://example.com' }
						}
					],
					usage: { input_tokens: 50, output_tokens: 10 }
				}
			}))
		};

		await runModelCall(
			{ sessionId: 'session-001', runId: 'run-001', model: 'claude-sonnet-4-5-20250929' },
			{ database, provider, apiKey: 'test-key' }
		);

		// Transcript should have a tool_call event
		const transcript = await reconstructSessionTranscript(database, 'session-001');
		const toolCallEvent = transcript.find((e) => e.kind === 'tool_call');
		expect(toolCallEvent).toBeDefined();
		const payload = JSON.parse(toolCallEvent!.payload);
		expect(payload.calls).toHaveLength(1);
		expect(payload.calls[0]).toEqual({
			id: 'call-1',
			name: 'web.fetch',
			input: { url: 'https://example.com' }
		});

		// Stream should have a tool.call event
		const streamEvents = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		const toolCallStreamEvent = streamEvents.events.find((e) => e.kind === 'tool.call');
		expect(toolCallStreamEvent).toBeDefined();
		const streamPayload = JSON.parse(toolCallStreamEvent!.payload);
		expect(streamPayload.id).toBe('call-1');
		expect(streamPayload.name).toBe('web.fetch');
	});

	it('persistToolResult writes a tool_result transcript event and tool.result stream event', async () => {
		await persistToolResult(database, {
			sessionId: 'session-001',
			runId: 'run-001',
			callId: 'call-1',
			content: '<html>result</html>',
			isError: false
		});

		const transcript = await reconstructSessionTranscript(database, 'session-001');
		const toolResultEvent = transcript.find((e) => e.kind === 'tool_result');
		expect(toolResultEvent).toBeDefined();
		const payload = JSON.parse(toolResultEvent!.payload);
		expect(payload.callId).toBe('call-1');
		expect(payload.content).toBe('<html>result</html>');
		expect(payload.isError).toBe(false);

		const streamEvents = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		const toolResultStreamEvent = streamEvents.events.find((e) => e.kind === 'tool.result');
		expect(toolResultStreamEvent).toBeDefined();
	});

	it('classifies retryable provider failures', () => {
		expect(classifyModelProviderError({ status: 429 })).toBe('transient');
		expect(classifyModelProviderError({ status: 503 })).toBe('transient');
		expect(classifyModelProviderError({ status: 400 })).toBe('permanent');
		expect(classifyModelProviderError(new Error('bad request'))).toBe('permanent');
	});
});
