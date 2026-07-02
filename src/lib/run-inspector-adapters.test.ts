import { describe, expect, it } from 'vitest';
import type { RunInspectorProjection } from '$lib/server/observability/projection';
import {
	summarizeInspectorEvent,
	transcriptToRunSteps,
	transcriptToViewerEvents
} from './run-inspector-adapters';

function makeInspector(
	transcript: Array<{
		id: string;
		kind: string;
		sequence: number;
		payload: unknown;
		durationMs?: number;
		attempts?: number;
	}>
): RunInspectorProjection {
	return {
		transcript: transcript.map((event) => ({ ...event, createdAt: '2026-07-01T12:00:00Z' })),
		temporalWebUrl: 'http://localhost:8233/namespaces/default/workflows/wf-1/history',
		timelineLanes: undefined
	} as unknown as RunInspectorProjection;
}

describe('transcriptToViewerEvents', () => {
	it('maps transcript events with sequence, severity, and summaries', () => {
		const inspector = makeInspector([
			{ id: 'e1', kind: 'user_message', sequence: 1, payload: { text: 'Do the thing' } },
			{
				id: 'e2',
				kind: 'tool_call',
				sequence: 2,
				payload: { calls: [{ id: 'c1', name: 'write_file', input: {} }] }
			},
			{
				id: 'e3',
				kind: 'tool_result',
				sequence: 3,
				payload: { callId: 'c1', content: 'ok', isError: false }
			},
			{ id: 'e4', kind: 'lifecycle', sequence: 4, payload: { status: 'complete' } }
		]);

		const events = transcriptToViewerEvents(inspector.transcript);

		expect(events).toHaveLength(4);
		expect(events[0].sequence).toBe(1);
		expect(events[1].summary).toContain('write_file');
		expect(events[2].severity).toBe('success');
		expect(events[3].severity).toBe('success');
	});

	it('marks failed tool results and approval requests with warning tones', () => {
		const inspector = makeInspector([
			{
				id: 'e1',
				kind: 'tool_result',
				sequence: 1,
				payload: { callId: 'c1', content: 'boom', isError: true }
			},
			{ id: 'e2', kind: 'approval_request', sequence: 2, payload: { toolName: 'run_command' } }
		]);

		const events = transcriptToViewerEvents(inspector.transcript);

		expect(events[0].severity).toBe('error');
		expect(events[1].severity).toBe('warning');
		expect(events[1].summary).toContain('waiting on human approval');
	});
});

describe('transcriptToRunSteps', () => {
	it('builds task, model call, and tool steps with durations and payload details', () => {
		const inspector = makeInspector([
			{ id: 'e1', kind: 'user_message', sequence: 1, payload: { text: 'Do the thing' } },
			{ id: 'e2', kind: 'assistant_message', sequence: 2, payload: { text: 'On it.' } },
			{
				id: 'e3',
				kind: 'tool_call',
				sequence: 3,
				payload: { calls: [{ id: 'c1', name: 'write_file', input: { path: 'a.txt' } }] },
				durationMs: 1234,
				attempts: 2
			},
			{
				id: 'e4',
				kind: 'tool_result',
				sequence: 4,
				payload: { callId: 'c1', content: 'wrote 19 bytes', isError: false }
			}
		]);

		const steps = transcriptToRunSteps(inspector, { running: false, hasPendingApproval: false });

		expect(steps.map((step) => step.label)).toEqual(['Receive task', 'Model call', 'write_file']);
		const tool = steps[2];
		expect(tool.status).toBe('succeeded');
		expect(tool.duration).toBe('1.2s');
		expect(tool.attemptCount).toBe(2);
		expect(tool.details?.some((detail) => detail.content.includes('a.txt'))).toBe(true);
		expect(tool.details?.some((detail) => detail.content.includes('wrote 19 bytes'))).toBe(true);
	});

	it('marks a pending approval as waiting_approval and unresolved tool calls as running', () => {
		const inspector = makeInspector([
			{
				id: 'e1',
				kind: 'tool_call',
				sequence: 1,
				payload: { calls: [{ id: 'c1', name: 'run_command', input: {} }] }
			},
			{ id: 'e2', kind: 'approval_request', sequence: 2, payload: { toolName: 'run_command' } }
		]);

		const steps = transcriptToRunSteps(inspector, { running: true, hasPendingApproval: true });

		expect(steps[0].status).toBe('running');
		expect(steps[1].label).toBe('Approval · run_command');
		expect(steps[1].status).toBe('waiting_approval');
	});

	it('summarizes events for the scrubber caption', () => {
		expect(
			summarizeInspectorEvent({
				id: 'e1',
				kind: 'tool_call',
				sequence: 3,
				createdAt: '2026-07-01T12:00:00Z',
				payload: { calls: [{ id: 'c1', name: 'read_ci_runs', input: {} }] }
			})
		).toBe('tool_call · read_ci_runs');
	});
});
