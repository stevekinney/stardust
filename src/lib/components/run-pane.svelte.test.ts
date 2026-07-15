import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import { TASK_QUEUE_ORCHESTRATOR } from '$lib/server/temporal/task-queues';
import RunPane from './run-pane.svelte';

const run: RunInspectorProjection['run'] = {
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

const actionMeter: RunInspectorProjection['actionMeter'] = {
	total: 1,
	breakdown: {
		transcriptEvents: 1,
		toolInvocations: 0,
		approvalRequests: 0,
		auditEvents: 0,
		idempotencyEntries: 0
	}
};

const transcript: RunInspectorProjection['transcript'] = [
	{
		id: 'evt-001',
		kind: 'user_message',
		sequence: 1,
		createdAt: '2026-06-26T00:00:01.000Z',
		payload: { text: 'Hello' }
	}
];

const temporalHistorySummary: RunInspectorProjection['temporalHistorySummary'] = {
	available: false,
	source: 'sqlite',
	workflowId: 'agent-run:run-001',
	temporalRunId: 'temporal-run-001',
	namespace: 'default',
	historyLength: 1,
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
};

const durabilityEvidence: RunInspectorProjection['durabilityEvidence'] = {
	latestTranscriptSequence: 1,
	latestSessionTranscriptSequence: 1,
	latestStreamEventId: 1,
	streamGapCount: 0,
	approvalWaitCount: 0,
	retryAttemptCount: 0,
	idempotencyReplayCount: 0,
	heartbeatBackedCommandCount: 0,
	scheduleFireCount: 0,
	memoryCandidateCount: 0
};

const inspector: RunInspectorProjection = {
	run,
	temporalWebUrl: 'http://localhost:8233/namespaces/default/workflows/agent-run%3Arun-001/history',
	taskQueue: TASK_QUEUE_ORCHESTRATOR,
	taskQueues: [TASK_QUEUE_ORCHESTRATOR],
	actionMeter,
	transcript,
	temporalConcepts: [],
	temporalHistorySummary,
	durabilityEvidence,
	activityAttempts: [],
	workflowExecutions: [],
	scheduleRunLinkage: [],
	capabilityEvidence: [],
	toolInvocations: [],
	approvalRequests: [],
	idempotencyEntries: [],
	recoveryMarkers: []
};

describe('RunPane', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	it('marks the filled tabs boundary with an app-owned layout class', () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					files: [],
					commands: [],
					snapshots: [],
					artifacts: [],
					diffs: []
				})
			)
		);

		const component = mount(RunPane, {
			target: document.body,
			props: {
				sessionKey: 'session-001',
				inspector,
				running: false,
				hasPendingApproval: false,
				cursor: null,
				onScrub: vi.fn(),
				onInterrupt: vi.fn()
			}
		});

		expect(document.querySelector('.run-pane-fill')).toBeInstanceOf(HTMLElement);

		unmount(component);
	});
});
