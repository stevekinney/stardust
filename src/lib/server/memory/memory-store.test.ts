import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVecExtension } from '../db/sqlite-vec';
import * as schema from '../db/schema';
import { MemoryStore, createEmptyEmbedding, EMBEDDING_DIMENSION } from './memory-store';
import { retrieveMemory } from './retrieval';
import { generateLocalEmbedding } from './embedding';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t7-memory-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let store: MemoryStore;

beforeAll(() => {
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	loadSqliteVecExtension(sqlite);
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	store = new MemoryStore(database);
});

afterAll(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('MemoryStore', () => {
	it('creates the vector embedding metadata table', () => {
		const row = sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_note_embeddings'`
			)
			.get();

		expect(row).toBeTruthy();
	});

	it('loads sqlite-vec and mirrors embeddings into a vec0 index', async () => {
		await store.createNote({
			id: 'memory-sqlite-vec-indexed',
			sessionId: 'session-sqlite-vec',
			layer: 'durable',
			content: 'SQLite vector search should use the native vec0 extension.'
		});

		const embedding = createEmptyEmbedding();
		embedding[0] = 1;
		await store.upsertEmbedding({
			noteId: 'memory-sqlite-vec-indexed',
			embedding,
			model: 'test-embedding-model'
		});

		expect(sqlite.prepare('SELECT vec_version() AS version').get()).toMatchObject({
			version: 'v0.1.9'
		});
		expect(
			sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_note_embedding_vectors'`
				)
				.get()
		).toBeTruthy();
		expect(
			sqlite
				.prepare(`SELECT vec_rowid FROM memory_note_embeddings WHERE note_id = ?`)
				.get('memory-sqlite-vec-indexed')
		).toMatchObject({ vec_rowid: expect.any(Number) });
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

	it('assigns unique per-run sequences for concurrent writeCandidate calls', async () => {
		// Regression: the old non-atomic nextStreamSequence read let two concurrent
		// writeCandidate calls claim the same sequence number for the same run, which
		// would cause a UNIQUE(run_id, sequence) violation. publishStreamEvent wraps
		// the read+insert inside a SQLite transaction, preventing any concurrent claim
		// of the same sequence number.
		const runId = 'run-concurrent-sequence';
		const sessionId = 'session-concurrent-sequence';

		const [a, b] = await Promise.all([
			store.writeCandidate({
				sessionId,
				runId,
				layer: 'session',
				content: 'first concurrent candidate'
			}),
			store.writeCandidate({
				sessionId,
				runId,
				layer: 'durable',
				content: 'second concurrent candidate'
			})
		]);

		// Both candidates must have been persisted as distinct stream events.
		const rows = sqlite
			.prepare(`SELECT sequence, kind FROM stream_events WHERE run_id = ? ORDER BY sequence`)
			.all(runId) as { sequence: number; kind: string }[];

		expect(rows).toHaveLength(2);
		// Sequences must be distinct — no collision.
		expect(rows[0]!.sequence).not.toBe(rows[1]!.sequence);
		expect(rows[0]!.kind).toBe('memory.candidate');
		expect(rows[1]!.kind).toBe('memory.candidate');
		// Both return values must be valid candidate objects with distinct ids.
		expect(a.id).toBeDefined();
		expect(b.id).toBeDefined();
		expect(a.id).not.toBe(b.id);
	});

	it('excludes unconfirmed compaction candidates from listBySession and searchLexical', async () => {
		// compactSessionMemory writes candidates with confirmedAt: null.
		// listBySession and searchLexical must not surface them — only confirmed notes
		// should appear in retrieval so the "no silent writes" invariant holds.
		const sessionId = 'session-compaction-leak';

		// Write the session row so the compactSessionMemory UPDATE does not fail.
		sqlite
			.prepare(
				`INSERT INTO sessions (id, session_key, status, workflow_id)
				 VALUES (?, ?, 'active', ?) ON CONFLICT(id) DO NOTHING`
			)
			.run(sessionId, sessionId, `agent-session:${sessionId}`);

		// Also need a stream_events-compatible run for sequence tracking; use a confirmed
		// session-summary so the memory panel's notes list shows one confirmed note.
		await store.createNote({
			id: 'compaction-confirmed-summary',
			sessionId,
			layer: 'session',
			content: 'Session is about launch planning.',
			tags: ['compaction'],
			confirmedAt: new Date().toISOString()
		});

		// Run compaction — this writes a durable candidate with confirmedAt: null.
		const result = await store.compactSessionMemory({
			sessionId,
			summary: 'Session compacted.',
			candidates: [
				{
					layer: 'durable',
					content: 'Steve prefers Bun for TypeScript projects.',
					tags: ['tooling'],
					reason: 'Stated clearly by the user.'
				}
			],
			toTranscriptCursor: 10,
			existingMemoryRefs: []
		});

		expect(result.candidateIds).toHaveLength(1);

		// The unconfirmed candidate must NOT appear in listBySession.
		const listed = await store.listBySession(sessionId);
		const listedIds = listed.map((note) => note.id);
		expect(listedIds).not.toContain(result.candidateIds[0]);
		// The confirmed summary note SHOULD appear.
		expect(listedIds).toContain('compaction-confirmed-summary');

		// The unconfirmed candidate must NOT surface in searchLexical.
		const searchResults = await store.searchLexical({
			sessionId,
			query: 'Bun TypeScript',
			limit: 10
		});
		const searchIds = searchResults.map((note) => note.id);
		expect(searchIds).not.toContain(result.candidateIds[0]);

		// findById must still return the unconfirmed row (needed for confirmation flow).
		const found = await store.findById(result.candidateIds[0]!);
		expect(found).toMatchObject({ id: result.candidateIds[0], confirmedAt: null });
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

/**
 * Real-embedding tests that use the actual Xenova/all-MiniLM-L6-v2 model.
 * These tests prove that hybrid retrieval finds semantically related content
 * that lexical-only (FTS5) search misses.
 */
describe('Real embeddings (Xenova/all-MiniLM-L6-v2)', () => {
	// Warm up the model once for all tests in this block. The model is cached
	// under ~/.stardust/transformers-cache after the first download (47ms when cached,
	// a few seconds on first use). The 30-second limit covers a cold-cache download.
	beforeAll(async () => {
		await generateLocalEmbedding('warm up');
	}, 30_000);

	it('produces 384-dimensional normalized vectors', async () => {
		const embedding = await generateLocalEmbedding('Hello, world!');

		expect(embedding).toHaveLength(EMBEDDING_DIMENSION);
		expect(embedding.every((v) => Number.isFinite(v))).toBe(true);

		const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
		expect(magnitude).toBeCloseTo(1.0, 5);
	});

	it('hybrid retrieval finds semantically related content that lexical search misses', async () => {
		// Fixture: query is about computing throughput / GPU acceleration.
		// Target note is semantically related but shares ZERO lexical tokens with the query.
		// FTS5 cannot find the target (no token overlap); vector search can.
		//
		// Verified empirically: cosine similarity between query and target ≈ 0.46
		// (see spike-fixture3.ts; "accelerated computing throughput" vs
		//  "GPU reduces latency on neural inference workloads.")
		const sessionId = 'session-real-embeddings-hybrid';
		const query = 'accelerated computing throughput';
		const targetContent = 'GPU reduces latency on neural inference workloads.';

		await store.createNote({
			id: 'real-embed-target',
			sessionId,
			layer: 'durable',
			content: targetContent
		});

		const targetEmbedding = await generateLocalEmbedding(targetContent);
		await store.upsertEmbedding({
			noteId: 'real-embed-target',
			embedding: targetEmbedding,
			model: 'Xenova/all-MiniLM-L6-v2'
		});

		const queryEmbedding = await generateLocalEmbedding(query);

		// FTS-only: query tokens are accelerated*, computing*, throughput*.
		// Target has none of these → zero lexical results.
		const ftsOnly = await retrieveMemory({ store, sessionId, query });

		// Hybrid: vector search finds the target through semantic similarity.
		const hybrid = await retrieveMemory({ store, sessionId, query, queryEmbedding });

		expect(ftsOnly.map((r) => r.id)).not.toContain('real-embed-target');
		expect(hybrid.map((r) => r.id)).toContain('real-embed-target');
	});

	it('gracefully falls back to FTS when no embedding is stored for a note', async () => {
		// A note with no stored embedding still appears in FTS results.
		// When the query embedding is provided but the note has no vector,
		// the vector search returns no results for that note; FTS covers it.
		const sessionId = 'session-real-embeddings-fallback';
		const content = 'The deployment pipeline uses continuous integration.';

		await store.createNote({
			id: 'real-embed-no-vector',
			sessionId,
			layer: 'durable',
			content
		});

		// No call to upsertEmbedding — this note has no stored vector.

		const query = 'deployment pipeline';
		const queryEmbedding = await generateLocalEmbedding(query);

		// FTS finds the note (matches "deployment*" and "pipeline*").
		const ftsResults = await retrieveMemory({ store, sessionId, query });
		// Hybrid also finds it via FTS even though no vector is stored.
		const hybridResults = await retrieveMemory({ store, sessionId, query, queryEmbedding });

		expect(ftsResults.map((r) => r.id)).toContain('real-embed-no-vector');
		expect(hybridResults.map((r) => r.id)).toContain('real-embed-no-vector');
	});
});

function countMemoryNotes(sessionId: string): number {
	const rows = sqlite
		.prepare('SELECT count(*) AS count FROM memory_notes WHERE session_id = ?')
		.all(sessionId) as { count: number }[];
	return rows[0]?.count ?? 0;
}
