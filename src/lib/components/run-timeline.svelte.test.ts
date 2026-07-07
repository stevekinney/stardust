import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import { TASK_QUEUE_ORCHESTRATOR } from '$lib/server/temporal/task-queues';
import RunTimeline from './run-timeline.svelte';

const baseRun: RunInspectorProjection['run'] = {
	id: 'run-001',
	sessionId: 'session-001',
	workflowId: 'agent-run:run-001',
	temporalRunId: 'temporal-run-001',
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
		payload: { calls: [{ id: 'call-001', name: 'workspace.writeFile', input: {} }] },
		durationMs: 1500,
		attempts: 3
	},
	{
		id: 'evt-003',
		kind: 'tool_result',
		sequence: 3,
		createdAt: '2026-06-26T00:00:04.000Z',
		payload: { callId: 'call-001', content: { ok: true }, isError: false }
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
	taskQueues: [TASK_QUEUE_ORCHESTRATOR, 'tools-sandbox'],
	actionMeter,
	transcript,
	temporalConcepts: [
		{
			id: 'workflow-run',
			primitive: 'workflow',
			label: 'Workflow',
			summary: 'AgentRunWorkflow owns this durable turn.',
			evidence: 'agent-run:run-001 is complete.',
			source: 'sqlite'
		}
	],
	temporalHistorySummary: {
		available: false,
		source: 'sqlite',
		workflowId: 'agent-run:run-001',
		temporalRunId: 'temporal-run-001',
		namespace: 'default',
		historyLength: 3,
		events: [],
		counts: {
			workflowEvents: 1,
			activityEvents: 0,
			timerEvents: 0,
			childWorkflowEvents: 0,
			updateEvents: 0,
			signalEvents: 0,
			continueAsNewEvents: 0,
			retryEvents: 0
		}
	},
	durabilityEvidence: {
		latestTranscriptSequence: 3,
		latestSessionTranscriptSequence: 3,
		latestStreamEventId: 12,
		streamGapCount: 0,
		approvalWaitCount: 0,
		retryAttemptCount: 0,
		idempotencyReplayCount: 0,
		heartbeatBackedCommandCount: 0,
		scheduleFireCount: 0,
		memoryCandidateCount: 0
	},
	activityAttempts: [],
	workflowExecutions: [],
	scheduleRunLinkage: [],
	capabilityEvidence: [
		{
			id: 'browser',
			label: 'Browser',
			count: 1,
			status: 'used',
			evidence: '1/1 complete'
		},
		{
			id: 'temporal-mcp',
			label: 'Temporal MCP',
			count: 0,
			status: 'available',
			evidence: 'Read-only Temporal triage ready'
		}
	],
	toolInvocations: [],
	approvalRequests: [],
	idempotencyEntries: [],
	recoveryMarkers: []
};

function renderRunTimeline(props: Partial<RunInspectorProjection> = {}, engineerView = false) {
	return mount(RunTimeline, {
		target: document.body,
		props: { projection: { ...projection, ...props }, engineerView }
	});
}

describe('RunTimeline', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders run identity, status, and model', () => {
		const component = renderRunTimeline();

		expect(document.querySelector('.run-timeline')?.getAttribute('aria-label')).toBe(
			'Run inspector timeline'
		);
		expect(document.body.textContent).toContain('agent-run:run-001');
		expect(document.body.textContent).toContain('complete');
		expect(document.body.textContent).toContain('claude-opus-4-5');

		unmount(component);
	});

	it('renders capability evidence and action meter breakdown', () => {
		const component = renderRunTimeline();

		expect(document.querySelector('.capability-strip')?.getAttribute('aria-label')).toBe(
			'Agent capabilities'
		);
		expect(document.body.textContent).toContain('Browser');
		expect(document.body.textContent).toContain('Read-only Temporal triage ready');
		expect(document.querySelectorAll('[data-action-meter-item]')).toHaveLength(5);
		expect(document.body.textContent).toContain('Transcript Events');
		expect(document.body.textContent).not.toContain('transcriptEvents');

		unmount(component);
	});

	it('renders Temporal concept evidence and Cinder-backed run surfaces', () => {
		const component = renderRunTimeline();

		expect(document.body.textContent).toContain('Temporal Concepts');
		expect(document.body.textContent).toContain('AgentRunWorkflow owns this durable turn.');
		expect(document.body.textContent).toContain('Step Timeline');
		expect(document.body.textContent).toContain('Event Stream');
		expect(document.body.textContent).toContain('workspace.writeFile');
		expect(document.body.textContent).toContain('1.5s');

		unmount(component);
	});

	it('renders empty Cinder step state when transcript is empty', () => {
		const component = renderRunTimeline({ transcript: [], recoveryMarkers: [] });

		expect(document.body.textContent).toContain('No steps recorded for this run yet.');

		unmount(component);
	});

	it('renders subagent lanes when timelineLanes are present', () => {
		const component = renderRunTimeline({
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
		});

		expect(document.querySelector('[data-subagent-lanes]')).not.toBeNull();
		expect(document.body.textContent).toContain('Research');
		expect(document.body.textContent).toContain('Parent run');

		unmount(component);
	});

	it('omits engineer overlay when engineerView is false', () => {
		const component = renderRunTimeline();

		expect(document.querySelector('[data-engineer-overlay]')).toBeNull();
		expect(document.querySelector('[data-task-queue]')).toBeNull();

		unmount(component);
	});

	it('shows engineer overlay when engineerView is true', () => {
		const component = renderRunTimeline({}, true);

		const workflowLink = document.querySelector<HTMLButtonElement>(
			'[data-temporal-workflow-link] button'
		);
		expect(document.querySelector('[data-engineer-overlay]')).not.toBeNull();
		expect(document.querySelector('[data-task-queue]')?.textContent).toContain(
			TASK_QUEUE_ORCHESTRATOR
		);
		expect(workflowLink?.textContent).toContain('Open workflow in Temporal Web');
		expect(document.querySelector('[data-engineer-overlay]')?.textContent).not.toContain(
			projection.temporalWebUrl
		);

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

		document.querySelector<HTMLButtonElement>('[data-temporal-web]')?.click();
		flushSync();
		expect(clicked).toBe(true);

		unmount(component);
	});
});
