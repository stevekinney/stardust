import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../db/schema';
import { MemoryStore, createEmptyEmbedding } from './memory-store';
import { retrieveMemory } from './retrieval';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t7-memory-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let store: MemoryStore;

beforeAll(() => {
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	store = new MemoryStore(database);
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('MemoryStore', () => {
	it('creates the local vector embedding seam when sqlite-vec is unavailable', () => {
		const row = sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_note_embeddings'`
			)
			.get();

		expect(row).toBeTruthy();
	});

	it('stores the session, durable, and action-sensitive layers in memory_notes', async () => {
		await store.createNote({
			id: 'memory-session-layer',
			sessionId: 'session-layers',
			layer: 'session',
			content: 'The current thread is about launch planning.'
		});
		await store.createNote({
			id: 'memory-durable-layer',
			sessionId: 'session-layers',
			layer: 'durable',
			content: 'Steve prefers Bun for TypeScript projects.'
		});
		await store.createNote({
			id: 'memory-action-sensitive-layer',
			sessionId: 'session-layers',
			layer: 'action_sensitive',
			content: 'Ask before sending email.'
		});

		const rows = sqlite
			.prepare('SELECT id, kind FROM memory_notes WHERE session_id = ? ORDER BY id')
			.all('session-layers');

		expect(rows).toEqual([
			{ id: 'memory-action-sensitive-layer', kind: 'action_sensitive' },
			{ id: 'memory-durable-layer', kind: 'durable' },
			{ id: 'memory-session-layer', kind: 'session_summary' }
		]);
	});

	it('returns the relevant note for a lexical FTS5 query', async () => {
		await store.createNote({
			id: 'memory-lexical-relevant',
			sessionId: 'session-lexical',
			layer: 'durable',
			content: 'Use amber terminal screenshots for the release article.'
		});
		await store.createNote({
			id: 'memory-lexical-distractor',
			sessionId: 'session-lexical',
			layer: 'durable',
			content: 'Schedule focus time on Friday afternoon.'
		});

		const results = await retrieveMemory({
			store,
			sessionId: 'session-lexical',
			query: 'amber terminal',
			layers: ['durable'],
			limit: 3
		});

		expect(results.map((result) => result.id)).toEqual(['memory-lexical-relevant']);
		expect(results[0]?.content).toContain('amber terminal');
	});

	it('publishes write candidates without mutating durable memory before confirmation', async () => {
		const beforeCount = countMemoryNotes('session-candidate');

		const candidate = await store.writeCandidate({
			id: 'memory-candidate-visible',
			sessionId: 'session-candidate',
			runId: 'run-candidate',
			layer: 'durable',
			content: 'Steve wants explicit verification commands in plans.',
			reason: 'User stated a durable planning preference.'
		});

		expect(countMemoryNotes('session-candidate')).toBe(beforeCount);
		const streamRows = sqlite
			.prepare(
				`SELECT kind, payload FROM stream_events WHERE session_id = ? AND run_id = ? ORDER BY sequence`
			)
			.all('session-candidate', 'run-candidate') as { kind: string; payload: string }[];
		expect(streamRows).toHaveLength(1);
		expect(streamRows[0]?.kind).toBe('memory.candidate');
		expect(JSON.parse(streamRows[0]!.payload)).toMatchObject({
			id: candidate.id,
			content: candidate.content,
			layer: 'durable'
		});

		await store.confirmCandidate(candidate, '2026-06-26T12:00:00.000Z');

		expect(countMemoryNotes('session-candidate')).toBe(beforeCount + 1);
		const confirmed = await store.findById(candidate.id);
		expect(confirmed).toMatchObject({
			id: 'memory-candidate-visible',
			layer: 'durable',
			confirmedAt: '2026-06-26T12:00:00.000Z'
		});
	});

	it('keeps a vector-ready retrieval seam that defaults to FTS-only', async () => {
		await store.createNote({
			id: 'memory-vector-low',
			sessionId: 'session-vector',
			layer: 'durable',
			content: 'The project codename is aurora.'
		});
		await store.createNote({
			id: 'memory-vector-high',
			sessionId: 'session-vector',
			layer: 'durable',
			content: 'Aurora launch notes should mention local durability.'
		});

		const ftsOnly = await retrieveMemory({
			store,
			sessionId: 'session-vector',
			query: 'aurora',
			limit: 2
		});
		const vectorFused = await retrieveMemory({
			store,
			sessionId: 'session-vector',
			query: 'aurora',
			limit: 2,
			vectorSignal: (note) => (note.id === 'memory-vector-high' ? 10 : 0)
		});

		expect(ftsOnly).toHaveLength(2);
		expect(vectorFused[0]?.id).toBe('memory-vector-high');
	});

	it('fuses FTS5 and vector results with reciprocal-rank fusion', async () => {
		await store.createNote({
			id: 'memory-hybrid-target',
			sessionId: 'session-hybrid',
			layer: 'durable',
			content: 'I prefer pnpm.'
		});
		await store.createNote({
			id: 'memory-hybrid-distractor',
			sessionId: 'session-hybrid',
			layer: 'durable',
			content: 'Package manager decisions can wait until release planning.'
		});

		const queryEmbedding = createEmptyEmbedding();
		queryEmbedding[0] = 1;
		const targetEmbedding = createEmptyEmbedding();
		targetEmbedding[0] = 1;
		const distractorEmbedding = createEmptyEmbedding();
		distractorEmbedding[1] = 1;

		await store.upsertEmbedding({
			noteId: 'memory-hybrid-target',
			embedding: targetEmbedding,
			model: 'test-embedding-model'
		});
		await store.upsertEmbedding({
			noteId: 'memory-hybrid-distractor',
			embedding: distractorEmbedding,
			model: 'test-embedding-model'
		});

		const ftsOnly = await retrieveMemory({
			store,
			sessionId: 'session-hybrid',
			query: 'package manager',
			limit: 2
		});
		const hybrid = await retrieveMemory({
			store,
			sessionId: 'session-hybrid',
			query: 'package manager',
			queryEmbedding,
			limit: 2
		});

		expect(ftsOnly[0]?.id).toBe('memory-hybrid-distractor');
		expect(hybrid[0]?.id).toBe('memory-hybrid-target');
		expect(hybrid.map((result) => result.id)).toContain('memory-hybrid-distractor');
	});

	it('stores notes when embedding generation fails and falls back to FTS-only retrieval', async () => {
		const note = await store.createNote({
			id: 'memory-embedding-fallback',
			sessionId: 'session-embedding-fallback',
			layer: 'durable',
			content: 'Use Bun when installing dependencies.'
		});

		await expect(
			store.upsertEmbedding({
				noteId: note.id,
				embedding: [1, 2, 3],
				model: 'broken-test-model'
			})
		).rejects.toThrow('Expected embedding to have 384 dimensions');

		const results = await retrieveMemory({
			store,
			sessionId: 'session-embedding-fallback',
			query: 'bun dependencies',
			queryEmbedding: createEmptyEmbedding(),
			limit: 3
		});

		expect(await store.findById(note.id)).toMatchObject({ id: note.id });
		expect(results[0]?.id).toBe(note.id);
	});
});

function countMemoryNotes(sessionId: string): number {
	const rows = sqlite
		.prepare('SELECT count(*) AS count FROM memory_notes WHERE session_id = ?')
		.all(sessionId) as { count: number }[];
	return rows[0]?.count ?? 0;
}
