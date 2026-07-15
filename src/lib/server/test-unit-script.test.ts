import { describe, expect, it } from 'vitest';
import {
	allowsNoMatchedTests,
	assertCommandSucceeded,
	assertSerializedModeSupported,
	createBailCommand,
	createListCommand,
	createBlobOutputFile,
	createMergeArguments,
	createMergeCommand,
	createProjectArguments,
	createProjectCommand,
	hasBlobReporterArgument,
	hasCoverageArgument,
	getBlobOutputFile,
	getBailLimit,
	hasOnlyBlobReporterArgument,
	hasReporterArgument,
	hasTestSelectionArgument,
	normalizeArguments,
	runSerializedCommands,
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
				'--bail',
				'2',
				'--bail=3',
				'--coverage',
				'run-pane.svelte.test.ts'
			])
		).toEqual(['--coverage', 'run-pane.svelte.test.ts']);
	});

	it('normalizes supported kebab-case Vitest aliases', () => {
		expect(
			normalizeArguments([
				'--test-name-pattern=unit test script',
				'--output-file',
				'results.json',
				'--output-file.junit',
				'junit.xml'
			])
		).toEqual([
			'--testNamePattern=unit test script',
			'--outputFile',
			'results.json',
			'--outputFile.junit',
			'junit.xml'
		]);
	});

	it('detects coverage requests', () => {
		expect(hasCoverageArgument(['--coverage'])).toBe(true);
		expect(hasCoverageArgument(['--coverage.enabled=true'])).toBe(true);
		expect(hasCoverageArgument(['--coverage=false'])).toBe(false);
		expect(hasCoverageArgument(['--coverage', '--coverage.enabled=false'])).toBe(false);
		expect(hasCoverageArgument(['--coverage', '--coverage.enabled', 'false'])).toBe(false);
		expect(hasCoverageArgument(['run-pane.svelte.test.ts'])).toBe(false);
	});

	it('distinguishes test selection arguments from run options', () => {
		expect(hasTestSelectionArgument(['src/lib/server/test-unit-script.test.ts'])).toBe(true);
		expect(hasTestSelectionArgument(['--testNamePattern=unit test script'])).toBe(true);
		expect(hasTestSelectionArgument(['--changed=main'])).toBe(true);
		expect(hasTestSelectionArgument(['--related', 'src/lib/inbox.svelte.ts'])).toBe(true);
		expect(hasTestSelectionArgument(['--coverage'])).toBe(false);
		expect(hasTestSelectionArgument(['--coverage.reporter', 'lcov'])).toBe(false);
		expect(hasTestSelectionArgument(['--coverage.reportsDirectory', 'tmp/coverage'])).toBe(false);
		expect(hasTestSelectionArgument(['--maxWorkers', '2'])).toBe(false);
		expect(hasTestSelectionArgument(['--shard=5/5'])).toBe(true);
		expect(hasTestSelectionArgument(['--dir', 'src/workflows'])).toBe(true);
		expect(hasTestSelectionArgument(['--include', 'src/**/*.server.test.ts'])).toBe(true);
		expect(hasTestSelectionArgument(['--exclude', 'src/**/*.svelte.test.ts'])).toBe(true);
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

	it('parses the global bail budget', () => {
		expect(getBailLimit(['--bail'])).toBe(1);
		expect(getBailLimit(['--bail=1'])).toBe(1);
		expect(getBailLimit(['--bail=2'])).toBe(2);
		expect(getBailLimit(['--bail', '3'])).toBe(3);
		expect(getBailLimit([])).toBeUndefined();
	});

	it('preserves valid no-op incremental selections', () => {
		expect(allowsNoMatchedTests(['--changed'])).toBe(true);
		expect(allowsNoMatchedTests(['--related', 'README.md'])).toBe(true);
		expect(allowsNoMatchedTests(['missing.test.ts'])).toBe(false);
	});

	it('rejects watch mode before launching serialized projects', () => {
		expect(() => assertSerializedModeSupported(['--watch'])).toThrow('Watch mode is not supported');
		expect(() => assertSerializedModeSupported([])).not.toThrow();
	});

	it('adds a counted JSON result reporter to bail commands', () => {
		expect(createBailCommand(['vitest'], 2, 'results/client.json')).toEqual([
			'vitest',
			'--bail=2',
			'--reporter=default',
			'--reporter=json',
			'--outputFile.json=results/client.json'
		]);
		expect(createBailCommand(['vitest', '--reporter=blob'], 1, 'results/server.json')).toEqual([
			'vitest',
			'--reporter=blob',
			'--bail=1',
			'--reporter=json',
			'--outputFile.json=results/server.json'
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
		expect(hasReporterArgument(argumentsToForward)).toBe(true);
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

	it('aggregates structured reporters written to standard output', () => {
		expect(hasReporterArgument(['--reporter=json'])).toBe(true);
		expect(createProjectArguments(['--reporter=json'])).toEqual([]);
		expect(createMergeArguments(['--reporter=json'])).toEqual(['--reporter=json']);
	});

	it('keeps a blob-only reporter out of the unsupported merge path', () => {
		expect(hasBlobReporterArgument(['--reporter=blob'])).toBe(true);
		expect(hasOnlyBlobReporterArgument(['--reporter=blob'])).toBe(true);
		expect(hasOnlyBlobReporterArgument(['--reporter=blob', '--reporter=json'])).toBe(false);
		expect(createMergeArguments(['--reporter=blob', '--reporter=json'])).toEqual([
			'--reporter=json'
		]);
	});

	it('preserves custom blob output as collision-free project files', () => {
		expect(getBlobOutputFile(['--reporter=blob', '--outputFile=reports/blob.json'])).toBe(
			'reports/blob.json'
		);
		expect(getBlobOutputFile(['--reporter=blob', '--outputFile.blob', 'reports/run.json'])).toBe(
			'reports/run.json'
		);
		expect(createBlobOutputFile('reports/blob.json', 'client')).toBe('reports/blob-client.json');
		expect(createBlobOutputFile('blob', 'workflows')).toBe('blob-workflows');
	});

	it('removes dotted output file values from isolated projects', () => {
		const argumentsToForward = ['--reporter=junit', '--outputFile.junit', 'junit.xml'];
		expect(createProjectArguments(argumentsToForward)).toEqual([]);
		expect(createMergeArguments(argumentsToForward)).toEqual(argumentsToForward);
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
		expect(createProjectArguments(argumentsToForward)).toEqual([
			'--coverage',
			'run-pane.svelte.test.ts'
		]);
	});

	it('preserves space-separated aggregate coverage option values', () => {
		const argumentsToForward = [
			'--coverage',
			'--coverage.reporter',
			'lcov',
			'--coverage.reportsDirectory',
			'tmp/coverage'
		];
		expect(createMergeArguments(argumentsToForward)).toEqual(argumentsToForward);
	});

	it('runs every project and merges reports before propagating a project failure', () => {
		const calls: string[][] = [];
		const projectFailure = new Error('project failed');
		const execute = (command: readonly string[]) => {
			calls.push([...command]);
			if (command[0] === 'client') throw projectFailure;
		};

		expect(() =>
			runSerializedCommands([['client'], ['server'], ['workflows']], ['merge'], execute)
		).toThrow(projectFailure);
		expect(calls).toEqual([['client'], ['server'], ['workflows'], ['merge']]);
	});

	it('preserves project and merge failures when both phases fail', () => {
		const projectFailure = new Error('project failed');
		const mergeFailure = new Error('merge failed');
		const execute = (command: readonly string[]) => {
			if (command[0] === 'client') throw projectFailure;
			if (command[0] === 'merge') throw mergeFailure;
		};

		try {
			runSerializedCommands([['client'], ['server']], ['merge'], execute);
			expect.unreachable('Expected serialized commands to fail.');
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([projectFailure, mergeFailure]);
		}
	});

	it('stops scheduling projects when the numeric bail budget is exhausted', () => {
		const calls: string[][] = [];
		const projectFailure = new Error('project failed');
		const serverFailure = new Error('server failed');
		const execute = (command: readonly string[]) => {
			calls.push([...command]);
			if (command[0] === 'client') throw projectFailure;
			if (command[0] === 'server') throw serverFailure;
		};

		expect(() =>
			runSerializedCommands([['client'], ['server'], ['workflows']], ['merge'], execute, {
				limit: 2,
				prepareCommand: (command, remainingFailures) => [...command, `--bail=${remainingFailures}`],
				getFailedTestCount: () => 1
			})
		).toThrow(projectFailure);
		expect(calls).toEqual([['client', '--bail=2'], ['server', '--bail=1'], ['merge']]);
	});
});
