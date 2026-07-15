import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { parseCLI } from 'vitest/node';

export const unitTestProjects = ['client', 'server', 'workflows'] as const;

/** Remove flags that the isolated project runner supplies itself. */
export function normalizeArguments(argumentsToForward: readonly string[]): string[] {
	const normalizedArguments: string[] = [];

	for (let index = 0; index < argumentsToForward.length; index += 1) {
		const argument = argumentsToForward[index];
		if (argument === '--run') continue;
		if (argument === '--project') {
			index += 1;
			continue;
		}
		if (argument?.startsWith('--project=')) continue;
		if (argument === '--test-name-pattern') {
			normalizedArguments.push('--testNamePattern');
			continue;
		}
		if (argument?.startsWith('--test-name-pattern=')) {
			normalizedArguments.push(argument.replace('--test-name-pattern=', '--testNamePattern='));
			continue;
		}
		if (argument === '--output-file') {
			normalizedArguments.push('--outputFile');
			continue;
		}
		if (argument?.startsWith('--output-file.')) {
			normalizedArguments.push(argument.replace('--output-file.', '--outputFile.'));
			continue;
		}
		if (argument?.startsWith('--output-file=')) {
			normalizedArguments.push(argument.replace('--output-file=', '--outputFile='));
			continue;
		}
		if (argument) normalizedArguments.push(argument);
	}

	return normalizedArguments;
}

/** Return whether a caller requested Vitest coverage collection. */
export function hasCoverageArgument(argumentsToForward: readonly string[]): boolean {
	let coverageEnabled = false;

	for (let index = 0; index < argumentsToForward.length; index += 1) {
		const argument = argumentsToForward[index];
		if (argument === '--coverage' || argument === '--coverage.enabled') coverageEnabled = true;
		if (argument === '--coverage=true' || argument === '--coverage.enabled=true') {
			coverageEnabled = true;
		}
		if (argument === '--coverage=false' || argument === '--coverage.enabled=false') {
			coverageEnabled = false;
		}
		if (argument === '--coverage.enabled' && argumentsToForward[index + 1] === 'false') {
			coverageEnabled = false;
		}
	}

	return coverageEnabled;
}

/** Return whether caller arguments narrow which tests Vitest should execute. */
export function hasTestSelectionArgument(argumentsToForward: readonly string[]): boolean {
	const { filter, options } = parseCLI(['vitest', 'run', ...argumentsToForward]);
	return (
		filter.length > 0 ||
		options.testNamePattern !== undefined ||
		options.changed !== undefined ||
		options.related !== undefined ||
		options.shard !== undefined
	);
}

function isReporterArgument(argument: string): boolean {
	return (
		argument === '--reporter' ||
		argument.startsWith('--reporter=') ||
		argument === '--outputFile' ||
		argument.startsWith('--outputFile=') ||
		argument.startsWith('--outputFile.')
	);
}

/** Return whether explicit reporter output must be aggregated across projects. */
export function hasReporterArgument(argumentsToForward: readonly string[]): boolean {
	return argumentsToForward.some((argument) => isReporterArgument(argument));
}

function getReporterArguments(argumentsToForward: readonly string[]): string[] {
	const options = parseCLI(['vitest', 'run', ...argumentsToForward]).options as {
		reporter?: string[];
		reporters?: string[];
	};
	return options.reporter ?? options.reporters ?? [];
}

/** Return whether blob is one of the explicitly requested reporters. */
export function hasBlobReporterArgument(argumentsToForward: readonly string[]): boolean {
	return getReporterArguments(argumentsToForward).includes('blob');
}

/** Return whether blob is the only explicitly requested reporter. */
export function hasOnlyBlobReporterArgument(argumentsToForward: readonly string[]): boolean {
	const reporters = getReporterArguments(argumentsToForward);
	return reporters?.length === 1 && reporters[0] === 'blob';
}

function isBlobReporterArgument(argument: string, nextArgument?: string): boolean {
	return argument === '--reporter=blob' || (argument === '--reporter' && nextArgument === 'blob');
}

function hasSeparateReporterValue(argument: string, nextArgument?: string): boolean {
	return (
		(argument === '--reporter' ||
			(argument.startsWith('--outputFile') && !argument.includes('='))) &&
		nextArgument !== undefined &&
		!nextArgument.startsWith('-')
	);
}

/** Remove reporter arguments that must only be applied to the merged report. */
export function createProjectArguments(argumentsToForward: readonly string[]): string[] {
	const projectArguments: string[] = [];

	for (let index = 0; index < argumentsToForward.length; index += 1) {
		const argument = argumentsToForward[index];
		if (!argument) continue;
		if (hasSeparateReporterValue(argument, argumentsToForward[index + 1])) {
			index += 1;
			continue;
		}
		if (isReporterArgument(argument)) continue;
		projectArguments.push(argument);
	}

	return projectArguments;
}

/** Keep coverage and reporter arguments for the one aggregate merge process. */
export function createMergeArguments(argumentsToForward: readonly string[]): string[] {
	const mergeArguments: string[] = [];

	for (let index = 0; index < argumentsToForward.length; index += 1) {
		const argument = argumentsToForward[index];
		if (!argument) continue;
		const nextArgument = argumentsToForward[index + 1];
		if (isBlobReporterArgument(argument, nextArgument)) {
			if (argument === '--reporter') index += 1;
			continue;
		}
		const shouldMerge = argument.startsWith('--coverage') || isReporterArgument(argument);
		if (!shouldMerge) continue;

		mergeArguments.push(argument);
		const hasSeparateValue =
			(hasSeparateReporterValue(argument, nextArgument) ||
				(argument.startsWith('--coverage.') && !argument.includes('='))) &&
			nextArgument !== undefined &&
			!nextArgument.startsWith('-');
		if (hasSeparateValue) {
			index += 1;
			mergeArguments.push(argumentsToForward[index]!);
		}
	}

	return mergeArguments;
}

/** Build the command that verifies a targeted invocation matches at least one test. */
export function createListCommand(
	project: (typeof unitTestProjects)[number],
	argumentsToForward: readonly string[]
): string[] {
	return [
		'bunx',
		'vitest',
		'list',
		'--project',
		project,
		'--passWithNoTests',
		...argumentsToForward
	];
}

/** Build one isolated Vitest project command while preserving caller arguments. */
export function createProjectCommand(
	project: (typeof unitTestProjects)[number],
	argumentsToForward: readonly string[],
	blobReportsDirectory?: string
): string[] {
	const hasTestSelection = hasTestSelectionArgument(argumentsToForward);

	return [
		'bunx',
		'vitest',
		'run',
		'--project',
		project,
		...(hasTestSelection ? ['--passWithNoTests'] : []),
		...argumentsToForward,
		...(blobReportsDirectory
			? ['--reporter=blob', `--outputFile=${blobReportsDirectory}/${project}.json`]
			: [])
	];
}

/** Build the command that merges per-project blob reports and their coverage data. */
export function createMergeCommand(
	blobReportsDirectory: string,
	argumentsToForward: readonly string[]
): string[] {
	return [
		'bunx',
		'vitest',
		'run',
		`--merge-reports=${blobReportsDirectory}`,
		...createMergeArguments(argumentsToForward)
	];
}

export function assertCommandSucceeded(status: number | null): void {
	if (status !== 0) throw new Error(`Test command failed with status ${status ?? 1}.`);
}

function runCommand(command: readonly string[], captureOutput = false): string {
	const [executable, ...argumentsToPass] = command;
	if (!executable) throw new Error('A command executable is required.');

	const result = spawnSync(executable, argumentsToPass, {
		stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit',
		encoding: 'utf8'
	});
	if (result.error) throw result.error;
	assertCommandSucceeded(result.status);

	return result.stdout ?? '';
}

/** Run every isolated project, merge reports, then propagate the first project failure. */
export function runSerializedCommands(
	projectCommands: readonly (readonly string[])[],
	mergeCommand: readonly string[] | undefined,
	execute: (command: readonly string[]) => unknown = runCommand
): void {
	let firstProjectFailure: unknown;

	for (const command of projectCommands) {
		try {
			execute(command);
		} catch (error) {
			firstProjectFailure ??= error;
		}
	}

	if (mergeCommand) execute(mergeCommand);
	if (firstProjectFailure) throw firstProjectFailure;
}

if (import.meta.main) {
	const argumentsToForward = normalizeArguments(process.argv.slice(2));
	const shouldPreserveBlobReports = hasBlobReporterArgument(argumentsToForward);
	const shouldMergeReports =
		hasCoverageArgument(argumentsToForward) ||
		(hasReporterArgument(argumentsToForward) && !hasOnlyBlobReporterArgument(argumentsToForward));
	const blobReportsDirectory = shouldPreserveBlobReports
		? '.vitest-reports'
		: shouldMergeReports
			? `.vitest-reports-${process.pid}`
			: undefined;
	const projectArguments = blobReportsDirectory
		? createProjectArguments(argumentsToForward)
		: argumentsToForward;
	if (shouldPreserveBlobReports) {
		rmSync(blobReportsDirectory!, { recursive: true, force: true });
	}

	if (hasTestSelectionArgument(projectArguments)) {
		const hasMatchingTest = unitTestProjects.some(
			(project) => runCommand(createListCommand(project, projectArguments), true).length > 0
		);
		if (!hasMatchingTest) {
			console.error('No unit tests matched the provided arguments.');
			process.exit(1);
		}
	}

	try {
		runSerializedCommands(
			unitTestProjects.map((project) =>
				createProjectCommand(project, projectArguments, blobReportsDirectory)
			),
			shouldMergeReports && blobReportsDirectory
				? createMergeCommand(blobReportsDirectory, argumentsToForward)
				: undefined
		);
	} finally {
		if (blobReportsDirectory && !shouldPreserveBlobReports) {
			rmSync(blobReportsDirectory, { recursive: true, force: true });
		}
	}
}
