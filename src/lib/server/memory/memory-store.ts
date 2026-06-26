import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseClient } from '../db';
import { memoryNotes, streamEvents } from '../db';

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
};

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

type MemoryNoteKind = typeof memoryNotes.$inferSelect.kind;
type MemoryNoteRow = typeof memoryNotes.$inferSelect;

const DEFAULT_LIMIT = 8;
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

export class MemoryStore {
	constructor(private readonly database: DatabaseClient) {}

	async createNote(input: CreateMemoryNoteInput): Promise<MemoryNote> {
		const now = new Date().toISOString();
		const id = input.id ?? randomUUID();
		const createdAt = input.createdAt ?? now;
		const updatedAt = input.updatedAt ?? createdAt;
		await this.database.insert(memoryNotes).values({
			id,
			sessionId: input.sessionId,
			kind: MEMORY_LAYER_TO_KIND[input.layer],
			content: input.content,
			tags: JSON.stringify(input.tags ?? []),
			runId: input.runId ?? null,
			confirmedAt: input.confirmedAt ?? now,
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
		const filters = [eq(memoryNotes.sessionId, sessionId)];
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

		const sequence = await this.nextStreamSequence(input.runId);
		await this.database.insert(streamEvents).values({
			runId: input.runId,
			sessionId: input.sessionId,
			sequence,
			kind: 'memory.candidate',
			payload: JSON.stringify(candidate),
			createdAt: candidate.createdAt
		});

		return candidate;
	}

	async confirmCandidate(candidate: MemoryCandidate, confirmedAt = new Date().toISOString()) {
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

	private async nextStreamSequence(runId: string): Promise<number> {
		const rows = await this.database
			.select({ highestSequence: sql<number>`max(${streamEvents.sequence})` })
			.from(streamEvents)
			.where(eq(streamEvents.runId, runId));
		return (rows[0]?.highestSequence ?? 0) + 1;
	}
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

function parseTags(value: string | null): string[] {
	if (!value) {
		return [];
	}

	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed)
		? parsed.filter((tag): tag is string => typeof tag === 'string')
		: [];
}

function toFtsQuery(query: string): string {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean)
		.map((term) => `${term}*`)
		.join(' ');
}
