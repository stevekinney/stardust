import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import { TASK_QUEUE_ORCHESTRATOR } from '$lib/server/temporal/task-queues';
import RunTimeline from './RunTimeline.svelte';

const baseRun: RunInspectorProjection['run'] = {
	id: 'run-001',
	sessionId: 'session-001',
	workflowId: 'agent-run:run-001',
	status: 'complete',
	model: 'claude-opus-4-5',
	finalAnswer: 'Done.',
	usage: null,
	budget: null,
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
	taskQueue: TASK_QUEUE_ORCHESTRATOR,
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

	it('renders subagent lanes section when timelineLanes is present', () => {
		const projectionWithLanes: RunInspectorProjection = {
			...projection,
			timelineLanes: [
				{
					id: 'run-001',
					label: 'Parent run',
					kind: 'parent',
					status: 'complete',
					children: [
						{
							id: 'run-001:research',
							label: 'Research',
							kind: 'subagent',
							status: 'complete',
							budget: { inputTokens: 70, outputTokens: 20, estimatedCostUsd: 0.0007 }
						}
					]
				}
			]
		};
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection: projectionWithLanes }
		});

		const laneSection = document.querySelector('[data-subagent-lanes]');
		expect(laneSection).not.toBeNull();
		expect(document.body.textContent).toContain('Research');
		expect(document.body.textContent).toContain('Parent run');

		unmount(component);
	});

	it('omits subagent lanes section when timelineLanes is absent', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		const laneSection = document.querySelector('[data-subagent-lanes]');
		expect(laneSection).toBeNull();

		unmount(component);
	});

	it('hides engineer overlay when engineerView is false (default)', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		expect(document.querySelector('[data-engineer-overlay]')).toBeNull();

		unmount(component);
	});

	it('shows engineer overlay when engineerView is true', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection, engineerView: true }
		});

		expect(document.querySelector('[data-engineer-overlay]')).not.toBeNull();

		unmount(component);
	});

	it('renders task queue row in engineer overlay when engineerView is true', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection, engineerView: true }
		});

		const taskQueueRow = document.querySelector('[data-task-queue]');
		expect(taskQueueRow).not.toBeNull();
		expect(taskQueueRow?.textContent).toContain(TASK_QUEUE_ORCHESTRATOR);

		unmount(component);
	});

	it('omits task queue row when engineerView is false', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection }
		});

		expect(document.querySelector('[data-task-queue]')).toBeNull();

		unmount(component);
	});

	it('shows raw event buttons on each transcript item when engineerView is true', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection, engineerView: true }
		});

		const rawEventBtns = document.querySelectorAll('[data-raw-event]');
		expect(rawEventBtns.length).toBe(transcript.length);

		unmount(component);
	});

	it('renders per-kind markers for each transcript item when engineerView is true', () => {
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection, engineerView: true }
		});

		const kindMarkers = document.querySelectorAll('[data-eng-kind-marker]');
		expect(kindMarkers.length).toBe(transcript.length);

		// Verify known kind-to-symbol mappings via data-eng-kind (not data-kind, which belongs
		// to the <li> elements only so that [data-kind] count stays unambiguous).
		const userMsgMarker = document.querySelector(
			'[data-eng-kind-marker][data-eng-kind="user_message"]'
		);
		expect(userMsgMarker?.textContent).toBe('↓');

		const toolCallMarker = document.querySelector(
			'[data-eng-kind-marker][data-eng-kind="tool_call"]'
		);
		expect(toolCallMarker?.textContent).toBe('⚙');

		const lifecycleMarker = document.querySelector(
			'[data-eng-kind-marker][data-eng-kind="lifecycle"]'
		);
		expect(lifecycleMarker?.textContent).toBe('◎');

		unmount(component);
	});

	it('[data-kind] count is exactly the transcript length even when engineerView is true', () => {
		// Regression guard: the engineer-view markers use data-eng-kind (not data-kind) so
		// querySelectorAll('[data-kind]') always returns one element per transcript event,
		// regardless of which view is active.
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection, engineerView: true }
		});

		const items = document.querySelectorAll('[data-kind]');
		expect(items.length).toBe(transcript.length);

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

	it('renders step duration badge when event.durationMs is present on a tool_call', () => {
		const transcriptWithDuration: RunInspectorProjection['transcript'] = [
			{
				id: 'evt-d-001',
				kind: 'tool_call',
				sequence: 1,
				createdAt: '2026-06-26T00:00:01.000Z',
				payload: { calls: [{ id: 'tc-d-001', name: 'bash', input: {} }] },
				durationMs: 1500,
				attempts: 1
			}
		];
		const projectionWithDuration: RunInspectorProjection = {
			...projection,
			transcript: transcriptWithDuration,
			recoveryMarkers: []
		};
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection: projectionWithDuration }
		});

		const durationBadge = document.querySelector('[data-step-duration]');
		expect(durationBadge).not.toBeNull();
		// 1500ms = 1.5s
		expect(durationBadge?.textContent).toContain('1.5s');

		unmount(component);
	});

	it('renders attempt badge when event.attempts > 1', () => {
		const transcriptWithRetry: RunInspectorProjection['transcript'] = [
			{
				id: 'evt-r-001',
				kind: 'tool_call',
				sequence: 1,
				createdAt: '2026-06-26T00:00:01.000Z',
				payload: { calls: [{ id: 'tc-r-001', name: 'bash', input: {} }] },
				durationMs: 3000,
				attempts: 3
			}
		];
		const projectionWithRetry: RunInspectorProjection = {
			...projection,
			transcript: transcriptWithRetry,
			recoveryMarkers: []
		};
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection: projectionWithRetry }
		});

		const attemptBadge = document.querySelector('[data-step-attempts]');
		expect(attemptBadge).not.toBeNull();
		expect(attemptBadge?.textContent).toContain('×3');

		unmount(component);
	});

	it('omits attempt badge when event.attempts is 1 or absent', () => {
		const transcriptSingleAttempt: RunInspectorProjection['transcript'] = [
			{
				id: 'evt-s-001',
				kind: 'tool_call',
				sequence: 1,
				createdAt: '2026-06-26T00:00:01.000Z',
				payload: { calls: [{ id: 'tc-s-001', name: 'bash', input: {} }] },
				durationMs: 500,
				attempts: 1
			},
			{
				id: 'evt-s-002',
				kind: 'user_message',
				sequence: 2,
				createdAt: '2026-06-26T00:00:02.000Z',
				payload: { text: 'hello' }
				// no durationMs, no attempts
			}
		];
		const projectionSingleAttempt: RunInspectorProjection = {
			...projection,
			transcript: transcriptSingleAttempt,
			recoveryMarkers: []
		};
		const component = mount(RunTimeline, {
			target: document.body,
			props: { projection: projectionSingleAttempt }
		});

		const attemptBadge = document.querySelector('[data-step-attempts]');
		expect(attemptBadge).toBeNull();

		unmount(component);
	});
});
