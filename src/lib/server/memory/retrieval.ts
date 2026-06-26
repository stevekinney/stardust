import type { MemoryLayer, MemorySearchResult, MemoryStore } from './memory-store';

export type VectorSignal = (note: MemorySearchResult) => number | null | undefined;

export type RetrieveMemoryInput = {
	store: MemoryStore;
	sessionId: string;
	query: string;
	layers?: MemoryLayer[];
	limit?: number;
	/**
	 * T12 will plug vector similarity in here. Callers can pass the signal now,
	 * but leaving it undefined keeps retrieval purely FTS5 lexical.
	 */
	vectorSignal?: VectorSignal;
};

export async function retrieveMemory(input: RetrieveMemoryInput): Promise<MemorySearchResult[]> {
	const lexicalResults = await input.store.searchLexical({
		sessionId: input.sessionId,
		query: input.query,
		layers: input.layers,
		limit: input.limit
	});

	if (!input.vectorSignal) {
		return lexicalResults;
	}

	return lexicalResults
		.map((result) => {
			const vectorScore = input.vectorSignal?.(result) ?? 0;
			return {
				...result,
				score: result.score + vectorScore
			};
		})
		.sort((left, right) => right.score - left.score)
		.slice(0, input.limit ?? lexicalResults.length);
}
