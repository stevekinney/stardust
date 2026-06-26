import { db } from '../lib/server/db';
import { MemoryStore, retrieveMemory } from '../lib/server/memory';
import type {
	CreateMemoryNoteInput,
	LexicalMemorySearchInput,
	WriteMemoryCandidateInput
} from '../lib/server/memory';

const memoryStore = new MemoryStore(db);

export async function readMemoryNote(id: string) {
	return memoryStore.findById(id);
}

export async function listMemoryNotes(sessionId: string) {
	return memoryStore.listBySession(sessionId);
}

export async function searchMemory(input: LexicalMemorySearchInput) {
	return retrieveMemory({
		store: memoryStore,
		...input
	});
}

export async function writeMemoryCandidate(input: WriteMemoryCandidateInput) {
	return memoryStore.writeCandidate(input);
}

export async function confirmMemoryCandidate(input: CreateMemoryNoteInput) {
	return memoryStore.createNote(input);
}
