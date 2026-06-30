import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SandboxInspector from './sandbox-inspector.svelte';

export type SandboxInfo = {
	id: string;
	sessionId: string;
	name: string;
	provider: string;
	workspacePath: string;
	status: 'active' | 'suspended' | 'terminated';
	gitInitialized: boolean;
	createdAt: string;
	updatedAt: string;
};

export type SandboxCommandRow = {
	id: string;
	command: string;
	args: string | null; // JSON string[]
	status: 'pending' | 'running' | 'complete' | 'failed' | 'timeout' | 'killed';
	exitCode: number | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	stdoutRef?: string | null;
	stderrRef?: string | null;
};

export type SandboxSnapshotRow = {
	id: string;
	externalSnapshotId: string;
	reason: string | null;
	createdAt: string;
};

const sandbox: SandboxInfo = {
	id: 'sandbox-001',
	sessionId: 'session-001',
	name: 'sd-session-001',
	provider: 'local-subprocess',
	workspacePath: '/Users/dev/.stardust/workspaces/session-001',
	status: 'active',
	gitInitialized: true,
	createdAt: '2026-06-26T00:00:00.000Z',
	updatedAt: '2026-06-26T00:00:30.000Z'
};

const recentCommand: SandboxCommandRow = {
	id: 'cmd-001',
	command: 'git',
	args: JSON.stringify(['status']),
	status: 'complete',
	exitCode: 0,
	startedAt: '2026-06-26T00:00:10.000Z',
	completedAt: '2026-06-26T00:00:11.000Z',
	createdAt: '2026-06-26T00:00:10.000Z'
};

const snapshot: SandboxSnapshotRow = {
	id: 'snap-001',
	externalSnapshotId: 'deadbeef1234',
	reason: 'Before patch',
	createdAt: '2026-06-26T00:00:08.000Z'
};

describe('SandboxInspector', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders provider, lifecycle status, and workspace path', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [], snapshots: [] }
		});

		expect(document.body.textContent).toContain('local-subprocess');
		expect(document.body.textContent).toContain('active');
		expect(document.body.textContent).toContain('/Users/dev/.stardust/workspaces/session-001');

		unmount(component);
	});

	it('renders the explicit isolation caveat', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [], snapshots: [] }
		});

		const caveat = document.querySelector('[data-caveat]');
		expect(caveat).not.toBeNull();
		expect(caveat?.textContent).toContain('local subprocess');
		expect(caveat?.textContent?.toLowerCase()).toContain('not');

		unmount(component);
	});

	it('renders recent commands with status and exit code', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [recentCommand], snapshots: [] }
		});

		expect(document.body.textContent).toContain('git');
		expect(document.body.textContent).toContain('complete');

		unmount(component);
	});

	it('renders snapshots with short SHA and reason', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [], snapshots: [snapshot] }
		});

		expect(document.body.textContent).toContain('deadbee'); // first 7 chars
		expect(document.body.textContent).toContain('Before patch');

		unmount(component);
	});

	it('shows a null-sandbox empty state when sandbox is null', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox: null, commands: [], snapshots: [] }
		});

		expect(document.body.textContent).toContain('No sandbox');

		unmount(component);
	});

	it('renders collapsible stdout output block when command has stdoutRef', () => {
		const commandWithOutput: SandboxCommandRow = {
			...recentCommand,
			stdoutRef: 'On branch main\nnothing to commit'
		};
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [commandWithOutput], snapshots: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).not.toBeNull();
		expect(outputEl?.textContent).toContain('On branch main');
		expect(outputEl?.textContent).toContain('nothing to commit');

		unmount(component);
	});

	it('renders collapsible stderr output block when command has stderrRef', () => {
		const commandWithStderr: SandboxCommandRow = {
			...recentCommand,
			status: 'failed',
			exitCode: 128,
			stderrRef: 'fatal: not a git repository'
		};
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [commandWithStderr], snapshots: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).not.toBeNull();
		expect(outputEl?.textContent).toContain('fatal: not a git repository');

		unmount(component);
	});

	it('does not render an output block when command has no stdoutRef or stderrRef', () => {
		const component = mount(SandboxInspector, {
			target: document.body,
			props: { sandbox, commands: [recentCommand], snapshots: [] }
		});

		const outputEl = document.querySelector('[data-command-output]');
		expect(outputEl).toBeNull();

		unmount(component);
	});
});
