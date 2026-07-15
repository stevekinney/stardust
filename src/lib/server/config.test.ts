import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDataPaths } from './config';

describe('localDataPaths', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('reports effective local paths from configuration', () => {
		expect(
			localDataPaths({
				databaseUrl: 'file:local.db',
				artifactDirectory: 'relative-artifacts',
				workspaceRoot: 'relative-workspaces'
			})
		).toEqual([
			{ label: 'Database', value: resolve('local.db') },
			{ label: 'Artifacts', value: resolve('relative-artifacts') },
			{ label: 'Workspaces', value: resolve('relative-workspaces') }
		]);
	});

	it('expands tilde paths for display', () => {
		vi.stubEnv('HOME', '/Users/example');

		expect(
			localDataPaths({
				databaseUrl: 'file:~/.stardust/stardust.db',
				artifactDirectory: '~/.stardust/artifacts',
				workspaceRoot: '~/.stardust/workspaces'
			})
		).toEqual([
			{ label: 'Database', value: '/Users/example/.stardust/stardust.db' },
			{ label: 'Artifacts', value: '/Users/example/.stardust/artifacts' },
			{ label: 'Workspaces', value: join('/Users/example', '.stardust', 'workspaces') }
		]);
	});
});
