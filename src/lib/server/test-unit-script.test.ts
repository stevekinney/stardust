import { describe, expect, it } from 'vitest';
import {
	createListCommand,
	createProjectCommand,
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
});
