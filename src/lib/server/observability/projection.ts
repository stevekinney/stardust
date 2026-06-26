import { asc, eq } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client';
import {
	approvalRequests,
	auditEvents,
	idempotencyLedger,
	runs,
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
};

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

	const [transcript, toolRows, approvalRows, auditRows, idempotencyRows] = await Promise.all([
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
			.orderBy(asc(idempotencyLedger.createdAt))
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
		recoveryMarkers: lifecycleEvents.map((event) => event.payload)
	};
}
