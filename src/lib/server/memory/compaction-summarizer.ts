/**
 * Model-backed summarization for MemoryCompactionWorkflow.
 *
 * Follows the same injectable-provider pattern as `model-runner.ts` so the
 * activity remains a thin wrapper and tests can inject a fake provider without
 * mocking the entire Anthropic module.
 */
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import type { LoadedMemoryCompactionInput, MemoryCompactionSummary } from '../../types';

// ── Provider seam ─────────────────────────────────────────────────────────────

/** Minimal interface the summarizer needs from the model provider. */
export type CompactionSummarizerProvider = {
	complete(prompt: string): Promise<string>;
};

export type CompactionSummarizerDependencies = {
	provider?: CompactionSummarizerProvider;
	apiKey?: string;
};

// ── Zod schema for model response ─────────────────────────────────────────────

const candidateSchema = z.object({
	layer: z.enum(['durable', 'action_sensitive']),
	content: z.string().min(1),
	tags: z.array(z.string()).optional().default([]),
	reason: z.string().nullable().optional()
});

const summaryResponseSchema = z.object({
	summary: z.string().min(1),
	candidates: z.array(candidateSchema)
});

// ── Model ─────────────────────────────────────────────────────────────────────

const COMPACTION_MODEL = 'claude-haiku-4-5-20251001';

const COMPACTION_PROMPT_TEMPLATE = (transcript: string) => `\
You are a memory compaction assistant. Your job is to summarize the session \
transcript below and identify any durable or action-sensitive facts worth \
remembering across future sessions.

Transcript:
${transcript}

Respond with a JSON object containing exactly these fields:
{
  "summary": "<1-2 sentence summary of the key events, goals, and outcomes>",
  "candidates": [
    {
      "layer": "durable" | "action_sensitive",
      "content": "<the memory note text>",
      "tags": ["<tag>"],
      "reason": "<why this deserves long-term storage>"
    }
  ]
}

Guidelines for candidates:
- durable: persistent preferences, project facts, reusable constraints.
- action_sensitive: approval boundaries, "do not do X again" notes with optional expiry.
- Return an empty array when there are no genuinely cross-session facts.
- Do not include transient task state — only stable facts.

Return only the JSON object, no markdown fences.`;

// ── API key reader ─────────────────────────────────────────────────────────────

function readApiKey(override?: string): string {
	const key = override ?? process.env.ANTHROPIC_API_KEY;
	if (!key) {
		throw ApplicationFailure.nonRetryable(
			'ANTHROPIC_API_KEY is required for memory compaction summarization'
		);
	}
	return key;
}

// ── Default Anthropic provider ────────────────────────────────────────────────

function createDefaultProvider(apiKey: string): CompactionSummarizerProvider {
	return {
		async complete(prompt: string): Promise<string> {
			// Inline import keeps the Anthropic SDK out of the browser bundle
			// and mirrors the pattern in model-runner.ts.
			const Anthropic = (await import('@anthropic-ai/sdk')).default;
			const client = new Anthropic({ apiKey });
			const response = await client.messages.create({
				model: COMPACTION_MODEL,
				max_tokens: 1024,
				messages: [{ role: 'user', content: prompt }]
			});
			return response.content
				.filter((block) => block.type === 'text')
				.map((block) => block.text)
				.join('');
		}
	};
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Produces a real model-backed summary and durable/action-sensitive candidates
 * from the loaded compaction input. Throws a non-retryable ApplicationFailure
 * when no API key is configured (consistent with `runModelCall`).
 */
export async function summarizeCompaction(
	input: LoadedMemoryCompactionInput,
	deps: CompactionSummarizerDependencies = {}
): Promise<MemoryCompactionSummary> {
	if (input.transcript.length === 0) {
		return { summary: 'No new transcript events to compact.', candidates: [] };
	}

	const apiKey = readApiKey(deps.apiKey);
	const provider = deps.provider ?? createDefaultProvider(apiKey);

	const prompt = COMPACTION_PROMPT_TEMPLATE(input.transcript.join('\n'));
	const raw = await provider.complete(prompt);

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw ApplicationFailure.retryable(
			`Memory compaction summarizer returned non-JSON: ${raw.slice(0, 200)}`
		);
	}

	const result = summaryResponseSchema.safeParse(parsed);
	if (!result.success) {
		throw ApplicationFailure.retryable(
			`Memory compaction summarizer response failed schema validation: ${result.error.message}`
		);
	}

	return {
		summary: result.data.summary,
		candidates: result.data.candidates.map((candidate) => ({
			layer: candidate.layer,
			content: candidate.content,
			tags: candidate.tags,
			reason: candidate.reason ?? null
		}))
	};
}
