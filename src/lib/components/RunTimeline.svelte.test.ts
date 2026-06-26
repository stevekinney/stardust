import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import RunTimeline from './RunTimeline.svelte';

const baseRun: RunInspectorProjection['run'] = {
	id: 'run-001',
	sessionId: 'session-001',
	workflowId: 'agent-run:run-001',
	status: 'complete',
	model: 'claude-opus-4-5',
	finalAnswer: 'Done.',
	startedAt: '2026-06-26T00:00:00.000Z',
	completedAt: '2026-06-26T00:01:00.000Z'
};

const transcript: RunInspectorProjection['transcript'] = [
	{
		id: 'evt-001',
		kind: 'user_message',
		sequence: 1,
		createdAt: '2026-06-26T00:00:01.000Z',
		payload: { text: 'Hello' }
	},
	{
		id: 'evt-002',
		kind: 'tool_call',
		sequence: 2,
		createdAt: '2026-06-26T00:00:02.000Z',
		payload: { name: 'workspace.writeFile', args: {} }
	},
	{
		id: 'evt-003',
		kind: 'lifecycle',
		sequence: 3,
		createdAt: '2026-06-26T00:00:05.000Z',
		payload: { status: 'complete', recoverySafe: true }
	}
];

const actionMeter: RunInspectorProjection['actionMeter'] = {
	total: 5,
	breakdown: {
		transcriptEvents: 3,
		toolInvocations: 1,
		approvalRequests: 0,
		auditEvents: 1,
		idempotencyEntries: 0
	}
};

const projection: RunInspectorProjection = {
	run: baseRun,
	temporalWebUrl: 'http://localhost:8233/namespaces/default/workflows/agent-run%3Arun-001/history',
	actionMeter,
	transcript,
	toolInvocations: [],
	approvalRequests: [],
	idempotencyEntries: [],
	recoveryMarkers: ['{"status":"complete","recoverySafe":true}']
};

describe('RunTimeline', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders run status and model', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		expect(document.body.textContent).toContain('complete');
		expect(document.body.textContent).toContain('claude-opus-4-5');

		unmount(component);
	});

	it('renders transcript events in sequence order with kind labels', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		const items = document.querySelectorAll('[data-kind]');
		expect(items.length).toBe(3);
		expect(items[0]?.getAttribute('data-kind')).toBe('user_message');
		expect(items[1]?.getAttribute('data-kind')).toBe('tool_call');
		expect(items[2]?.getAttribute('data-kind')).toBe('lifecycle');

		unmount(component);
	});

	it('renders recovery markers distinctly with a dedicated marker element', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		const markers = document.querySelectorAll('[data-recovery-marker]');
		expect(markers.length).toBeGreaterThan(0);

		unmount(component);
	});

	it('renders the action meter total and breakdown', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		expect(document.body.textContent).toContain('5'); // total actions
		expect(document.body.textContent).toContain('transcriptEvents');

		unmount(component);
	});

	it('renders a Temporal Web button when temporalWebUrl is provided', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		const button = document.querySelector('[data-temporal-web]');
		expect(button).not.toBeNull();
		expect(button?.textContent).toContain('Temporal Web');

		unmount(component);
	});

	it('renders empty state when transcript is empty', () => {
		const emptyProjection: RunInspectorProjection = {
			...projection,
			transcript: [],
			recoveryMarkers: []
		};
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection: emptyProjection }
		});

		expect(document.body.textContent).toContain('No transcript');

		unmount(component);
	});

	it('calls onTemporalWeb when the Temporal Web link is clicked', () => {
		let clicked = false;
		const component = mount(RunTimeline, {
			target: document.body,
			props: {
				projection,
				onTemporalWeb: () => {
					clicked = true;
				}
			}
		});

		const link = document.querySelector<HTMLButtonElement>('[data-temporal-web]');
		link?.click();
		flushSync();
		expect(clicked).toBe(true);

		unmount(component);
	});
});
