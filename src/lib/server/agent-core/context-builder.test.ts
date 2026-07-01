import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as schema from '../db/schema';
import { appendTranscriptEvent } from '../stream';
import { buildModelContext } from './context-builder';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t4-context-test');
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
});

describe('model context builder', () => {
	it('rebuilds Anthropic-ready context from durable transcript events', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'assistant_message',
			payload: JSON.stringify({ text: 'hi' }),
			createdAt: '2026-01-01T00:00:01.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'Answer tersely.'
		});

		expect(context.anthropic).toEqual({
			system: 'Answer tersely.',
			messages: [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi' }
			]
		});
	});

	it('includes tool_call events as assistant tool-use blocks in the Anthropic message', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'fetch this URL' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		// A tool_call event with reasoning text + one tool call
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'tool_call',
			payload: JSON.stringify({
				text: "I'll fetch that for you.",
				calls: [{ id: 'call-1', name: 'web.fetch', input: { url: 'https://example.com' } }]
			}),
			createdAt: '2026-01-01T00:00:01.000Z'
		});

		const context = await buildModelContext(database, { sessionId: 'session-001' });

		// The Anthropic adapter merges consecutive assistant-role messages, so
		// the text and tool_use block appear in a single assistant content array.
		expect(context.anthropic.messages).toHaveLength(2);
		expect(context.anthropic.messages[0]).toEqual({ role: 'user', content: 'fetch this URL' });
		const assistantMessage = context.anthropic.messages[1] as {
			role: string;
			content: unknown[];
		};
		expect(assistantMessage.role).toBe('assistant');
		expect(assistantMessage.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'text', text: "I'll fetch that for you." }),
				expect.objectContaining({
					type: 'tool_use',
					id: 'call-1',
					name: 'web.fetch',
					input: { url: 'https://example.com' }
				})
			])
		);
	});

	it('includes tool_result events as user tool-result blocks', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'fetch this URL' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'tool_call',
			payload: JSON.stringify({
				calls: [{ id: 'call-1', name: 'web.fetch', input: { url: 'https://example.com' } }]
			}),
			createdAt: '2026-01-01T00:00:01.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-003',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'tool_result',
			payload: JSON.stringify({ callId: 'call-1', content: '<html>page content</html>' }),
			createdAt: '2026-01-01T00:00:02.000Z'
		});

		const context = await buildModelContext(database, { sessionId: 'session-001' });

		// user → assistant (tool_use) → user (tool_result)
		expect(context.anthropic.messages).toHaveLength(3);
		expect(context.anthropic.messages[0]).toEqual({ role: 'user', content: 'fetch this URL' });
		expect(context.anthropic.messages[1]).toMatchObject({ role: 'assistant' });
		const toolResultMessage = context.anthropic.messages[2] as {
			role: string;
			content: unknown[];
		};
		expect(toolResultMessage.role).toBe('user');
		expect(toolResultMessage.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'tool_result', content: '<html>page content</html>' })
			])
		);
	});

	it('reconstructs a full tool-use conversation round-trip', async () => {
		// user → tool_call → tool_result → assistant_message (final answer)
		const events = [
			{
				id: 't-001',
				kind: 'user_message' as const,
				payload: JSON.stringify({ text: 'search for TypeScript docs' }),
				createdAt: '2026-01-01T00:00:00.000Z'
			},
			{
				id: 't-002',
				kind: 'tool_call' as const,
				payload: JSON.stringify({
					calls: [{ id: 'c-1', name: 'docs.lookup', input: { library: 'typescript' } }]
				}),
				createdAt: '2026-01-01T00:00:01.000Z'
			},
			{
				id: 't-003',
				kind: 'tool_result' as const,
				payload: JSON.stringify({ callId: 'c-1', content: 'https://typescriptlang.org' }),
				createdAt: '2026-01-01T00:00:02.000Z'
			},
			{
				id: 't-004',
				kind: 'assistant_message' as const,
				payload: JSON.stringify({ text: 'Here is the TypeScript docs link.' }),
				createdAt: '2026-01-01T00:00:03.000Z'
			}
		];
		for (const event of events) {
			await appendTranscriptEvent(database, {
				...event,
				runId: 'run-001',
				sessionId: 'session-001'
			});
		}

		const context = await buildModelContext(database, { sessionId: 'session-001' });

		// 4 turns: user / assistant(tool_use) / user(tool_result) / assistant(final)
		expect(context.anthropic.messages).toHaveLength(4);
		expect(context.anthropic.messages[0]).toMatchObject({ role: 'user' });
		expect(context.anthropic.messages[1]).toMatchObject({ role: 'assistant' });
		expect(context.anthropic.messages[2]).toMatchObject({ role: 'user' });
		expect(context.anthropic.messages[3]).toEqual({
			role: 'assistant',
			content: 'Here is the TypeScript docs link.'
		});
	});
});

describe('model context builder — memory injection', () => {
	it('includes confirmed memory notes in the system prompt with provenance', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'what do you remember?' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'You are a helpful assistant.',
			memoryNotes: [
				{
					id: 'mem-001',
					layer: 'durable',
					content: 'User prefers TypeScript.',
					tags: ['preferences']
				},
				{ id: 'mem-002', layer: 'session', content: 'Discussed the budget plugin.', tags: [] }
			]
		});

		// Memory section must appear in the system prompt.
		expect(context.anthropic.system).toContain('<memory>');
		expect(context.anthropic.system).toContain('User prefers TypeScript.');
		expect(context.anthropic.system).toContain('id: mem-001');
		expect(context.anthropic.system).toContain('tags: preferences');
		expect(context.anthropic.system).toContain('[durable]');
		expect(context.anthropic.system).toContain('Discussed the budget plugin.');
		expect(context.anthropic.system).toContain('id: mem-002');
		expect(context.anthropic.system).toContain('[session]');
		// Base system prompt is preserved.
		expect(context.anthropic.system).toContain('You are a helpful assistant.');
		// Messages are unchanged.
		expect(context.anthropic.messages).toHaveLength(1);
		expect(context.anthropic.messages[0]).toEqual({
			role: 'user',
			content: 'what do you remember?'
		});
	});

	it('does not add a memory section when memoryNotes is empty', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'Answer tersely.',
			memoryNotes: []
		});

		// Output must be byte-identical to the base case (no memory section).
		expect(context.anthropic).toEqual({
			system: 'Answer tersely.',
			messages: [{ role: 'user', content: 'hello' }]
		});
	});
});

describe('model context builder — workspace injection', () => {
	it('includes a workspace reference in the system prompt when workspacePath is provided', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'list the files' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'You manage files.',
			workspacePath: '/workspace/session-abc'
		});

		expect(context.anthropic.system).toContain('<workspace>');
		expect(context.anthropic.system).toContain('/workspace/session-abc');
		expect(context.anthropic.system).toContain('You manage files.');
	});

	it('does not add a workspace section when workspacePath is absent', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'Answer tersely.'
		});

		// Output must be byte-identical to the base case.
		expect(context.anthropic).toEqual({
			system: 'Answer tersely.',
			messages: [{ role: 'user', content: 'hello' }]
		});
	});
});

describe('model context builder — steering injection', () => {
	it('appends steering messages as user turns after the transcript', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'analyse the data' }),
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

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			steeringMessages: ['focus on the budget']
		});

		// Transcript is user → assistant (2 turns).
		// Steering message appended as an extra user turn (3 total).
		expect(context.anthropic.messages).toHaveLength(3);
		expect(context.anthropic.messages[0]).toEqual({ role: 'user', content: 'analyse the data' });
		expect(context.anthropic.messages[1]).toEqual({ role: 'assistant', content: 'Analysing…' });
		// Steering message is prefixed with [Steering].
		expect(context.anthropic.messages[2]).toEqual({
			role: 'user',
			content: '[Steering] focus on the budget'
		});
	});

	it('appends multiple steering messages as separate user turns', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'go' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			steeringMessages: ['first hint', 'second hint']
		});

		// The user turn from transcript + two steering turns = 3, but the
		// conversationalist adapter merges consecutive same-role messages so the
		// three user messages coalesce into a single user block with multiple parts.
		// Verify that both steering payloads are present in the final output.
		const lastMessage = context.anthropic.messages.at(-1) as {
			role: string;
			content: unknown;
		};
		expect(lastMessage.role).toBe('user');
		const contentStr = JSON.stringify(lastMessage.content);
		expect(contentStr).toContain('[Steering] first hint');
		expect(contentStr).toContain('[Steering] second hint');
	});

	it('does not add steering turns when steeringMessages is empty', async () => {
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		await appendTranscriptEvent(database, {
			id: 'transcript-002',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'assistant_message',
			payload: JSON.stringify({ text: 'hi' }),
			createdAt: '2026-01-01T00:00:01.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'Answer tersely.',
			steeringMessages: []
		});

		// Output must be byte-identical to the base case.
		expect(context.anthropic).toEqual({
			system: 'Answer tersely.',
			messages: [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi' }
			]
		});
	});
});

describe('model context builder — skills (POC boundary)', () => {
	it('does not inject skills into model context (not yet implemented)', async () => {
		// Skills injection is out of scope for this POC iteration.
		// When the skill manifest is wired up, extend buildModelContext to accept
		// a `skills` parameter and include them in the system prompt here.
		// This test asserts the boundary: no skill-shaped content appears in
		// context without the caller explicitly passing skills.
		await appendTranscriptEvent(database, {
			id: 'transcript-001',
			runId: 'run-001',
			sessionId: 'session-001',
			kind: 'user_message',
			payload: JSON.stringify({ text: 'hello' }),
			createdAt: '2026-01-01T00:00:00.000Z'
		});

		const context = await buildModelContext(database, {
			sessionId: 'session-001',
			systemPrompt: 'You are helpful.'
		});

		// No skill manifest was passed, so no <skills> block should appear.
		expect(context.anthropic.system).not.toContain('<skills>');
		expect(context.anthropic.system).not.toContain('skill');
	});
});
