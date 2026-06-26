import { db } from '../lib/server/db';
import { sessions, transcriptEvents } from '../lib/server/db';
import { MemoryStore, retrieveMemory } from '../lib/server/memory';
import {
	createEmptyEmbedding,
	EMBEDDING_DIMENSION,
	LOCAL_EMBEDDING_MODEL
} from '../lib/server/memory';
import type {
	CreateMemoryNoteInput,
	LexicalMemorySearchInput,
	WriteMemoryCandidateInput
} from '../lib/server/memory';
import { and, asc, eq, gt } from 'drizzle-orm';
import type {
	CompactMemoryInput,
	LoadedMemoryCompactionInput,
	MemoryCompactionSummary,
	PersistMemoryCompactionInput
} from '../lib/types';

const memoryStore = new MemoryStore(db);

export async function readMemoryNote(id: string) {
	return memoryStore.findById(id);
}

export async function listMemoryNotes(sessionId: string) {
	return memoryStore.listBySession(sessionId);
}

export async function searchMemory(input: LexicalMemorySearchInput) {
	const queryEmbedding = await tryGenerateEmbedding(input.query);
	return retrieveMemory({
		store: memoryStore,
		queryEmbedding: queryEmbedding?.embedding,
		...input
	});
}

export async function writeMemoryCandidate(input: WriteMemoryCandidateInput) {
	return memoryStore.writeCandidate(input);
}

export async function confirmMemoryCandidate(input: CreateMemoryNoteInput) {
	const note = await memoryStore.createNote(input);
	const embedding = await tryGenerateEmbedding(note.content);
	if (embedding) {
		await memoryStore.upsertEmbedding({
			noteId: note.id,
			embedding: embedding.embedding,
			model: embedding.model
		});
	}
	return note;
}

export async function generateEmbedding(input: { text: string }) {
	return {
		model: LOCAL_EMBEDDING_MODEL,
		embedding: generateLocalEmbedding(input.text)
	};
}

export async function loadMemoryCompactionInput(
	input: CompactMemoryInput
): Promise<LoadedMemoryCompactionInput> {
	const transcriptRows = await db
		.select({
			sequence: transcriptEvents.sequence,
			kind: transcriptEvents.kind,
			payload: transcriptEvents.payload
		})
		.from(transcriptEvents)
		.where(
			and(
				eq(transcriptEvents.sessionId, input.sessionId),
				gt(transcriptEvents.sequence, input.fromTranscriptCursor)
			)
		)
		.orderBy(asc(transcriptEvents.sequence));
	const sessionRows = await db
		.select({ memoryRefs: sessions.memoryRefs })
		.from(sessions)
		.where(eq(sessions.id, input.sessionId))
		.limit(1);

	return {
		sessionId: input.sessionId,
		fromTranscriptCursor: input.fromTranscriptCursor,
		toTranscriptCursor: transcriptRows.at(-1)?.sequence ?? input.fromTranscriptCursor,
		transcript: transcriptRows.map((row) => `${row.kind}: ${row.payload}`),
		existingMemoryRefs: parseMemoryRefs(sessionRows[0]?.memoryRefs)
	};
}

export async function summarizeMemoryCompaction(
	input: LoadedMemoryCompactionInput
): Promise<MemoryCompactionSummary> {
	const summary =
		input.transcript.length === 0
			? 'No new transcript events to compact.'
			: input.transcript.slice(0, 6).join('\n');

	return {
		summary,
		candidates: []
	};
}

export async function persistMemoryCompaction(input: PersistMemoryCompactionInput) {
	return memoryStore.compactSessionMemory(input);
}

async function tryGenerateEmbedding(text: string) {
	try {
		return await generateEmbedding({ text });
	} catch {
		return null;
	}
}

function generateLocalEmbedding(text: string) {
	const embedding = createEmptyEmbedding();
	for (const token of tokenize(text)) {
		const hash = hashToken(token);
		const index = Math.abs(hash) % EMBEDDING_DIMENSION;
		embedding[index] += hash < 0 ? -1 : 1;
	}

	const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
	if (magnitude === 0) {
		return embedding;
	}

	return embedding.map((value) => value / magnitude);
}

function tokenize(text: string) {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

function hashToken(token: string) {
	let hash = 0;
	for (const character of token) {
		hash = (hash * 31 + character.charCodeAt(0)) | 0;
	}
	return hash;
}

function parseMemoryRefs(value: string | null | undefined): string[] {
	if (!value) {
		return [];
	}
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed)
		? parsed.filter(
				(memoryReference): memoryReference is string => typeof memoryReference === 'string'
			)
		: [];
}
