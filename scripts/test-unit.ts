import { spawnSync } from 'node:child_process';

export const unitTestProjects = ['client', 'server', 'workflows'] as const;

/** Build the command that verifies a targeted invocation matches at least one test. */
export function createListCommand(argumentsToForward: readonly string[]): string[] {
	return [
		'bunx',
		'vitest',
		'list',
		...unitTestProjects.flatMap((project) => ['--project', project]),
		...argumentsToForward
	];
}

/** Build one isolated Vitest project command while preserving caller arguments. */
export function createProjectCommand(
	project: (typeof unitTestProjects)[number],
	argumentsToForward: readonly string[]
): string[] {
	return [
		'bunx',
		'vitest',
		'run',
		'--project',
		project,
		...(argumentsToForward.length > 0 ? ['--passWithNoTests'] : []),
		...argumentsToForward
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
	const argumentsToForward = process.argv.slice(2);

	if (argumentsToForward.length > 0) {
		const matchingTests = runCommand(createListCommand(argumentsToForward), true);
		if (matchingTests.length === 0) {
			console.error('No unit tests matched the provided arguments.');
			process.exit(1);
		}
	}

	for (const project of unitTestProjects) {
		runCommand(createProjectCommand(project, argumentsToForward));
	}
}
