import { describe, expect, it } from 'vitest';
import {
	assertCommandSucceeded,
	createListCommand,
	createMergeArguments,
	createMergeCommand,
	createProjectArguments,
	createProjectCommand,
	hasCoverageArgument,
	hasReporterOutputArgument,
	hasTestSelectionArgument,
	normalizeArguments,
	unitTestProjects
} from '../../../scripts/test-unit';

describe('unit test script commands', () => {
	it('propagates command failures so report cleanup can finish', () => {
		expect(() => assertCommandSucceeded(1)).toThrow('Test command failed with status 1.');
		expect(() => assertCommandSucceeded(null)).toThrow('Test command failed with status 1.');
		expect(() => assertCommandSucceeded(0)).not.toThrow();
	});

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

	it('removes run and project flags that the script supplies itself', () => {
		expect(
			normalizeArguments([
				'--run',
				'--project',
				'client',
				'--project=server',
				'--coverage',
				'run-pane.svelte.test.ts'
			])
		).toEqual(['--coverage', 'run-pane.svelte.test.ts']);
	});

	it('detects coverage requests', () => {
		expect(hasCoverageArgument(['--coverage'])).toBe(true);
		expect(hasCoverageArgument(['--coverage.enabled=true'])).toBe(true);
		expect(hasCoverageArgument(['--coverage=false'])).toBe(false);
		expect(hasCoverageArgument(['--coverage', '--coverage.enabled=false'])).toBe(false);
		expect(hasCoverageArgument(['run-pane.svelte.test.ts'])).toBe(false);
	});

	it('distinguishes test selection arguments from run options', () => {
		expect(hasTestSelectionArgument(['src/lib/server/test-unit-script.test.ts'])).toBe(true);
		expect(hasTestSelectionArgument(['--testNamePattern=unit test script'])).toBe(true);
		expect(hasTestSelectionArgument(['--changed=main'])).toBe(true);
		expect(hasTestSelectionArgument(['--coverage'])).toBe(false);
	});

	it('keeps coverage-only project runs strict', () => {
		expect(createProjectCommand('server', ['--coverage'])).toEqual([
			'bunx',
			'vitest',
			'run',
			'--project',
			'server',
			'--coverage'
		]);
	});

	it('writes coverage runs to project-specific blob reports', () => {
		expect(createProjectCommand('server', ['--coverage'], '.vitest-reports-123')).toEqual([
			'bunx',
			'vitest',
			'run',
			'--project',
			'server',
			'--coverage',
			'--reporter=blob',
			'--outputFile=.vitest-reports-123/server.json'
		]);
		expect(createMergeCommand('.vitest-reports-123', ['--coverage'])).toEqual([
			'bunx',
			'vitest',
			'run',
			'--merge-reports=.vitest-reports-123',
			'--coverage'
		]);
	});

	it('applies file-backed reporters only to the aggregate merge', () => {
		const argumentsToForward = ['--reporter=json', '--outputFile', 'results.json'];
		expect(hasReporterOutputArgument(argumentsToForward)).toBe(true);
		expect(createProjectArguments(argumentsToForward)).toEqual([]);
		expect(createMergeArguments(argumentsToForward)).toEqual(argumentsToForward);
		expect(createMergeCommand('.vitest-reports-123', argumentsToForward)).toEqual([
			'bunx',
			'vitest',
			'run',
			'--merge-reports=.vitest-reports-123',
			...argumentsToForward
		]);
	});

	it('forwards aggregate coverage options to the merge', () => {
		const argumentsToForward = [
			'--coverage',
			'--coverage.reporter=json',
			'--coverage.reportsDirectory=tmp/coverage',
			'--coverage.thresholds.lines=90',
			'run-pane.svelte.test.ts'
		];
		expect(createMergeArguments(argumentsToForward)).toEqual(argumentsToForward.slice(0, 4));
	});
});
