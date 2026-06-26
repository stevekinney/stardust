import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import SandboxInspector from './SandboxInspector.svelte';

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
});
