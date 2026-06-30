import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db';
import { memoryNotes, streamEvents } from '../db';
import { publishStreamEvent } from '../stream';

export type MemoryLayer = 'session' | 'durable' | 'action_sensitive';

export type MemoryNote = {
	id: string;
	sessionId: string;
	layer: MemoryLayer;
	content: string;
	tags: string[];
	runId: string | null;
	confirmedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type MemoryCandidate = {
	id: string;
	sessionId: string;
	runId: string;
	layer: MemoryLayer;
	content: string;
	tags: string[];
	reason: string | null;
	createdAt: string;
};

export type MemorySearchResult = MemoryNote & {
	lexicalRank: number;
	score: number;
	vectorRank?: number;
	vectorScore?: number;
};

export type MemoryEmbedding = number[];

export type CreateMemoryNoteInput = {
	id?: string;
	sessionId: string;
	layer: MemoryLayer;
	content: string;
	tags?: string[];
	runId?: string | null;
	confirmedAt?: string | null;
	createdAt?: string;
	updatedAt?: string;
};

export type WriteMemoryCandidateInput = {
	id?: string;
	sessionId: string;
	runId: string;
	layer: MemoryLayer;
	content: string;
	tags?: string[];
	reason?: string | null;
	createdAt?: string;
};

export type LexicalMemorySearchInput = {
	sessionId: string;
	query: string;
	layers?: MemoryLayer[];
	limit?: number;
};

export type UpsertMemoryEmbeddingInput = {
	noteId: string;
	embedding: MemoryEmbedding;
	model: string;
	createdAt?: string;
};

export type VectorMemorySearchInput = {
	sessionId: string;
	embedding: MemoryEmbedding;
	layers?: MemoryLayer[];
	limit?: number;
};

type MemoryNoteKind = typeof memoryNotes.$inferSelect.kind;
type MemoryNoteRow = typeof memoryNotes.$inferSelect;

const DEFAULT_LIMIT = 8;
export const EMBEDDING_DIMENSION = 384;
export const LOCAL_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MEMORY_LAYER_TO_KIND: Record<MemoryLayer, MemoryNoteKind> = {
	session: 'session_summary',
	durable: 'durable',
	action_sensitive: 'action_sensitive'
};

const MEMORY_KIND_TO_LAYER: Record<MemoryNoteKind, MemoryLayer> = {
	session_summary: 'session',
	durable: 'durable',
	action_sensitive: 'action_sensitive'
};

type RawLexicalRow = MemoryNoteRow & {
	lexicalRank: number;
};

type RawVectorRow = MemoryNoteRow & {
	embedding: string;
};

type RawSqliteVecRow = MemoryNoteRow & {
	distance: number;
};

export class MemoryStore {
	private vectorIndexAvailable: boolean | null = null;

	constructor(private readonly database: DatabaseClient) {}

	async createNote(input: CreateMemoryNoteInput): Promise<MemoryNote> {
		const now = new Date().toISOString();
		const id = input.id ?? randomUUID();
		const createdAt = input.createdAt ?? now;
		const updatedAt = input.updatedAt ?? createdAt;
		// Use `!== undefined` (not `??`) so an explicit null is stored as NULL in the
		// database rather than silently defaulting to the current timestamp. Callers
		// that omit confirmedAt (undefined) still get the current timestamp, but
		// callers that pass null (e.g. compactSessionMemory for unconfirmed candidates)
		// correctly store a NULL row that can be filtered from retrieval.
		const confirmedAt = input.confirmedAt !== undefined ? input.confirmedAt : now;
		await this.database.insert(memoryNotes).values({
			id,
			sessionId: input.sessionId,
			kind: MEMORY_LAYER_TO_KIND[input.layer],
			content: input.content,
			tags: JSON.stringify(input.tags ?? []),
			runId: input.runId ?? null,
			confirmedAt,
			createdAt,
			updatedAt
		});

		const note = await this.findById(id);
		if (!note) {
			throw new Error(`Memory note was not persisted: ${id}`);
		}
		return note;
	}

	async findById(id: string): Promise<MemoryNote | null> {
		const rows = await this.database
			.select()
			.from(memoryNotes)
			.where(eq(memoryNotes.id, id))
			.limit(1);
		return rows[0] ? toMemoryNote(rows[0]) : null;
	}

	async listBySession(sessionId: string, layers?: MemoryLayer[]): Promise<MemoryNote[]> {
		// Only confirmed notes (confirmedAt IS NOT NULL) are returned.
		// Unconfirmed compaction candidates must not surface in retrieval or the
		// memory panel until a user explicitly confirms them.
		const filters = [eq(memoryNotes.sessionId, sessionId), isNotNull(memoryNotes.confirmedAt)];
		if (layers && layers.length > 0) {
			filters.push(
				inArray(
					memoryNotes.kind,
					layers.map((layer) => MEMORY_LAYER_TO_KIND[layer])
				)
			);
		}

		const rows = await this.database
			.select()
			.from(memoryNotes)
			.where(and(...filters))
			.orderBy(memoryNotes.createdAt);
		return rows.map(toMemoryNote);
	}

	/** List all confirmed memory notes across all sessions. */
	async listAll(layers?: MemoryLayer[]): Promise<MemoryNote[]> {
		const filters = [isNotNull(memoryNotes.confirmedAt)];
		if (layers && layers.length > 0) {
			filters.push(
				inArray(
					memoryNotes.kind,
					layers.map((layer) => MEMORY_LAYER_TO_KIND[layer])
				)
			);
		}

		const rows = await this.database
			.select()
			.from(memoryNotes)
			.where(and(...filters))
			.orderBy(memoryNotes.createdAt);
		return rows.map(toMemoryNote);
	}

	/** List all unconfirmed memory candidates across all sessions. */
	async listAllCandidates(): Promise<MemoryCandidate[]> {
		const candidateRows = await this.database
			.select()
			.from(memoryNotes)
			.where(isNull(memoryNotes.confirmedAt))
			.orderBy(memoryNotes.createdAt);

		return candidateRows.map(toMemoryCandidate);
	}

	/** List unconfirmed memory candidates for one session. */
	async listCandidatesBySession(sessionId: string): Promise<MemoryCandidate[]> {
		const candidateRows = await this.database
			.select()
			.from(memoryNotes)
			.where(and(eq(memoryNotes.sessionId, sessionId), isNull(memoryNotes.confirmedAt)))
			.orderBy(memoryNotes.createdAt);

		return candidateRows.map(toMemoryCandidate);
	}

	async findCandidateById(sessionId: string, candidateId: string): Promise<MemoryCandidate | null> {
		const rows = await this.database
			.select()
			.from(memoryNotes)
			.where(
				and(
					eq(memoryNotes.sessionId, sessionId),
					eq(memoryNotes.id, candidateId),
					isNull(memoryNotes.confirmedAt)
				)
			)
			.limit(1);

		return rows[0] ? toMemoryCandidate(rows[0]) : null;
	}

	async discardCandidate(sessionId: string, candidateId: string): Promise<boolean> {
		const existing = await this.findCandidateById(sessionId, candidateId);
		if (!existing) return false;
		await this.database
			.delete(memoryNotes)
			.where(
				and(
					eq(memoryNotes.sessionId, sessionId),
					eq(memoryNotes.id, candidateId),
					isNull(memoryNotes.confirmedAt)
				)
			);
		await this.database
			.delete(streamEvents)
			.where(
				and(
					eq(streamEvents.sessionId, sessionId),
					eq(streamEvents.kind, 'memory.candidate'),
					sql`json_extract(${streamEvents.payload}, '$.id') = ${candidateId}`
				)
			);
		return true;
	}

	async searchLexical(input: LexicalMemorySearchInput): Promise<MemorySearchResult[]> {
		const ftsQuery = toFtsQuery(input.query);
		if (!ftsQuery) {
			return [];
		}

		const layers = input.layers && input.layers.length > 0 ? input.layers : undefined;
		const kinds = layers?.map((layer) => MEMORY_LAYER_TO_KIND[layer]);
		const layerFilter = kinds
			? sql`m.kind IN (${sql.join(
					kinds.map((kind) => sql`${kind}`),
					sql`, `
				)})`
			: sql`1 = 1`;
		const limit = input.limit ?? DEFAULT_LIMIT;

		const rows = await this.database.all<RawLexicalRow>(sql`
			SELECT
				m.id,
				m.session_id AS sessionId,
				m.kind,
				m.content,
				m.embedding_model AS embeddingModel,
				m.tags,
				m.run_id AS runId,
				m.confirmed_at AS confirmedAt,
				m.created_at AS createdAt,
				m.updated_at AS updatedAt,
				bm25(memory_notes_fts) AS lexicalRank
			FROM memory_notes_fts
			JOIN memory_notes m ON m.id = memory_notes_fts.id
			WHERE memory_notes_fts MATCH ${ftsQuery}
				AND m.session_id = ${input.sessionId}
				AND m.confirmed_at IS NOT NULL
				AND ${layerFilter}
			ORDER BY lexicalRank ASC, m.created_at DESC
			LIMIT ${limit}
		`);

		return rows.map((row) => {
			const note = toMemoryNote(row);
			return {
				...note,
				lexicalRank: row.lexicalRank,
				score: 1 / (1 + Math.max(0, row.lexicalRank))
			};
		});
	}

	async upsertEmbedding(input: UpsertMemoryEmbeddingInput): Promise<void> {
		assertEmbedding(input.embedding);
		const vecRowid = await this.upsertVectorIndex(input.noteId, input.embedding);
		await this.database.run(sql`
			INSERT INTO memory_note_embeddings (note_id, embedding, embedding_model, vec_rowid, created_at)
			VALUES (
				${input.noteId},
				${JSON.stringify(input.embedding)},
				${input.model},
				${vecRowid},
				${input.createdAt ?? new Date().toISOString()}
			)
			ON CONFLICT(note_id) DO UPDATE SET
				embedding = excluded.embedding,
				embedding_model = excluded.embedding_model,
				vec_rowid = excluded.vec_rowid,
				created_at = excluded.created_at
		`);
		await this.database
			.update(memoryNotes)
			.set({
				embeddingModel: input.model,
				updatedAt: input.createdAt ?? new Date().toISOString()
			})
			.where(eq(memoryNotes.id, input.noteId));
	}

	async searchVector(input: VectorMemorySearchInput): Promise<MemorySearchResult[]> {
		assertEmbedding(input.embedding);

		const sqliteVecResults = await this.searchSqliteVec(input);
		if (sqliteVecResults) {
			return sqliteVecResults;
		}

		const layers = input.layers && input.layers.length > 0 ? input.layers : undefined;
		const kinds = layers?.map((layer) => MEMORY_LAYER_TO_KIND[layer]);
		const layerFilter = kinds
			? sql`m.kind IN (${sql.join(
					kinds.map((kind) => sql`${kind}`),
					sql`, `
				)})`
			: sql`1 = 1`;

		const rows = await this.database.all<RawVectorRow>(sql`
			SELECT
				m.id,
				m.session_id AS sessionId,
				m.kind,
				m.content,
				m.embedding_model AS embeddingModel,
				m.tags,
				m.run_id AS runId,
				m.confirmed_at AS confirmedAt,
				m.created_at AS createdAt,
				m.updated_at AS updatedAt,
				e.embedding
			FROM memory_note_embeddings e
			JOIN memory_notes m ON m.id = e.note_id
			WHERE m.session_id = ${input.sessionId}
				AND m.confirmed_at IS NOT NULL
				AND ${layerFilter}
		`);

		return rows
			.map((row) => ({
				note: toMemoryNote(row),
				vectorScore: cosineSimilarity(input.embedding, parseEmbedding(row.embedding))
			}))
			.filter(({ vectorScore }) => Number.isFinite(vectorScore) && vectorScore > 0)
			.sort((left, right) => right.vectorScore - left.vectorScore)
			.slice(0, input.limit ?? DEFAULT_LIMIT)
			.map(({ note, vectorScore }, index) => ({
				...note,
				lexicalRank: Number.POSITIVE_INFINITY,
				vectorRank: index + 1,
				vectorScore,
				score: vectorScore
			}));
	}

	private async searchSqliteVec(
		input: VectorMemorySearchInput
	): Promise<MemorySearchResult[] | null> {
		if (!(await this.ensureVectorIndex())) {
			return null;
		}

		const layers = input.layers && input.layers.length > 0 ? input.layers : undefined;
		const kinds = layers?.map((layer) => MEMORY_LAYER_TO_KIND[layer]);
		const layerFilter = kinds
			? sql`m.kind IN (${sql.join(
					kinds.map((kind) => sql`${kind}`),
					sql`, `
				)})`
			: sql`1 = 1`;
		const limit = input.limit ?? DEFAULT_LIMIT;

		const rows = await this.database.all<RawSqliteVecRow>(sql`
			SELECT
				m.id,
				m.session_id AS sessionId,
				m.kind,
				m.content,
				m.embedding_model AS embeddingModel,
				m.tags,
				m.run_id AS runId,
				m.confirmed_at AS confirmedAt,
				m.created_at AS createdAt,
				m.updated_at AS updatedAt,
				v.distance
			FROM memory_note_embedding_vectors v
			JOIN memory_note_embeddings e ON e.vec_rowid = v.rowid
			JOIN memory_notes m ON m.id = e.note_id
			WHERE v.embedding MATCH ${JSON.stringify(input.embedding)}
				AND k = ${limit}
				AND m.session_id = ${input.sessionId}
				AND m.confirmed_at IS NOT NULL
				AND ${layerFilter}
			ORDER BY v.distance ASC
			LIMIT ${limit}
		`);

		return rows.map((row, index) => {
			const vectorScore = 1 / (1 + Math.max(0, row.distance));
			return {
				...toMemoryNote(row),
				lexicalRank: Number.POSITIVE_INFINITY,
				vectorRank: index + 1,
				vectorScore,
				score: vectorScore
			};
		});
	}

	private async upsertVectorIndex(
		noteId: string,
		embedding: MemoryEmbedding
	): Promise<number | null> {
		if (!(await this.ensureVectorIndex())) {
			return null;
		}

		const existingRows = await this.database.all<{ vecRowid: number | null }>(sql`
			SELECT vec_rowid AS vecRowid
			FROM memory_note_embeddings
			WHERE note_id = ${noteId}
			LIMIT 1
		`);
		const existingRowid = existingRows[0]?.vecRowid;
		const serializedEmbedding = JSON.stringify(embedding);

		if (existingRowid) {
			await this.database.run(sql`
				UPDATE memory_note_embedding_vectors
				SET embedding = ${serializedEmbedding}
				WHERE rowid = ${existingRowid}
			`);
			return existingRowid;
		}

		await this.database.run(sql`
			INSERT INTO memory_note_embedding_vectors (embedding)
			VALUES (${serializedEmbedding})
		`);
		const rowidRows = await this.database.all<{ rowid: number }>(sql`
			SELECT last_insert_rowid() AS rowid
		`);
		return rowidRows[0]?.rowid ?? null;
	}

	private async ensureVectorIndex(): Promise<boolean> {
		if (this.vectorIndexAvailable !== null) {
			return this.vectorIndexAvailable;
		}

		try {
			await this.database.run(sql`
				CREATE VIRTUAL TABLE IF NOT EXISTS memory_note_embedding_vectors
				USING vec0(embedding float[384])
			`);
			this.vectorIndexAvailable = true;
		} catch {
			this.vectorIndexAvailable = false;
		}

		return this.vectorIndexAvailable;
	}

	async writeCandidate(input: WriteMemoryCandidateInput): Promise<MemoryCandidate> {
		const candidate: MemoryCandidate = {
			id: input.id ?? randomUUID(),
			sessionId: input.sessionId,
			runId: input.runId,
			layer: input.layer,
			content: input.content,
			tags: input.tags ?? [],
			reason: input.reason ?? null,
			createdAt: input.createdAt ?? new Date().toISOString()
		};

		await this.database
			.insert(memoryNotes)
			.values({
				id: candidate.id,
				sessionId: candidate.sessionId,
				kind: MEMORY_LAYER_TO_KIND[candidate.layer],
				content: candidate.content,
				tags: JSON.stringify(candidate.tags),
				runId: candidate.runId,
				confirmedAt: null,
				createdAt: candidate.createdAt,
				updatedAt: candidate.createdAt
			})
			.onConflictDoNothing();

		// Use the atomic stream-event publisher so that the sequence number
		// is assigned inside a SQLite transaction, preventing collisions with
		// concurrent stream events emitted for the same run.
		await publishStreamEvent(this.database, {
			runId: input.runId,
			sessionId: input.sessionId,
			kind: 'memory.candidate',
			deduplicationKey: `memory-candidate:${candidate.id}`,
			payload: JSON.stringify(candidate),
			createdAt: candidate.createdAt
		});

		return candidate;
	}

	async confirmCandidate(candidate: MemoryCandidate, confirmedAt = new Date().toISOString()) {
		const existing = await this.findById(candidate.id);
		if (existing) {
			await this.database
				.update(memoryNotes)
				.set({
					confirmedAt,
					updatedAt: confirmedAt
				})
				.where(eq(memoryNotes.id, candidate.id));

			const confirmed = await this.findById(candidate.id);
			if (!confirmed) throw new Error(`Memory note was not persisted: ${candidate.id}`);
			return confirmed;
		}

		return this.createNote({
			id: candidate.id,
			sessionId: candidate.sessionId,
			layer: candidate.layer,
			content: candidate.content,
			tags: candidate.tags,
			runId: candidate.runId,
			confirmedAt,
			createdAt: candidate.createdAt,
			updatedAt: confirmedAt
		});
	}

	async compactSessionMemory(input: {
		sessionId: string;
		summary: string;
		candidates: {
			layer: MemoryLayer;
			content: string;
			tags?: string[];
			reason?: string | null;
		}[];
		toTranscriptCursor: number;
		existingMemoryRefs: string[];
	}): Promise<{
		sessionId: string;
		summaryNoteId: string;
		candidateIds: string[];
		memoryRefs: string[];
		transcriptCursor: number;
	}> {
		const now = new Date().toISOString();
		const summaryNote = await this.createNote({
			sessionId: input.sessionId,
			layer: 'session',
			content: input.summary,
			tags: ['compaction'],
			confirmedAt: now,
			createdAt: now,
			updatedAt: now
		});
		const candidateNotes = [];
		for (const candidate of input.candidates) {
			candidateNotes.push(
				await this.createNote({
					sessionId: input.sessionId,
					layer: candidate.layer,
					content: candidate.content,
					tags: candidate.tags,
					confirmedAt: null,
					createdAt: now,
					updatedAt: now
				})
			);
		}

		const memoryRefs = Array.from(
			new Set([
				...input.existingMemoryRefs,
				summaryNote.id,
				...candidateNotes.map((candidate) => candidate.id)
			])
		);

		await this.database.run(sql`
			UPDATE sessions
			SET summary_cursor = ${input.toTranscriptCursor},
				transcript_cursor = ${input.toTranscriptCursor},
				memory_refs = ${JSON.stringify(memoryRefs)},
				updated_at = ${now}
			WHERE id = ${input.sessionId}
		`);

		return {
			sessionId: input.sessionId,
			summaryNoteId: summaryNote.id,
			candidateIds: candidateNotes.map((candidate) => candidate.id),
			memoryRefs,
			transcriptCursor: input.toTranscriptCursor
		};
	}
}

export function createEmptyEmbedding(): MemoryEmbedding {
	return Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
}

export function assertEmbedding(embedding: MemoryEmbedding): void {
	if (embedding.length !== EMBEDDING_DIMENSION) {
		throw new Error(`Expected embedding to have ${EMBEDDING_DIMENSION} dimensions`);
	}
	if (!embedding.every((value) => Number.isFinite(value))) {
		throw new Error('Expected embedding values to be finite numbers');
	}
}

export function cosineSimilarity(left: MemoryEmbedding, right: MemoryEmbedding): number {
	assertEmbedding(left);
	assertEmbedding(right);
	let dotProduct = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;

	for (let index = 0; index < EMBEDDING_DIMENSION; index++) {
		const leftValue = left[index]!;
		const rightValue = right[index]!;
		dotProduct += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}

	if (leftMagnitude === 0 || rightMagnitude === 0) {
		return 0;
	}

	return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function toMemoryNote(row: MemoryNoteRow): MemoryNote {
	return {
		id: row.id,
		sessionId: row.sessionId,
		layer: MEMORY_KIND_TO_LAYER[row.kind],
		content: row.content,
		tags: parseTags(row.tags),
		runId: row.runId,
		confirmedAt: row.confirmedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function toMemoryCandidate(row: MemoryNoteRow): MemoryCandidate {
	return {
		id: row.id,
		sessionId: row.sessionId,
		runId: row.runId ?? 'session-memory',
		layer: MEMORY_KIND_TO_LAYER[row.kind],
		content: row.content,
		tags: parseTags(row.tags),
		reason: null,
		createdAt: row.createdAt
	};
}

function parseTags(value: string | null): string[] {
	if (!value) {
		return [];
	}

	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed)
		? parsed.filter((tag): tag is string => typeof tag === 'string')
		: [];
}

function parseEmbedding(value: string): MemoryEmbedding {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) {
		throw new Error('Stored memory embedding is not an array');
	}
	const embedding = parsed.map((item) => Number(item));
	assertEmbedding(embedding);
	return embedding;
}

function toFtsQuery(query: string): string {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean)
		.map((term) => `${term}*`)
		.join(' ');
}
