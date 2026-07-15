import { describe, expect, it } from 'vitest';
import {
	createListCommand,
	createMergeCommand,
	createProjectCommand,
	hasCoverageArgument,
	normalizeArguments,
	unitTestProjects
} from '../../../scripts/test-unit';

describe('unit test script commands', () => {
	it('checks targeted arguments within one isolated project', () => {
		expect(createListCommand('client', ['run-pane.svelte.test.ts'])).toEqual([
			'bunx',
			'vitest',
			'list',
			'--project',
			'client',
			'--passWithNoTests',
			'run-pane.svelte.test.ts'
		]);
	});

	it.each(unitTestProjects)('forwards arguments to the %s project', (project) => {
		expect(createProjectCommand(project, ['--coverage', 'run-pane.svelte.test.ts'])).toEqual([
			'bunx',
			'vitest',
			'run',
			'--project',
			project,
			'--passWithNoTests',
			'--coverage',
			'run-pane.svelte.test.ts'
		]);
	});

	it('keeps the full project gate strict', () => {
		expect(createProjectCommand('client', [])).toEqual([
			'bunx',
			'vitest',
			'run',
			'--project',
			'client'
		]);
	});

	it('removes the legacy run flag that the script supplies itself', () => {
		expect(normalizeArguments(['--run', '--coverage', 'run-pane.svelte.test.ts'])).toEqual([
			'--coverage',
			'run-pane.svelte.test.ts'
		]);
	});

	it('detects coverage requests', () => {
		expect(hasCoverageArgument(['--coverage'])).toBe(true);
		expect(hasCoverageArgument(['--coverage.enabled=true'])).toBe(true);
		expect(hasCoverageArgument(['run-pane.svelte.test.ts'])).toBe(false);
	});

	it('writes coverage runs to project-specific blob reports', () => {
		expect(createProjectCommand('server', ['--coverage'], '.vitest-reports-123')).toEqual([
			'bunx',
			'vitest',
			'run',
			'--project',
			'server',
			'--passWithNoTests',
			'--coverage',
			'--reporter=blob',
			'--outputFile=.vitest-reports-123/server.json'
		]);
		expect(createMergeCommand('.vitest-reports-123')).toEqual([
			'bunx',
			'vitest',
			'run',
			'--merge-reports=.vitest-reports-123',
			'--coverage'
		]);
	});
});
