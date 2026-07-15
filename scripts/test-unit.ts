import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

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
		if (argument) normalizedArguments.push(argument);
	}

	return normalizedArguments;
}

/** Return whether a caller requested Vitest coverage collection. */
export function hasCoverageArgument(argumentsToForward: readonly string[]): boolean {
	let coverageEnabled = false;

	for (const argument of argumentsToForward) {
		if (argument === '--coverage' || argument === '--coverage.enabled') coverageEnabled = true;
		if (argument === '--coverage=true' || argument === '--coverage.enabled=true') {
			coverageEnabled = true;
		}
		if (argument === '--coverage=false' || argument === '--coverage.enabled=false') {
			coverageEnabled = false;
		}
	}

	return coverageEnabled;
}

/** Return whether caller arguments narrow which tests Vitest should execute. */
export function hasTestSelectionArgument(argumentsToForward: readonly string[]): boolean {
	return argumentsToForward.some(
		(argument) =>
			!argument.startsWith('-') ||
			argument === '-t' ||
			argument === '--testNamePattern' ||
			argument.startsWith('--testNamePattern=') ||
			argument === '--changed' ||
			argument.startsWith('--changed=')
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

/** Return whether reporter output must be aggregated instead of overwritten per project. */
export function hasReporterOutputArgument(argumentsToForward: readonly string[]): boolean {
	return argumentsToForward.some(
		(argument) => argument === '--outputFile' || argument.startsWith('--outputFile')
	);
}

/** Remove reporter arguments that must only be applied to the merged report. */
export function createProjectArguments(argumentsToForward: readonly string[]): string[] {
	const projectArguments: string[] = [];

	for (let index = 0; index < argumentsToForward.length; index += 1) {
		const argument = argumentsToForward[index];
		if (!argument) continue;
		if (argument === '--reporter' || argument === '--outputFile') {
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
		const shouldMerge = argument.startsWith('--coverage') || isReporterArgument(argument);
		if (!shouldMerge) continue;

		mergeArguments.push(argument);
		if (
			(argument === '--reporter' || argument === '--outputFile') &&
			argumentsToForward[index + 1]
		) {
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

function runCommand(command: readonly string[], captureOutput = false): string {
	const [executable, ...argumentsToPass] = command;
	if (!executable) throw new Error('A command executable is required.');

	const result = spawnSync(executable, argumentsToPass, {
		stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit',
		encoding: 'utf8'
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);

	return result.stdout ?? '';
}

if (import.meta.main) {
	const argumentsToForward = normalizeArguments(process.argv.slice(2));
	const shouldMergeReports =
		hasCoverageArgument(argumentsToForward) || hasReporterOutputArgument(argumentsToForward);
	const blobReportsDirectory = shouldMergeReports ? `.vitest-reports-${process.pid}` : undefined;
	const projectArguments = blobReportsDirectory
		? createProjectArguments(argumentsToForward)
		: argumentsToForward;

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
		for (const project of unitTestProjects) {
			runCommand(createProjectCommand(project, projectArguments, blobReportsDirectory));
		}

		if (blobReportsDirectory) {
			runCommand(createMergeCommand(blobReportsDirectory, argumentsToForward));
		}
	} finally {
		if (blobReportsDirectory) rmSync(blobReportsDirectory, { recursive: true, force: true });
	}
}
