import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client';
import type { ModelUsage, RunBudget, RunTimelineLane, SubagentKind } from '../../types';
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
		/** Grand total token usage (parent + reconciled subagent), persisted at completion. */
		usage: ModelUsage | null;
		/** Budget caps snapshot persisted at run start. */
		budget: RunBudget | null;
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

function parseJsonOrNull<T>(value: string | null | undefined): T | null {
	if (value == null) return null;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
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
			usage: parseJsonOrNull<ModelUsage>(run.usage),
			budget: parseJsonOrNull<RunBudget>(run.budget),
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

/** Filter options for querying runs across the observability store. */
export type QueryRunsFilter = {
	/** Return only runs belonging to this session. */
	sessionId?: string;
	/** Filter by run terminal status. */
	status?: (typeof runs.$inferSelect)['status'];
	/** Filter by model ID. */
	model?: string;
	/** Return only runs that invoked this tool (via tool_invocations join). */
	toolName?: string;
	/** Return only runs that have an approval request in this state. */
	approvalStatus?: (typeof approvalRequests.$inferSelect)['status'];
};

/**
 * Discovers runs matching one or more filter dimensions.
 *
 * session/status/model filters apply directly on the `runs` table.
 * toolName requires a subquery on `tool_invocations.toolName`.
 * approvalStatus requires a subquery on `approval_requests.status`.
 */
export async function queryRuns(
	database: DatabaseClient,
	filter: QueryRunsFilter
): Promise<Array<typeof runs.$inferSelect>> {
	const conditions: ReturnType<typeof eq>[] = [];

	if (filter.sessionId != null) {
		conditions.push(eq(runs.sessionId, filter.sessionId));
	}
	if (filter.status != null) {
		conditions.push(eq(runs.status, filter.status));
	}
	if (filter.model != null) {
		conditions.push(eq(runs.model, filter.model));
	}

	let rows = await database
		.select()
		.from(runs)
		.where(conditions.length > 0 ? and(...conditions) : undefined);

	// Tool-name filter: keep only runs that have at least one matching tool_invocations row.
	if (filter.toolName != null) {
		const toolRunIds = new Set(
			(
				await database
					.select({ runId: toolInvocations.runId })
					.from(toolInvocations)
					.where(eq(toolInvocations.toolName, filter.toolName))
			).map((r) => r.runId)
		);
		rows = rows.filter((r) => toolRunIds.has(r.id));
	}

	// Approval-state filter: keep only runs that have at least one matching approval_requests row.
	if (filter.approvalStatus != null) {
		const approvalRunIds = new Set(
			(
				await database
					.select({ runId: approvalRequests.runId })
					.from(approvalRequests)
					.where(eq(approvalRequests.status, filter.approvalStatus))
			).map((r) => r.runId)
		);
		rows = rows.filter((r) => approvalRunIds.has(r.id));
	}

	return rows;
}
