import { join } from 'node:path';
import { homedir } from 'node:os';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import type { MemoryEmbedding } from './memory-store';

let cachedExtractor: FeatureExtractionPipeline | null = null;

/**
 * Returns the cached feature-extraction pipeline, loading it lazily on first call.
 * The model files are downloaded from HuggingFace on first use and cached to
 * `~/.stardust/transformers-cache` for subsequent process restarts.
 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
	if (cachedExtractor) {
		return cachedExtractor;
	}
	const { pipeline, env } = await import('@xenova/transformers');
	env.cacheDir = join(homedir(), '.stardust', 'transformers-cache');
	cachedExtractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
	return cachedExtractor;
}

/**
 * Generate a 384-dimensional normalized embedding vector for the given text using
 * the local `Xenova/all-MiniLM-L6-v2` sentence transformer model via Transformers.js.
 *
 * The model is downloaded on first call and cached under `~/.stardust/transformers-cache`.
 * Subsequent calls reuse the cached in-process pipeline (typically under 5ms).
 *
 * @throws When the model cannot be loaded or the embedding computation fails.
 *         The caller (`memory.activities.ts`) wraps this in `tryGenerateEmbedding`
 *         which returns `null` on failure, triggering graceful FTS-only fallback.
 */
export async function generateLocalEmbedding(text: string): Promise<MemoryEmbedding> {
	const extractor = await getExtractor();
	const output = await extractor._call(text, { pooling: 'mean', normalize: true });
	return Array.from(output.data as Float32Array);
}
