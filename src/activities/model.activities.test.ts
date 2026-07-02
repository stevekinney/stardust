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

	it('sanitizes dot-namespaced tool names for the Anthropic API', () => {
		// The API rejects names outside ^[a-zA-Z0-9_-]{1,128}$ — dotted internal
		// names must never reach the tools array (regression: every real model
		// call failed with a 400 on tools.0.custom.name).
		const [tool] = formatToolsForAnthropic([
			{
				identity: { namespace: 'workspace', name: 'workspace.write' },
				display: { description: 'Write a workspace file' },
				input: { type: 'object', properties: {}, additionalProperties: false }
			}
		]);

		expect(tool.name).toBe('workspace__write');
		expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
	});

	it('refuses tool sets whose names collide after sanitizing', () => {
		expect(() =>
			formatToolsForAnthropic([
				{
					identity: { name: 'workspace.write' },
					display: { description: 'a' },
					input: { type: 'object', properties: {} }
				},
				{
					identity: { name: 'workspace__write' },
					display: { description: 'b' },
					input: { type: 'object', properties: {} }
				}
			])
		).toThrow(/both sanitize/);
	});

	it('maps sanitized tool_use names back to canonical dotted names', async () => {
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async () => ({
				message: {
					role: 'assistant' as const,
					content: [
						{
							type: 'tool_use' as const,
							id: 'call-2',
							// The model replies with the sanitized name it was given.
							name: 'workspace__write',
							input: { path: 'notes/hello.txt' }
						}
					],
					usage: { input_tokens: 10, output_tokens: 5 }
				}
			}))
		};

		await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-codec',
				model: 'claude-sonnet-4-5-20250929',
				tools: [
					{
						identity: { name: 'workspace.write' },
						display: { description: 'Write a workspace file' },
						input: { type: 'object', properties: {} }
					}
				]
			},
			{ database, provider, apiKey: 'test-key' }
		);

		// The transcript, stream events, and executor must all see the canonical name.
		const transcript = await reconstructSessionTranscript(database, 'session-001');
		const toolCallEvent = transcript.find((e) => e.kind === 'tool_call');
		expect(JSON.parse(toolCallEvent!.payload).calls[0].name).toBe('workspace.write');

		const streamEvents = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		const toolCallStreamEvent = streamEvents.events.find((e) => e.kind === 'tool.call');
		expect(JSON.parse(toolCallStreamEvent!.payload).name).toBe('workspace.write');
	});

	it('refuses unknown model ids before calling the provider', async () => {
		const provider: ModelProviderClient = {
			createMessage: vi.fn() as ModelProviderClient['createMessage']
		};

		await expect(
			runModelCall(
				{
					sessionId: 'session-001',
					runId: 'run-001',
					modelCallId: 'run-001:model-call-1',
					model: 'claude-unknown'
				},
				{ database, provider, apiKey: 'test-key' }
			)
		).rejects.toThrow('Unknown model price configuration');
		expect(provider.createMessage).not.toHaveBeenCalled();
	});

	it('calls onDelta incrementally and stores each delta as a separate stream event', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Say hello.' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		vi.stubEnv('ANTHROPIC_API_KEY', 'runtime-key');
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (request, onDelta) => {
				expect(request.messages).toEqual([{ role: 'user', content: 'Say hello.' }]);
				await onDelta('hel');
				await onDelta('lo');
				return {
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
				modelCallId: 'run-001:model-call-1',
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
		// Each onDelta call publishes one assistant.delta event, not one coalesced event.
		expect(replay.events).toHaveLength(2);
		expect(replay.events[0]?.kind).toBe('assistant.delta');
		expect(JSON.parse(replay.events[0]!.payload)).toEqual({ text: 'hel' });
		expect(replay.events[1]?.kind).toBe('assistant.delta');
		expect(JSON.parse(replay.events[1]!.payload)).toEqual({ text: 'lo' });
	});

	it('publishes incremental deltas to stream_events before the final result resolves', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Count to two.' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		// Snapshot the DB inside the mock while createMessage is still executing to
		// prove deltas land in stream_events before the final result is returned.
		const snapshotsAfterEachDelta: number[] = [];

		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (...args: Parameters<ModelProviderClient['createMessage']>) => {
				const onDelta = args[1];
				await onDelta('one ');
				snapshotsAfterEachDelta.push(
					(await readStreamEventsAfterCursor(database, { runId: 'run-001' })).events.filter(
						(e) => e.kind === 'assistant.delta'
					).length
				);
				await onDelta('two');
				snapshotsAfterEachDelta.push(
					(await readStreamEventsAfterCursor(database, { runId: 'run-001' })).events.filter(
						(e) => e.kind === 'assistant.delta'
					).length
				);
				return {
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: 'one two' }],
						usage: { input_tokens: 10, output_tokens: 5 }
					}
				};
			})
		};

		await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-1',
				model: 'claude-sonnet-4-5-20250929'
			},
			{ database, provider, apiKey: 'test-key' }
		);

		// Delta events were persisted before createMessage returned its final result.
		expect(snapshotsAfterEachDelta[0]).toBe(1); // after first onDelta call
		expect(snapshotsAfterEachDelta[1]).toBe(2); // after second onDelta call

		const finalReplay = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		const deltaEvents = finalReplay.events.filter((e) => e.kind === 'assistant.delta');
		expect(deltaEvents).toHaveLength(2);
		expect(JSON.parse(deltaEvents[0]!.payload)).toEqual({ text: 'one ' });
		expect(JSON.parse(deltaEvents[1]!.payload)).toEqual({ text: 'two' });
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
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-1',
				model: 'claude-sonnet-4-5-20250929'
			},
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

	it('does not duplicate model stream or tool-call side effects for the same modelCallId', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Fetch https://example.com' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (_request, onDelta) => {
				await onDelta('hel');
				await onDelta('lo');
				return {
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
				};
			})
		};
		const input = {
			sessionId: 'session-001',
			runId: 'run-001',
			modelCallId: 'run-001:model-call-1',
			model: 'claude-sonnet-4-5-20250929'
		};

		await runModelCall(input, { database, provider, apiKey: 'test-key' });
		await runModelCall(input, { database, provider, apiKey: 'test-key' });

		expect(provider.createMessage).toHaveBeenCalledTimes(2);
		const transcript = await reconstructSessionTranscript(database, 'session-001');
		expect(
			transcript.filter((event) => event.id === 'run-001:model-call-1:tool-call')
		).toHaveLength(1);
		const stream = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		expect(
			stream.events.filter((event) =>
				event.deduplicationKey?.startsWith('assistant-delta:run-001:model-call-1:')
			)
		).toHaveLength(2);
		expect(
			stream.events.filter(
				(event) => event.deduplicationKey === 'tool-call:run-001:model-call-1:call-1'
			)
		).toHaveLength(1);
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

	it('persistToolResult is idempotent for repeated tool call identifiers', async () => {
		const input = {
			sessionId: 'session-001',
			runId: 'run-001',
			callId: 'call-idempotent',
			content: '<html>result</html>',
			isError: false
		};

		await persistToolResult(database, input);
		await persistToolResult(database, input);

		const transcript = await reconstructSessionTranscript(database, 'session-001');
		expect(
			transcript.filter((event) => event.id === 'run-001:tool-result:call-idempotent')
		).toHaveLength(1);
		const streamEvents = await readStreamEventsAfterCursor(database, { runId: 'run-001' });
		expect(
			streamEvents.events.filter(
				(event) => event.deduplicationKey === 'tool-result:call-idempotent'
			)
		).toHaveLength(1);
	});

	it('classifies retryable provider failures', () => {
		expect(classifyModelProviderError({ status: 429 })).toBe('transient');
		expect(classifyModelProviderError({ status: 503 })).toBe('transient');
		expect(classifyModelProviderError({ status: 400 })).toBe('permanent');
		expect(classifyModelProviderError(new Error('bad request'))).toBe('permanent');
	});

	it('includes steering messages as user turns in the provider request', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'Analyse the data.' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'assistant_message',
			payload: JSON.stringify({ text: 'Analysing…' }),
			createdAt: '2026-01-01T00:00:01.000Z'
		});

		let capturedRequest: Parameters<ModelProviderClient['createMessage']>[0] | undefined;
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (request) => {
				capturedRequest = request;
				return {
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: 'Done.' }],
						usage: { input_tokens: 10, output_tokens: 5 }
					}
				};
			})
		};

		await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-1',
				model: 'claude-sonnet-4-5-20250929',
				steeringMessages: ['focus on the budget']
			},
			{ database, provider, apiKey: 'test-key' }
		);

		// The provider request must carry the steering message as a user turn.
		expect(capturedRequest).toBeDefined();
		const messagesStr = JSON.stringify(capturedRequest!.messages);
		expect(messagesStr).toContain('[Steering] focus on the budget');
		// The final turn must be a user message (so the model can respond).
		const lastMessage = capturedRequest!.messages.at(-1) as { role: string };
		expect(lastMessage.role).toBe('user');
	});

	it('includes memory notes in the provider request system prompt', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'What do you know about me?' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		let capturedRequest: Parameters<ModelProviderClient['createMessage']>[0] | undefined;
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (request) => {
				capturedRequest = request;
				return {
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: 'You prefer TypeScript.' }],
						usage: { input_tokens: 20, output_tokens: 10 }
					}
				};
			})
		};

		await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-1',
				model: 'claude-sonnet-4-5-20250929',
				systemPrompt: 'You are a helpful assistant.',
				memoryNotes: [
					{
						id: 'mem-abc',
						layer: 'durable',
						content: 'User prefers TypeScript.',
						tags: ['preferences']
					}
				]
			},
			{ database, provider, apiKey: 'test-key' }
		);

		// Memory section must appear in the system prompt sent to the provider.
		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.system).toContain('<memory>');
		expect(capturedRequest!.system).toContain('User prefers TypeScript.');
		expect(capturedRequest!.system).toContain('id: mem-abc');
		expect(capturedRequest!.system).toContain('[durable]');
		expect(capturedRequest!.system).toContain('tags: preferences');
	});

	it('includes workspace reference in the provider request system prompt', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'list files' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		let capturedRequest: Parameters<ModelProviderClient['createMessage']>[0] | undefined;
		const provider: ModelProviderClient = {
			createMessage: vi.fn(async (request) => {
				capturedRequest = request;
				return {
					message: {
						role: 'assistant' as const,
						content: [{ type: 'text' as const, text: 'Files listed.' }],
						usage: { input_tokens: 5, output_tokens: 3 }
					}
				};
			})
		};

		await runModelCall(
			{
				sessionId: 'session-001',
				runId: 'run-001',
				modelCallId: 'run-001:model-call-1',
				model: 'claude-sonnet-4-5-20250929',
				workspacePath: '/workspace/session-xyz'
			},
			{ database, provider, apiKey: 'test-key' }
		);

		expect(capturedRequest).toBeDefined();
		expect(capturedRequest!.system).toContain('<workspace>');
		expect(capturedRequest!.system).toContain('/workspace/session-xyz');
	});
});
