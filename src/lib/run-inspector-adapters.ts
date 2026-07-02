/**
 * Pure adapters from the RunInspectorProjection transcript to the shapes the
 * Cinder run-pane components consume (EventStreamViewer entries and
 * RunStepTimeline steps). Everything here derives from durable history only.
 */

import type { StreamEvent as ViewerEvent } from '@lostgradient/cinder/event-stream-viewer';
import type { RunStep, RunStepStatus } from '@lostgradient/cinder/run-step-timeline';
import type {
	RunInspectorEvent,
	RunInspectorProjection
} from '$lib/server/observability/projection';
import type { RunTimelineLane } from '$lib/types';

type ToolCallPayload = {
	calls?: Array<{ id?: string; name?: string; input?: unknown }>;
};

type ToolResultPayload = {
	callId?: string;
	content?: unknown;
	isError?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function truncate(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolCallNames(payload: unknown): string {
	const calls = (asRecord(payload) as ToolCallPayload).calls ?? [];
	const names = calls.map((call) => call.name ?? 'tool').filter(Boolean);
	return names.length > 0 ? names.join(', ') : 'tool call';
}

/** One-line human summary of a transcript event, used by the viewer and the scrubber caption. */
export function summarizeInspectorEvent(event: RunInspectorEvent): string {
	const payload = asRecord(event.payload);
	switch (event.kind) {
		case 'user_message':
			return `user_message · ${truncate(String(payload.text ?? ''))}`;
		case 'assistant_message':
			return `assistant_message · ${truncate(String(payload.text ?? ''))}`;
		case 'tool_call':
			return `tool_call · ${toolCallNames(event.payload)}`;
		case 'tool_result': {
			const result = payload as ToolResultPayload;
			return `tool_result · ${result.callId ?? ''} · ${result.isError ? 'error' : 'ok'}`;
		}
		case 'approval_request':
			return `approval_request · ${String(payload.toolName ?? 'tool')} · waiting on human approval`;
		case 'approval_resolution':
			return `approval_resolution · ${String(payload.action ?? '')}`;
		case 'lifecycle':
			return `lifecycle · ${String(payload.status ?? '')}`;
		default:
			return event.kind;
	}
}

function eventSeverity(event: RunInspectorEvent): ViewerEvent['severity'] {
	const payload = asRecord(event.payload);
	if (event.kind === 'tool_result') return payload.isError ? 'error' : 'success';
	if (event.kind === 'approval_request') return 'warning';
	if (event.kind === 'lifecycle') {
		const status = String(payload.status ?? '');
		if (status === 'failed') return 'error';
		if (status === 'complete') return 'success';
		return 'info';
	}
	if (event.kind === 'tool_call' || event.kind === 'assistant_message') return 'info';
	return 'debug';
}

/** Maps transcript events to EventStreamViewer entries, preserving durable sequences. */
export function transcriptToViewerEvents(transcript: RunInspectorEvent[]): ViewerEvent[] {
	return transcript.map((event) => ({
		id: event.id,
		sequence: event.sequence,
		datetime: event.createdAt,
		severity: eventSeverity(event),
		source: 'transcript',
		summary: `${event.sequence}  ${summarizeInspectorEvent(event)}`,
		details: event.payload
	}));
}

function laneToStep(lane: RunTimelineLane): RunStep {
	const status: RunStepStatus =
		lane.status === 'complete'
			? 'succeeded'
			: lane.status === 'failed'
				? 'failed'
				: lane.status === 'cancelled'
					? 'cancelled'
					: 'running';
	const tokens = lane.budget ? lane.budget.inputTokens + lane.budget.outputTokens : null;
	return {
		id: lane.id,
		label: tokens != null ? `${lane.label} · ${formatTokens(tokens)}` : lane.label,
		status,
		children: lane.children?.filter((child) => child.kind === 'subagent').map(laneToStep)
	};
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
}

function formatDuration(durationMs: number): string {
	return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

function stringifyPayload(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Builds RunStepTimeline steps from the durable transcript: task receipt,
 * model calls, tool calls (with retry counts and payload detail panels),
 * approval waits, and subagent lanes as nested children.
 */
export function transcriptToRunSteps(
	inspector: RunInspectorProjection,
	options: { running: boolean; hasPendingApproval: boolean }
): RunStep[] {
	const steps: RunStep[] = [];
	const transcript = inspector.transcript;
	const link = { href: inspector.temporalWebUrl, label: 'history ↗' };

	const resultsByCallId = new Map<string, ToolResultPayload>();
	for (const event of transcript) {
		if (event.kind !== 'tool_result') continue;
		const payload = asRecord(event.payload) as ToolResultPayload;
		if (payload.callId) resultsByCallId.set(payload.callId, payload);
	}

	let lanesInserted = false;
	for (const event of transcript) {
		const payload = asRecord(event.payload);
		if (event.kind === 'user_message') {
			steps.push({ id: event.id, label: 'Receive task', status: 'succeeded', link });
		} else if (event.kind === 'assistant_message') {
			steps.push({ id: event.id, label: 'Model call', status: 'succeeded', link });
		} else if (event.kind === 'tool_call') {
			const calls = (asRecord(event.payload) as ToolCallPayload).calls ?? [];
			const results = calls
				.map((call) => (call.id ? resultsByCallId.get(call.id) : undefined))
				.filter((result): result is ToolResultPayload => result !== undefined);
			const failed = results.some((result) => result.isError);
			const done = results.length >= calls.length && calls.length > 0;
			const status: RunStepStatus = failed
				? 'failed'
				: done
					? 'succeeded'
					: options.running
						? 'running'
						: 'pending';
			steps.push({
				id: event.id,
				label: toolCallNames(event.payload),
				status,
				duration: event.durationMs != null ? formatDuration(event.durationMs) : undefined,
				attemptCount: event.attempts,
				actionsCount: calls.length > 1 ? calls.length : undefined,
				link,
				details: [
					{
						id: `${event.id}-input`,
						label: 'Input',
						content: stringifyPayload(calls.length === 1 ? calls[0].input : calls)
					},
					...(results.length > 0
						? [
								{
									id: `${event.id}-result`,
									label: 'Result',
									content: stringifyPayload(
										results.length === 1 ? results[0].content : results.map((r) => r.content)
									)
								}
							]
						: [])
				]
			});
		} else if (event.kind === 'approval_request') {
			steps.push({
				id: event.id,
				label: `Approval · ${String(payload.toolName ?? 'tool')}`,
				status: options.hasPendingApproval ? 'waiting_approval' : 'succeeded',
				link
			});
		} else if (event.kind === 'subagent.start' && !lanesInserted && inspector.timelineLanes) {
			lanesInserted = true;
			steps.push({
				id: `${event.id}-delegates`,
				label: 'Fan out delegates',
				status: inspector.timelineLanes.some((lane) => lane.status === 'running')
					? 'running'
					: 'succeeded',
				link,
				children: inspector.timelineLanes
					.flatMap((lane) => (lane.kind === 'parent' ? (lane.children ?? []) : [lane]))
					.filter((lane) => lane.kind === 'subagent')
					.map(laneToStep)
			});
		}
	}

	return steps;
}
