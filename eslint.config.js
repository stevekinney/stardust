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
			'temporal/workflow-no-logger-library-in-workflow': 'off'
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
