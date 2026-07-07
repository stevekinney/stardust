import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import temporal from 'eslint-plugin-temporal';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	temporal.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		files: ['src/workflows/**/*.ts'],
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
	},
	{
		// fixtures are only linted by the boundary test, not the main gate
		files: ['src/workflows/__fixtures__/**'],
		rules: {
			// Allow violations in fixtures — they exist to be caught by the boundary test
			'temporal/workflow-no-fs-in-workflow': 'off',
			'temporal/workflow-no-node-or-dom-imports': 'off',
			'temporal/workflow-no-network-in-workflow': 'off',
			'temporal/workflow-no-unsafe-package-imports': 'off',
			'no-restricted-imports': 'off',
			// @ts-nocheck is needed in bad-workflow.ts to suppress "cannot find module 'armorer'"
			'@typescript-eslint/ban-ts-comment': 'off'
		}
	},
	{
		// Test files run in Node, not the Temporal workflow sandbox.
		// temporal.configs.recommended applies workflow rules to test files via treatTestAsWorkflow,
		// but test utilities legitimately need Node APIs and external imports.
		files: ['**/*.test.ts', '**/*.spec.ts'],
		rules: {
			'temporal/workflow-no-node-or-dom-imports': 'off',
			'temporal/workflow-no-fs-in-workflow': 'off',
			'temporal/workflow-no-network-in-workflow': 'off',
			'temporal/workflow-no-unsafe-package-imports': 'off',
			'temporal/workflow-no-logger-library-in-workflow': 'off',
			'temporal/workflow-no-worker-import': 'off',
			// SSR tests intentionally manipulate globalThis to simulate a window-less environment.
			'temporal/workflow-no-unsafe-global-mutation': 'off',
			// Activity test files must import activity implementations directly to call them.
			// The rule is designed for workflow code; test files are not workflows.
			'temporal/workflow-no-activity-definitions-import': 'off',
			'temporal/test-import-type-for-activities': 'off',
			// Determinism rules assume the file executes inside a Temporal workflow
			// sandbox (where control flow must be deterministic and errors must be
			// ApplicationFailure for retry semantics). Test files — including
			// browser/component tests that poll `document`/`setTimeout` while
			// waiting for async rendering to settle — run in plain Node/browser
			// test runners, not the workflow sandbox, so these rules produce false
			// positives there (e.g. a `waitFor` helper's while-loop + setTimeout +
			// throw is a normal test-utility pattern, not workflow code).
			'temporal/workflow-no-nondeterministic-control-flow': 'off',
			'temporal/workflow-no-throw-raw-error': 'off',
			'temporal/workflow-prefer-sleep': 'off'
		}
	},
	{
		// Shared vitest helper (ephemeral test-server boot retry), not workflow
		// code — it lives under src/workflows/ only so the workflow test files
		// can import it relatively, and it runs in plain Node like the *.test.ts
		// files whose override above documents the same false-positive class.
		files: ['src/workflows/test-environment.ts'],
		rules: {
			'temporal/workflow-no-nonserializable-types-in-payloads': 'off',
			'temporal/test-teardown-required': 'off',
			'temporal/workflow-prefer-sleep': 'off'
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
