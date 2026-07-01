import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeCompaction, type CompactionSummarizerProvider } from './compaction-summarizer';
import type { LoadedMemoryCompactionInput } from '../../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseInput: LoadedMemoryCompactionInput = {
	sessionId: 'session-compaction-test',
	fromTranscriptCursor: 0,
	toTranscriptCursor: 10,
	transcript: [
		'user_message: {"text":"I prefer Bun for package management."}',
		'assistant_message: {"text":"Understood. I will use Bun for all package operations."}'
	],
	existingMemoryRefs: ['ref-existing']
};

const emptyInput: LoadedMemoryCompactionInput = {
	...baseInput,
	transcript: []
};

function makeMockProvider(rawResponse: string): CompactionSummarizerProvider {
	return {
		complete: vi.fn(async () => rawResponse)
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('summarizeCompaction', () => {
	it('returns the no-op stub immediately when the transcript is empty', async () => {
		const provider = makeMockProvider('should-not-be-called');
		const result = await summarizeCompaction(emptyInput, { provider });

		expect(result).toEqual({ summary: 'No new transcript events to compact.', candidates: [] });
		expect(provider.complete).not.toHaveBeenCalled();
	});

	it('throws a non-retryable ApplicationFailure when ANTHROPIC_API_KEY is missing', async () => {
		// Ensure the env var is absent.
		vi.stubEnv('ANTHROPIC_API_KEY', '');

		await expect(summarizeCompaction(baseInput, {})).rejects.toThrow(
			'ANTHROPIC_API_KEY is required for memory compaction summarization'
		);
	});

	it('returns summary and candidates from a well-formed model response', async () => {
		const validResponse = JSON.stringify({
			summary: 'The user prefers Bun for package management.',
			candidates: [
				{
					layer: 'durable',
					content: 'Steve prefers Bun for all package management operations.',
					tags: ['package-manager', 'tooling'],
					reason: 'User explicitly stated a persistent preference.'
				}
			]
		});
		const provider = makeMockProvider(validResponse);

		const result = await summarizeCompaction(baseInput, {
			provider,
			apiKey: 'test-api-key'
		});

		expect(result.summary).toBe('The user prefers Bun for package management.');
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			layer: 'durable',
			content: 'Steve prefers Bun for all package management operations.',
			tags: ['package-manager', 'tooling'],
			reason: 'User explicitly stated a persistent preference.'
		});
		expect(provider.complete).toHaveBeenCalledOnce();
	});

	it('returns empty candidates array when model finds no cross-session facts', async () => {
		const validResponse = JSON.stringify({
			summary: 'The user asked about the weather and received a report.',
			candidates: []
		});
		const provider = makeMockProvider(validResponse);

		const result = await summarizeCompaction(baseInput, {
			provider,
			apiKey: 'test-api-key'
		});

		expect(result.candidates).toEqual([]);
		expect(result.summary).toBe('The user asked about the weather and received a report.');
	});

	it('throws a retryable ApplicationFailure when model returns non-JSON', async () => {
		const provider = makeMockProvider('Sorry, I cannot summarize that.');

		await expect(
			summarizeCompaction(baseInput, { provider, apiKey: 'test-api-key' })
		).rejects.toThrow('non-JSON');
	});

	it('throws a retryable ApplicationFailure when model JSON fails schema validation', async () => {
		const badResponse = JSON.stringify({
			summary: 'Fine summary',
			candidates: [{ layer: 'unknown-layer', content: 'some content' }]
		});
		const provider = makeMockProvider(badResponse);

		await expect(
			summarizeCompaction(baseInput, { provider, apiKey: 'test-api-key' })
		).rejects.toThrow('schema validation');
	});

	it('normalizes a null reason field to null in the output', async () => {
		const validResponse = JSON.stringify({
			summary: 'Brief session summary.',
			candidates: [
				{
					layer: 'action_sensitive',
					content: 'Do not send emails without approval.',
					tags: [],
					reason: null
				}
			]
		});
		const provider = makeMockProvider(validResponse);

		const result = await summarizeCompaction(baseInput, {
			provider,
			apiKey: 'test-api-key'
		});

		expect(result.candidates[0]).toMatchObject({ reason: null });
	});
});
