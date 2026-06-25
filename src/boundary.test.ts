import { ESLint } from 'eslint';
import ts from 'typescript-eslint';
import temporal from 'eslint-plugin-temporal';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/** ESLint instance configured with temporal rules but WITHOUT the fixtures override. */
function makeLinter() {
	return new ESLint({
		cwd: root,
		overrideConfigFile: true,
		overrideConfig: [
			...ts.configs.recommended,
			temporal.configs.recommended,
			{
				files: ['**/*.ts'],
				languageOptions: { parserOptions: { project: false } },
				rules: {
					'no-restricted-imports': [
						'error',
						{
							patterns: [
								'$lib/server/*',
								'*/lib/server/*',
								'armorer',
								'armorer/*',
								'conversationalist',
								'conversationalist/*'
							]
						}
					]
				}
			}
		]
	});
}

describe('Workflow determinism boundary', () => {
	it('bad-workflow.ts: node:fs import fires workflow-no-fs-in-workflow (or workflow-no-node-or-dom-imports)', async () => {
		const linter = makeLinter();
		const fixturePath = path.join(root, 'src/workflows/__fixtures__/bad-workflow.ts');
		const results = await linter.lintFiles([fixturePath]);
		const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
		expect(
			ruleIds.some(
				(id) =>
					id === 'temporal/workflow-no-fs-in-workflow' ||
					id === 'temporal/workflow-no-node-or-dom-imports'
			),
			`Expected a fs/node import violation. Got rules: ${ruleIds.join(', ')}`
		).toBe(true);
	});

	it('bad-workflow.ts: armorer import fires no-restricted-imports', async () => {
		const linter = makeLinter();
		const fixturePath = path.join(root, 'src/workflows/__fixtures__/bad-workflow.ts');
		const results = await linter.lintFiles([fixturePath]);
		const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
		expect(
			ruleIds.includes('no-restricted-imports'),
			`Expected no-restricted-imports violation for armorer. Got rules: ${ruleIds.join(', ')}`
		).toBe(true);
	});

	it('clean-workflow.ts: produces no temporal/* errors', async () => {
		const linter = makeLinter();
		const fixturePath = path.join(root, 'src/workflows/__fixtures__/clean-workflow.ts');
		const results = await linter.lintFiles([fixturePath]);
		const errors = results
			.flatMap((r) => r.messages)
			.filter((m) => m.severity === 2 && m.ruleId?.startsWith('temporal/'));
		expect(
			errors,
			`Expected no temporal errors. Got: ${errors.map((e) => e.ruleId).join(', ')}`
		).toHaveLength(0);
	});
});
