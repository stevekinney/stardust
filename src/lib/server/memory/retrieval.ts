import type { MemoryEmbedding, MemoryLayer, MemorySearchResult, MemoryStore } from './memory-store';

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
	queryEmbedding?: MemoryEmbedding;
};

const RRF_K = 60;

export async function retrieveMemory(input: RetrieveMemoryInput): Promise<MemorySearchResult[]> {
	const lexicalResults = await input.store.searchLexical({
		sessionId: input.sessionId,
		query: input.query,
		layers: input.layers,
		limit: input.limit
	});

	if (!input.vectorSignal && !input.queryEmbedding) {
		return lexicalResults;
	}

	if (input.queryEmbedding) {
		const vectorResults = await input.store.searchVector({
			sessionId: input.sessionId,
			embedding: input.queryEmbedding,
			layers: input.layers,
			limit: input.limit
		});
		return reciprocalRankFuse(lexicalResults, vectorResults, input.limit);
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

function reciprocalRankFuse(
	lexicalResults: MemorySearchResult[],
	vectorResults: MemorySearchResult[],
	limit = lexicalResults.length + vectorResults.length
): MemorySearchResult[] {
	const resultsById = new Map<string, MemorySearchResult>();
	const scoresById = new Map<string, number>();

	for (const [index, result] of lexicalResults.entries()) {
		const rank = index + 1;
		resultsById.set(result.id, result);
		scoresById.set(result.id, (scoresById.get(result.id) ?? 0) + 1 / (RRF_K + rank));
	}

	for (const [index, result] of vectorResults.entries()) {
		const rank = index + 1;
		const existing = resultsById.get(result.id);
		resultsById.set(result.id, {
			...(existing ?? result),
			vectorRank: rank,
			vectorScore: result.vectorScore
		});
		scoresById.set(result.id, (scoresById.get(result.id) ?? 0) + 1 / (RRF_K + rank));
	}

	return Array.from(resultsById.values())
		.map((result) => ({
			...result,
			score: scoresById.get(result.id) ?? 0
		}))
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			return (right.vectorScore ?? 0) - (left.vectorScore ?? 0);
		})
		.slice(0, limit);
}
