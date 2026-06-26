import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client';
import type { RunTimelineLane, SubagentKind } from '../../types';
import {
	approvalRequests,
	auditEvents,
	idempotencyLedger,
	runs,
	streamEvents,
	toolInvocations,
	transcriptEvents
} from '../db/schema';
import { TEMPORAL_NAMESPACE } from '../config';

export type ActionMeterBreakdown = {
	transcriptEvents: number;
	toolInvocations: number;
	approvalRequests: number;
	auditEvents: number;
	idempotencyEntries: number;
};

export type RunInspectorEvent = {
	id: string;
	kind: string;
	sequence: number;
	createdAt: string;
	payload: unknown;
};

export type RunInspectorProjection = {
	run: {
		id: string;
		sessionId: string;
		workflowId: string;
		status: string;
		model: string | null;
		finalAnswer: string | null;
		startedAt: string | null;
		completedAt: string | null;
	};
	temporalWebUrl: string;
	actionMeter: {
		total: number;
		breakdown: ActionMeterBreakdown;
	};
	transcript: RunInspectorEvent[];
	toolInvocations: Array<typeof toolInvocations.$inferSelect>;
	approvalRequests: Array<typeof approvalRequests.$inferSelect>;
	idempotencyEntries: Array<typeof idempotencyLedger.$inferSelect>;
	recoveryMarkers: string[];
	/** Subagent delegation lanes, present when the run delegated to subagents. */
	timelineLanes?: RunTimelineLane[];
};

type SubagentStartPayload = {
	subagentRunId: string;
	kind: SubagentKind;
	label: string;
	startedAt: string;
};

type SubagentCompletePayload = {
	subagentRunId: string;
	kind: SubagentKind;
	label: string;
	status: 'complete' | 'failed' | 'cancelled';
	budget: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
	completedAt: string;
};

function buildTimelineLanes(
	runId: string,
	events: Array<{ kind: string; payload: string }>
): RunTimelineLane[] | undefined {
	if (events.length === 0) return undefined;

	const lanes = new Map<string, RunTimelineLane>();

	for (const event of events) {
		try {
			if (event.kind === 'subagent.start') {
				const payload = JSON.parse(event.payload) as SubagentStartPayload;
				lanes.set(payload.subagentRunId, {
					id: payload.subagentRunId,
					label: payload.label,
					kind: 'subagent',
					status: 'running',
					budget: undefined
				});
			} else if (event.kind === 'subagent.complete') {
				const payload = JSON.parse(event.payload) as SubagentCompletePayload;
				const existing = lanes.get(payload.subagentRunId);
				if (existing) {
					existing.status = payload.status;
					if (payload.budget) {
						existing.budget = payload.budget;
					}
				} else {
					// Complete event without a matching start — reconstruct from complete data.
					lanes.set(payload.subagentRunId, {
						id: payload.subagentRunId,
						label: payload.label,
						kind: 'subagent',
						status: payload.status,
						budget: payload.budget ?? undefined
					});
				}
			}
		} catch {
			// Skip malformed payloads — best-effort lane reconstruction.
		}
	}

	if (lanes.size === 0) return undefined;

	const parentLane: RunTimelineLane = {
		id: runId,
		label: 'Parent run',
		kind: 'parent',
		status: 'complete',
		children: Array.from(lanes.values())
	};

	return [parentLane];
}

function parsePayload(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

export function buildTemporalWebWorkflowUrl(input: {
	workflowId: string;
	namespace?: string;
	baseUrl?: string;
}): string {
	const namespace = encodeURIComponent(input.namespace ?? TEMPORAL_NAMESPACE);
	const workflowId = encodeURIComponent(input.workflowId);
	const baseUrl = input.baseUrl ?? 'http://localhost:8233';
	return `${baseUrl}/namespaces/${namespace}/workflows/${workflowId}/history`;
}

export async function readRunInspectorProjection(
	database: DatabaseClient,
	runId: string
): Promise<RunInspectorProjection | null> {
	const runRows = await database.select().from(runs).where(eq(runs.id, runId)).limit(1);
	const run = runRows[0];
	if (!run) return null;

	const [transcript, toolRows, approvalRows, auditRows, idempotencyRows, subagentEventRows] =
		await Promise.all([
			database
				.select()
				.from(transcriptEvents)
				.where(eq(transcriptEvents.runId, runId))
				.orderBy(asc(transcriptEvents.sequence), asc(transcriptEvents.createdAt)),
			database
				.select()
				.from(toolInvocations)
				.where(eq(toolInvocations.runId, runId))
				.orderBy(asc(toolInvocations.createdAt)),
			database
				.select()
				.from(approvalRequests)
				.where(eq(approvalRequests.runId, runId))
				.orderBy(asc(approvalRequests.createdAt)),
			database
				.select()
				.from(auditEvents)
				.where(eq(auditEvents.runId, runId))
				.orderBy(asc(auditEvents.createdAt)),
			database
				.select()
				.from(idempotencyLedger)
				.where(eq(idempotencyLedger.runId, runId))
				.orderBy(asc(idempotencyLedger.createdAt)),
			database
				.select()
				.from(streamEvents)
				.where(
					and(
						eq(streamEvents.runId, runId),
						inArray(streamEvents.kind, ['subagent.start', 'subagent.complete'])
					)
				)
				.orderBy(asc(streamEvents.sequence))
		]);

	const breakdown: ActionMeterBreakdown = {
		transcriptEvents: transcript.length,
		toolInvocations: toolRows.length,
		approvalRequests: approvalRows.length,
		auditEvents: auditRows.length,
		idempotencyEntries: idempotencyRows.length
	};
	const total = Object.values(breakdown).reduce((sum, count) => sum + count, 0);
	const lifecycleEvents = transcript.filter((event) => event.kind === 'lifecycle');

	const timelineLanes = buildTimelineLanes(runId, subagentEventRows);

	return {
		run: {
			id: run.id,
			sessionId: run.sessionId,
			workflowId: run.workflowId,
			status: run.status,
			model: run.model,
			finalAnswer: run.finalAnswer,
			startedAt: run.startedAt,
			completedAt: run.completedAt
		},
		temporalWebUrl: buildTemporalWebWorkflowUrl({ workflowId: run.workflowId }),
		actionMeter: { total, breakdown },
		transcript: transcript.map((event) => ({
			id: event.id,
			kind: event.kind,
			sequence: event.sequence,
			createdAt: event.createdAt,
			payload: parsePayload(event.payload)
		})),
		toolInvocations: toolRows,
		approvalRequests: approvalRows,
		idempotencyEntries: idempotencyRows,
		recoveryMarkers: lifecycleEvents.map((event) => event.payload),
		...(timelineLanes ? { timelineLanes } : {})
	};
}
