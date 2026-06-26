import { describe, expect, it } from 'vitest';
import { assertKnownModel, calculateModelUsage } from './budgets';

describe('model budgets', () => {
	it('computes deterministic usage cost by model id', () => {
		expect(
			calculateModelUsage({
				model: 'claude-sonnet-4-5-20250929',
				inputTokens: 1_000_000,
				outputTokens: 500_000
			})
		).toEqual({
			inputTokens: 1_000_000,
			outputTokens: 500_000,
			estimatedCostUsd: 10.5
		});
	});

	it('refuses unknown model ids', () => {
		expect(() => assertKnownModel('claude-unknown')).toThrow('Unknown model price configuration');
		expect(() =>
			calculateModelUsage({
				model: 'claude-unknown',
				inputTokens: 1,
				outputTokens: 1
			})
		).toThrow('Unknown model price configuration');
	});
});
