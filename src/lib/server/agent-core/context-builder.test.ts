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
					calls: [{ id: 'c-1', name: 'web.search', input: { query: 'TypeScript docs' } }]
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
