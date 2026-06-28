/**
 * Integration tests for memory activity behaviour.
 *
 * **Acceptance criterion (task 6f360598):** a note confirmed after run N must
 * surface in the next call to `searchMemory` for the same session. The wiring
 * from `agentRunWorkflow` → `searchMemory` → `buildModelContext` was completed
 * in task 01cd080a; these tests prove the underlying data contract holds end-to-end.
 *
 * The confirmed-note-surfaces-in-retrieval chain is complemented by
 * context-builder.test.ts:216 ("includes confirmed memory notes in the system
 * prompt with provenance"), which proves the downstream injection step.
 *
 * We drive the real `MemoryStore` + `retrieveMemory` pipeline — the same code
 * path the `searchMemory` activity executes — against a fresh SQLite database
 * so results are deterministic without process isolation. The module-level
 * singleton in `memory.activities.ts` cannot be cleanly injected with a test
 * database, so we test the underlying implementation directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVecExtension } from '../lib/server/db/sqlite-vec';
import * as schema from '../lib/server/db/schema';
import { MemoryStore } from '../lib/server/memory/memory-store';
import { retrieveMemory } from '../lib/server/memory/retrieval';

let testDbDir: string;
let sqlite: Database.Database;
let store: MemoryStore;

beforeEach(() => {
	testDbDir = mkdtempSync(join(tmpdir(), 'stardust-memory-activity-test-'));
	sqlite = new Database(join(testDbDir, 'test.db'));
	sqlite.pragma('journal_mode = WAL');
	loadSqliteVecExtension(sqlite);
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	store = new MemoryStore(database);
});

afterEach(() => {
	sqlite?.close();
	rmSync(testDbDir, { recursive: true, force: true });
});

// ── Acceptance criterion: cross-run retrieval ─────────────────────────────────

describe('searchMemory end-to-end pipeline', () => {
	it('a confirmed note from run N surfaces in retrieval for run N+1 in the same session', async () => {
		const sessionId = 'session-cross-run';

		// Run N: write a candidate (this is what agentRunWorkflow does at end of run).
		const candidate = await store.writeCandidate({
			sessionId,
			runId: 'run-n',
			layer: 'durable',
			content: 'User prefers Bun for TypeScript projects.',
			reason: 'Explicitly stated by the user in run N.'
		});

		// User (or compaction) confirms the candidate after run N completes.
		await store.confirmCandidate(candidate);

		// Run N+1: the workflow calls searchMemory before the first callModel.
		const results = await retrieveMemory({
			store,
			sessionId,
			query: 'Bun TypeScript'
		});

		expect(results.map((result) => result.id)).toContain(candidate.id);
	});

	it('an unconfirmed candidate written in run N does not surface in run N+1 retrieval', async () => {
		const sessionId = 'session-unconfirmed-candidate';

		// Run N writes a candidate but the user has not confirmed it yet.
		const candidate = await store.writeCandidate({
			sessionId,
			runId: 'run-n-unconfirmed',
			layer: 'durable',
			content: 'User prefers Bun for TypeScript projects.',
			reason: 'Unconfirmed candidate — must not leak into retrieval.'
		});

		// Run N+1: retrieval must NOT return the unconfirmed candidate.
		const results = await retrieveMemory({
			store,
			sessionId,
			query: 'Bun TypeScript'
		});

		expect(results.map((result) => result.id)).not.toContain(candidate.id);
	});

	it('retrieval is scoped to the requesting session — notes from a different session are not returned', async () => {
		const sessionA = 'session-scope-a';
		const sessionB = 'session-scope-b';

		// Create a confirmed note for session A.
		const noteA = await store.createNote({
			sessionId: sessionA,
			layer: 'durable',
			content: 'Always use Bun for new TypeScript projects.'
		});

		// Run N+1 for session B must not receive session A's notes.
		const results = await retrieveMemory({
			store,
			sessionId: sessionB,
			query: 'Bun'
		});

		expect(results.map((result) => result.id)).not.toContain(noteA.id);
	});

	it('a compaction summary note (confirmedAt set) surfaces in the next run retrieval', async () => {
		const sessionId = 'session-compaction-summary';

		// Compaction creates a confirmed summary note directly via createNote.
		const summaryNote = await store.createNote({
			sessionId,
			layer: 'session',
			content: 'Session focuses on TypeScript tooling decisions with Bun.',
			tags: ['compaction'],
			confirmedAt: new Date().toISOString()
		});

		// The confirmed summary must be retrievable for the same session.
		const results = await retrieveMemory({
			store,
			sessionId,
			query: 'TypeScript Bun'
		});

		expect(results.map((result) => result.id)).toContain(summaryNote.id);
	});

	it('compaction candidate notes (confirmedAt null) do not surface in retrieval', async () => {
		const sessionId = 'session-compaction-candidate-filter';

		// Set up the sessions row so compactSessionMemory UPDATE does not fail.
		sqlite
			.prepare(
				`INSERT INTO sessions (id, session_key, status, workflow_id)
				 VALUES (?, ?, 'active', ?) ON CONFLICT(id) DO NOTHING`
			)
			.run(sessionId, sessionId, `agent-session:${sessionId}`);

		// compactSessionMemory writes candidate notes with confirmedAt: null.
		const result = await store.compactSessionMemory({
			sessionId,
			summary: 'Session compacted.',
			candidates: [
				{
					layer: 'durable',
					content: 'Prefer Bun for TypeScript projects.',
					tags: ['tooling']
				}
			],
			toTranscriptCursor: 5,
			existingMemoryRefs: []
		});

		// The unconfirmed compaction candidate must not surface in retrieval.
		const searchResults = await retrieveMemory({
			store,
			sessionId,
			query: 'Bun TypeScript'
		});

		expect(searchResults.map((r) => r.id)).not.toContain(result.candidateIds[0]);
	});
});
