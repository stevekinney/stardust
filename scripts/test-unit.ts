import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export const unitTestProjects = ['client', 'server', 'workflows'] as const;

/** Remove flags that the isolated project runner supplies itself. */
export function normalizeArguments(argumentsToForward: readonly string[]): string[] {
	return argumentsToForward.filter((argument) => argument !== '--run');
}

/** Return whether a caller requested Vitest coverage collection. */
export function hasCoverageArgument(argumentsToForward: readonly string[]): boolean {
	return argumentsToForward.some(
		(argument) =>
			argument === '--coverage' ||
			argument === '--coverage.enabled' ||
			argument.startsWith('--coverage=') ||
			argument.startsWith('--coverage.enabled=')
	);
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
	return [
		'bunx',
		'vitest',
		'run',
		'--project',
		project,
		...(argumentsToForward.length > 0 ? ['--passWithNoTests'] : []),
		...argumentsToForward,
		...(blobReportsDirectory
			? ['--reporter=blob', `--outputFile=${blobReportsDirectory}/${project}.json`]
			: [])
	];
}

/** Build the command that merges per-project blob reports and their coverage data. */
export function createMergeCommand(blobReportsDirectory: string): string[] {
	return ['bunx', 'vitest', 'run', `--merge-reports=${blobReportsDirectory}`, '--coverage'];
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
	const blobReportsDirectory = hasCoverageArgument(argumentsToForward)
		? `.vitest-reports-${process.pid}`
		: undefined;

	if (argumentsToForward.length > 0) {
		const hasMatchingTest = unitTestProjects.some(
			(project) => runCommand(createListCommand(project, argumentsToForward), true).length > 0
		);
		if (!hasMatchingTest) {
			console.error('No unit tests matched the provided arguments.');
			process.exit(1);
		}
	}

	try {
		for (const project of unitTestProjects) {
			runCommand(createProjectCommand(project, argumentsToForward, blobReportsDirectory));
		}

		if (blobReportsDirectory) runCommand(createMergeCommand(blobReportsDirectory));
	} finally {
		if (blobReportsDirectory) rmSync(blobReportsDirectory, { recursive: true, force: true });
	}
}
