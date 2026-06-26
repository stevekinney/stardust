import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import WorkspacePanel from './WorkspacePanel.svelte';

export type WorkspaceFile = {
	path: string;
	mimeType: string;
	sizeBytes: number;
	modifiedAt?: string;
};

export type WorkspaceCommand = {
	id: string;
	command: string;
	args: string[];
	status: 'complete' | 'failed' | 'pending' | 'running' | 'timeout' | 'killed';
	exitCode: number | null;
	startedAt: string | null;
	completedAt: string | null;
};

export type WorkspaceSnapshot = {
	id: string;
	externalSnapshotId: string;
	reason: string | null;
	createdAt: string;
};

export type WorkspaceArtifact = {
	id: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: number;
	createdAt: string;
};

const sampleFile: WorkspaceFile = {
	path: 'src/main.ts',
	mimeType: 'text/typescript',
	sizeBytes: 1024,
	modifiedAt: '2026-06-26T00:01:00.000Z'
};

const sampleCommand: WorkspaceCommand = {
	id: 'cmd-001',
	command: 'bun',
	args: ['run', 'build'],
	status: 'complete',
	exitCode: 0,
	startedAt: '2026-06-26T00:00:10.000Z',
	completedAt: '2026-06-26T00:00:15.000Z'
};

const sampleSnapshot: WorkspaceSnapshot = {
	id: 'snap-001',
	externalSnapshotId: 'abc123def456',
	reason: 'Before applying patch',
	createdAt: '2026-06-26T00:00:08.000Z'
};

const sampleArtifact: WorkspaceArtifact = {
	id: 'artifact-001',
	objectKey: 'session-001/run-001/output.json',
	mimeType: 'application/json',
	sizeBytes: 2048,
	createdAt: '2026-06-26T00:00:20.000Z'
};

describe('WorkspacePanel', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders files with path and size', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: {
				files: [sampleFile],
				commands: [],
				snapshots: [],
				artifacts: []
			}
		});

		expect(document.body.textContent).toContain('src/main.ts');
		expect(document.body.textContent).toContain('1.0 KB');

		unmount(component);
	});

	it('renders commands with status and exit code', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: {
				files: [],
				commands: [sampleCommand],
				snapshots: [],
				artifacts: []
			}
		});

		expect(document.body.textContent).toContain('bun');
		expect(document.body.textContent).toContain('complete');
		expect(document.body.textContent).toContain('0');

		unmount(component);
	});

	it('renders snapshots with git SHA prefix and reason', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: {
				files: [],
				commands: [],
				snapshots: [sampleSnapshot],
				artifacts: []
			}
		});

		expect(document.body.textContent).toContain('abc123d'); // first 7 chars of SHA
		expect(document.body.textContent).toContain('Before applying patch');

		unmount(component);
	});

	it('renders artifacts with key and MIME type', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: {
				files: [],
				commands: [],
				snapshots: [],
				artifacts: [sampleArtifact]
			}
		});

		expect(document.body.textContent).toContain('output.json');
		expect(document.body.textContent).toContain('application/json');

		unmount(component);
	});

	it('shows empty state when all sections are empty', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: {
				files: [],
				commands: [],
				snapshots: [],
				artifacts: []
			}
		});

		expect(document.body.textContent).toContain('No workspace');

		unmount(component);
	});
});
