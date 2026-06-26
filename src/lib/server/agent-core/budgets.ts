import type { ModelUsage } from '@src/lib/types';

type ModelPrice = {
	inputUsdPerMillionTokens: number;
	outputUsdPerMillionTokens: number;
};

const MODEL_PRICES: Record<string, ModelPrice> = {
	'claude-haiku-4-5-20251001': {
		inputUsdPerMillionTokens: 1,
		outputUsdPerMillionTokens: 5
	},
	'claude-opus-4-1-20250805': {
		inputUsdPerMillionTokens: 15,
		outputUsdPerMillionTokens: 75
	},
	'claude-sonnet-4-20250514': {
		inputUsdPerMillionTokens: 3,
		outputUsdPerMillionTokens: 15
	},
	'claude-sonnet-4-5-20250929': {
		inputUsdPerMillionTokens: 3,
		outputUsdPerMillionTokens: 15
	}
};

export function assertKnownModel(model: string): void {
	if (!MODEL_PRICES[model]) {
		throw new Error(`Unknown model price configuration: ${model}`);
	}
}

export function calculateModelUsage(input: {
	model: string;
	inputTokens: number;
	outputTokens: number;
}): ModelUsage {
	const price = MODEL_PRICES[input.model];
	if (!price) {
		throw new Error(`Unknown model price configuration: ${input.model}`);
	}

	const estimatedCostUsd =
		(input.inputTokens / 1_000_000) * price.inputUsdPerMillionTokens +
		(input.outputTokens / 1_000_000) * price.outputUsdPerMillionTokens;

	return {
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		estimatedCostUsd: Number(estimatedCostUsd.toFixed(8))
	};
}
