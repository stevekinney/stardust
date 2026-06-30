import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { SandboxCommandInput, SandboxCommandResult } from '../sandbox/sandbox-provider';

type RepositoryInspectionInput = {
	sessionKey: string;
	runId: string;
	workspacePath?: string;
	includePackageScripts?: boolean;
	includeRoutes?: boolean;
	includeTests?: boolean;
	includeGitStatus?: boolean;
	path?: string;
	runCommand?: (input: SandboxCommandInput) => Promise<SandboxCommandResult>;
};

export async function inspectRepository(input: RepositoryInspectionInput) {
	const root = input.workspacePath ? resolve(input.workspacePath) : process.cwd();
	const focusPath = input.path ? resolve(root, input.path) : root;

	const [packageSummary, routes, tests, gitStatus] = await Promise.all([
		input.includePackageScripts === false ? null : readPackageSummary(root),
		input.includeRoutes === false ? [] : listMatchingFiles(join(root, 'src', 'routes'), routeFile),
		input.includeTests === false ? [] : listMatchingFiles(root, testFile, 200),
		input.includeGitStatus === false
			? null
			: readGitStatus(input.sessionKey, input.runId, input.runCommand)
	]);

	return {
		root,
		focusPath: relative(root, focusPath) || '.',
		package: packageSummary,
		routes,
		tests: tests.slice(0, 100),
		gitStatus
	};
}

async function readPackageSummary(root: string) {
	const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
		name?: string;
		version?: string;
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	return {
		name: packageJson.name ?? basename(root),
		version: packageJson.version ?? null,
		scripts: packageJson.scripts ?? {},
		dependencies: Object.keys(packageJson.dependencies ?? {}).sort(),
		devDependencies: Object.keys(packageJson.devDependencies ?? {}).sort()
	};
}

async function readGitStatus(
	sessionKey: string,
	runId: string,
	runCommand?: (input: SandboxCommandInput) => Promise<SandboxCommandResult>
) {
	if (!runCommand) return null;
	const result = await runCommand({
		sessionKey,
		runId,
		command: 'git',
		args: ['status', '--short'],
		toolCallId: `${runId}:repository-inspect-git-status`
	});
	return {
		status: result.status,
		exitCode: result.exitCode,
		files: result.stdout
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	};
}

async function listMatchingFiles(
	root: string,
	predicate: (path: string) => boolean,
	limit = 200
): Promise<string[]> {
	const results: string[] = [];
	await walk(root, results, predicate, limit, root);
	return results.sort();
}

async function walk(
	current: string,
	results: string[],
	predicate: (path: string) => boolean,
	limit: number,
	root: string
) {
	if (results.length >= limit) return;
	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		entries = (await readdir(current, { withFileTypes: true, encoding: 'utf8' })) as Array<{
			name: string;
			isDirectory(): boolean;
		}>;
	} catch {
		return;
	}
	for (const entry of entries) {
		if (results.length >= limit) return;
		if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svelte-kit') {
			continue;
		}
		const absolute = join(current, entry.name);
		if (entry.isDirectory()) {
			await walk(absolute, results, predicate, limit, root);
		} else if (predicate(absolute)) {
			results.push(relative(root, absolute));
		}
	}
}

function routeFile(path: string): boolean {
	return /\/src\/routes\/.+\/\+(page|layout|server)\.(svelte|ts)$/.test(path);
}

function testFile(path: string): boolean {
	return /\.(test|spec)\.(ts|svelte\.ts)$/.test(path) || /\.e2e\.ts$/.test(path);
}
