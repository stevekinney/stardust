import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import WorkspacePanel from './workspace-panel.svelte';

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
	stdout?: string | null;
	stderr?: string | null;
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
	downloadUrl: string;
};

export type WorkspaceDiff = {
	fromSnapshotId: string;
	toSnapshotId: string;
	patch: string;
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
	createdAt: '2026-06-26T00:00:20.000Z',
	downloadUrl: '/api/artifacts/artifact-001?token=signed-token'
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
		const downloadLink = document.querySelector('a[aria-label="Download output.json"]');
		expect(downloadLink?.getAttribute('href')).toBe(sampleArtifact.downloadUrl);

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

	it('renders diffs with SHA pair and patch content', () => {
		const diff: WorkspaceDiff = {
			fromSnapshotId: 'aaa111bbb222',
			toSnapshotId: 'ccc333ddd444',
			patch: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new',
			createdAt: '2026-06-26T00:00:30.000Z'
		};
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: { files: [], commands: [], snapshots: [], artifacts: [], diffs: [diff] }
		});

		expect(document.body.textContent).toContain('aaa111b'); // shortSha of fromSnapshotId
		expect(document.body.textContent).toContain('ccc333d'); // shortSha of toSnapshotId
		const patchEl = document.querySelector('[aria-label="Workspace diff"]');
		expect(patchEl).not.toBeNull();
		expect(patchEl?.textContent).toContain('+new');

		unmount(component);
	});

	it('shows empty state when diffs is empty and other sections are also empty', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: { files: [], commands: [], snapshots: [], artifacts: [], diffs: [] }
		});

		expect(document.body.textContent).toContain('No workspace');

		unmount(component);
	});

	it('renders collapsible stdout output block when command has stdout', () => {
		const commandWithOutput: WorkspaceCommand = {
			...sampleCommand,
			stdout: 'Build succeeded\n3 files written'
		};
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: { files: [], commands: [commandWithOutput], snapshots: [], artifacts: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).not.toBeNull();
		expect(outputEl?.textContent).toContain('Build succeeded');
		expect(outputEl?.textContent).toContain('3 files written');

		unmount(component);
	});

	it('renders collapsible stderr output block when command has stderr', () => {
		const commandWithStderr: WorkspaceCommand = {
			...sampleCommand,
			status: 'failed',
			exitCode: 1,
			stderr: 'error: module not found'
		};
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: { files: [], commands: [commandWithStderr], snapshots: [], artifacts: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).not.toBeNull();
		expect(outputEl?.textContent).toContain('error: module not found');

		unmount(component);
	});

	it('does not render an output block when command has no stdout or stderr', () => {
		const component = mount(WorkspacePanel, {
			target: document.body,
			props: { files: [], commands: [sampleCommand], snapshots: [], artifacts: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).toBeNull();

		unmount(component);
	});
});
