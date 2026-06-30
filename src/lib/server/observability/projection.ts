import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '../db/client';
import type { ModelUsage, RunBudget, RunTimelineLane, SubagentKind } from '../../types';
import {
	approvalRequests,
	auditEvents,
	idempotencyLedger,
	memoryNotes,
	runs,
	sandboxCommands,
	scheduleFireEvents,
	streamEvents,
	toolInvocations,
	transcriptEvents,
	workflowExecutions
} from '../db/schema';
import { TEMPORAL_NAMESPACE, TEMPORAL_WEB_URL } from '../config';
import { TASK_QUEUE_ORCHESTRATOR } from '../temporal/task-queues';
import {
	buildSqliteTemporalHistorySummary,
	readTemporalHistorySummary,
	type TemporalHistorySummary,
	type TemporalPrimitive
} from '../temporal/history-enrichment';

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
	/**
	 * Wall-clock duration in milliseconds from the tool_call event's createdAt to
	 * the latest matching tool_result. Only present on tool_call events where at
	 * least one tool_result with a matching callId exists in the transcript.
	 */
	durationMs?: number;
	/**
	 * Number of execution attempts for this tool_call batch, including Temporal
	 * activity retries. Only present on tool_call events. Value > 1 means at least
	 * one retry occurred; the badge is shown when this is > 1.
	 */
	attempts?: number;
};

export type TemporalConcept = {
	id: string;
	primitive: TemporalPrimitive;
	label: string;
	summary: string;
	evidence: string;
	source: 'temporal-history' | 'sqlite';
	href?: string;
	status?: string;
};

export type DurabilityEvidence = {
	latestTranscriptSequence: number | null;
	latestSessionTranscriptSequence: number | null;
	latestStreamEventId: number | null;
	streamGapCount: number;
	approvalWaitCount: number;
	retryAttemptCount: number;
	idempotencyReplayCount: number;
	heartbeatBackedCommandCount: number;
	scheduleFireCount: number;
	memoryCandidateCount: number;
};

export type ActivityAttemptEvidence = {
	callId: string;
	activityName: string;
	taskQueue: string;
	status: string;
	attempts: number;
	heartbeatBacked: boolean;
	startedAt: string | null;
	completedAt: string | null;
};

export type WorkflowExecutionEvidence = typeof workflowExecutions.$inferSelect;
export type ScheduleRunLinkage = typeof scheduleFireEvents.$inferSelect;

export type CapabilityEvidence = {
	id:
		| 'browser'
		| 'verification'
		| 'temporal-mcp'
		| 'workspace-safety'
		| 'parallel-delegates'
		| 'reports';
	label: string;
	count: number;
	status: 'available' | 'used' | 'attention';
	evidence: string;
};

export type RunInspectorProjection = {
	run: {
		id: string;
		sessionId: string;
		workflowId: string;
		temporalRunId: string | null;
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
	/**
	 * The Temporal task queue on which the AgentRunWorkflow executes.
	 * Always `agent-orchestrator` — the workflow queue is structurally fixed.
	 * Individual activities fan out to tools/sandbox/model/memory queues,
	 * already visible per-row via `tool_invocations.taskQueue`.
	 */
	taskQueue: string;
	taskQueues: string[];
	actionMeter: {
		total: number;
		breakdown: ActionMeterBreakdown;
	};
	transcript: RunInspectorEvent[];
	temporalConcepts: TemporalConcept[];
	temporalHistorySummary: TemporalHistorySummary;
	durabilityEvidence: DurabilityEvidence;
	activityAttempts: ActivityAttemptEvidence[];
	workflowExecutions: WorkflowExecutionEvidence[];
	scheduleRunLinkage: ScheduleRunLinkage[];
	capabilityEvidence: CapabilityEvidence[];
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
			const parsed = JSON.parse(event.payload) as
				| (SubagentStartPayload & { type?: string })
				| (SubagentCompletePayload & { type?: string });
			const eventKind = event.kind === 'lifecycle' ? parsed.type : event.kind;
			if (eventKind === 'subagent.start') {
				const payload = parsed as SubagentStartPayload;
				lanes.set(payload.subagentRunId, {
					id: payload.subagentRunId,
					label: payload.label,
					kind: 'subagent',
					status: 'running',
					budget: undefined
				});
			} else if (eventKind === 'subagent.complete') {
				const payload = parsed as SubagentCompletePayload;
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

/** Shape of the `tool_call` transcript event payload written by model-runner. */
type ToolCallEventPayload = {
	text?: string;
	calls: Array<{ id: string; name: string; input: unknown }>;
};

/** Shape of the `tool_result` transcript event payload written by persistToolResult. */
type ToolResultEventPayload = {
	callId: string;
	content: unknown;
	isError: boolean;
};

function isToolCallPayload(value: unknown): value is ToolCallEventPayload {
	return (
		value !== null &&
		typeof value === 'object' &&
		'calls' in value &&
		Array.isArray((value as Record<string, unknown>).calls)
	);
}

function isToolResultPayload(value: unknown): value is ToolResultEventPayload {
	return (
		value !== null &&
		typeof value === 'object' &&
		'callId' in value &&
		typeof (value as Record<string, unknown>).callId === 'string'
	);
}

/**
 * Enriches transcript events with per-step timing and attempt counts derived
 * from tool_call/tool_result pairing by callId.
 *
 * Strategy:
 * - Build a map of callId → list of tool_result events (multiple = retries).
 * - For each tool_call event, compute:
 *   - durationMs: from tool_call.createdAt to the latest tool_result for any
 *     callId in its calls[] batch.
 *   - attempts: max count of tool_result rows sharing a callId across the batch.
 */
function enrichTranscriptEvents(
	events: Array<{ kind: string; createdAt: string; payload: string }>
): Array<{ durationMs: number | undefined; attempts: number | undefined }> {
	// Build callId → [{createdAt}] map from tool_result events.
	const resultsByCallId = new Map<string, string[]>();
	for (const event of events) {
		if (event.kind !== 'tool_result') continue;
		const parsed = parsePayload(event.payload);
		if (!isToolResultPayload(parsed)) continue;
		const existing = resultsByCallId.get(parsed.callId);
		if (existing) {
			existing.push(event.createdAt);
		} else {
			resultsByCallId.set(parsed.callId, [event.createdAt]);
		}
	}

	return events.map((event) => {
		if (event.kind !== 'tool_call') {
			return { durationMs: undefined, attempts: undefined };
		}
		const parsed = parsePayload(event.payload);
		if (!isToolCallPayload(parsed) || parsed.calls.length === 0) {
			return { durationMs: undefined, attempts: undefined };
		}

		const callStartMs = new Date(event.createdAt).getTime();
		let maxAttempts = 0;
		let latestResultMs = 0;

		for (const call of parsed.calls) {
			const results = resultsByCallId.get(call.id);
			if (!results || results.length === 0) continue;
			maxAttempts = Math.max(maxAttempts, results.length);
			for (const resultCreatedAt of results) {
				latestResultMs = Math.max(latestResultMs, new Date(resultCreatedAt).getTime());
			}
		}

		return {
			durationMs: latestResultMs > 0 ? latestResultMs - callStartMs : undefined,
			attempts: maxAttempts > 0 ? maxAttempts : undefined
		};
	});
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

function parseMaybeRecord(value: string): Record<string, unknown> | null {
	const parsed = parsePayload(value);
	return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

function countStreamGaps(events: Array<{ sequence: number }>): number {
	return events.filter(
		(event, index) => index > 0 && event.sequence !== events[index - 1]!.sequence + 1
	).length;
}

function buildActivityAttempts(
	toolRows: Array<typeof toolInvocations.$inferSelect>,
	sandboxRows: Array<typeof sandboxCommands.$inferSelect>,
	transcript: Array<{ kind: string; createdAt: string; payload: string }>
): ActivityAttemptEvidence[] {
	const transcriptEnrichments = enrichTranscriptEvents(transcript);
	const attemptsByCallId = new Map<string, number>();
	for (const [index, event] of transcript.entries()) {
		if (event.kind !== 'tool_call') continue;
		const parsed = parsePayload(event.payload);
		if (!isToolCallPayload(parsed)) continue;
		for (const call of parsed.calls) {
			attemptsByCallId.set(call.id, transcriptEnrichments[index]?.attempts ?? 1);
		}
	}

	return toolRows.map((tool) => ({
		callId: tool.toolCallId,
		activityName: tool.toolName,
		taskQueue: tool.taskQueue,
		status: tool.status,
		attempts: attemptsByCallId.get(tool.toolCallId) ?? 1,
		heartbeatBacked: sandboxRows.some((command) => command.toolCallId === tool.toolCallId),
		startedAt: tool.startedAt,
		completedAt: tool.completedAt
	}));
}

function buildFallbackHistoryEvents(input: {
	run: typeof runs.$inferSelect;
	workflowRows: Array<typeof workflowExecutions.$inferSelect>;
	toolRows: Array<typeof toolInvocations.$inferSelect>;
	approvalRows: Array<typeof approvalRequests.$inferSelect>;
	scheduleRows: Array<typeof scheduleFireEvents.$inferSelect>;
	subagentEvents: Array<{ kind: string; payload: string; createdAt: string }>;
}): TemporalHistorySummary['events'] {
	const events: TemporalHistorySummary['events'] = [];
	let eventId = 1;

	for (const workflow of input.workflowRows) {
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_WORKFLOW_EXECUTION',
			concept:
				workflow.status === 'continued_as_new' || workflow.continuedToExecutionId
					? 'continue-as-new'
					: 'workflow',
			label:
				workflow.status === 'continued_as_new' || workflow.continuedToExecutionId
					? 'Workflow continued as new'
					: `${workflow.workflowType} ${workflow.status}`,
			timestamp: workflow.startedAt ?? workflow.createdAt,
			taskQueue: workflow.taskQueue,
			workflowId: workflow.workflowId,
			runId: workflow.temporalRunId ?? undefined
		});
	}

	if (events.length === 0) {
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_RUN_ROW',
			concept: 'workflow',
			label: `Agent run ${input.run.status}`,
			timestamp: input.run.startedAt ?? input.run.createdAt,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowId: input.run.workflowId
		});
	}

	for (const tool of input.toolRows) {
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_TOOL_INVOCATION',
			concept: 'activity',
			label: `${tool.toolName} activity ${tool.status}`,
			timestamp: tool.startedAt ?? tool.createdAt,
			taskQueue: tool.taskQueue
		});
	}

	for (const approval of input.approvalRows) {
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_APPROVAL_REQUEST',
			concept: 'update',
			label: `Approval update ${approval.status}`,
			timestamp: approval.createdAt,
			taskQueue: TASK_QUEUE_ORCHESTRATOR
		});
		if (approval.status === 'pending') {
			events.push({
				eventId: String(eventId++),
				eventType: 'SQLITE_APPROVAL_TIMER',
				concept: 'timer',
				label: 'Approval timeout timer pending',
				timestamp: approval.expiresAt,
				taskQueue: TASK_QUEUE_ORCHESTRATOR
			});
		}
	}

	for (const event of input.subagentEvents) {
		const payload = parseMaybeRecord(event.payload);
		const eventKind = event.kind === 'lifecycle' ? payload?.type : event.kind;
		if (eventKind !== 'subagent.start' && eventKind !== 'subagent.complete') continue;
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_SUBAGENT_LIFECYCLE',
			concept: 'child-workflow',
			label: eventKind === 'subagent.start' ? 'Child workflow started' : 'Child workflow completed',
			timestamp: event.createdAt,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			workflowId: typeof payload?.subagentRunId === 'string' ? payload.subagentRunId : undefined
		});
	}

	for (const fire of input.scheduleRows) {
		events.push({
			eventId: String(eventId++),
			eventType: 'SQLITE_SCHEDULE_FIRE',
			concept: 'schedule',
			label: `Schedule fire ${fire.status}`,
			timestamp: fire.actualTriggerTime,
			workflowId: fire.scheduledWorkflowId ?? undefined,
			runId: fire.scheduledTemporalRunId ?? undefined
		});
	}

	return events;
}

function buildDurabilityEvidence(input: {
	transcript: Array<typeof transcriptEvents.$inferSelect>;
	streamRows: Array<typeof streamEvents.$inferSelect>;
	approvalRows: Array<typeof approvalRequests.$inferSelect>;
	idempotencyRows: Array<typeof idempotencyLedger.$inferSelect>;
	activityAttempts: ActivityAttemptEvidence[];
	sandboxRows: Array<typeof sandboxCommands.$inferSelect>;
	scheduleRows: Array<typeof scheduleFireEvents.$inferSelect>;
	memoryCandidateRows: Array<{ id: string }>;
}): DurabilityEvidence {
	return {
		latestTranscriptSequence:
			input.transcript.length > 0
				? Math.max(...input.transcript.map((event) => event.sequence))
				: null,
		latestSessionTranscriptSequence:
			input.transcript.length > 0
				? Math.max(...input.transcript.map((event) => event.sessionSequence))
				: null,
		latestStreamEventId:
			input.streamRows.length > 0 ? Math.max(...input.streamRows.map((event) => event.id)) : null,
		streamGapCount: countStreamGaps(input.streamRows),
		approvalWaitCount: input.approvalRows.filter((approval) => approval.status === 'pending')
			.length,
		retryAttemptCount: input.activityAttempts.reduce(
			(total, activity) => total + Math.max(0, activity.attempts - 1),
			0
		),
		idempotencyReplayCount: input.idempotencyRows.filter((entry) => entry.status === 'complete')
			.length,
		heartbeatBackedCommandCount: input.sandboxRows.length,
		scheduleFireCount: input.scheduleRows.length,
		memoryCandidateCount: input.memoryCandidateRows.length
	};
}

function buildTemporalConcepts(input: {
	run: typeof runs.$inferSelect;
	temporalWebUrl: string;
	workflowRows: Array<typeof workflowExecutions.$inferSelect>;
	toolRows: Array<typeof toolInvocations.$inferSelect>;
	approvalRows: Array<typeof approvalRequests.$inferSelect>;
	idempotencyRows: Array<typeof idempotencyLedger.$inferSelect>;
	activityAttempts: ActivityAttemptEvidence[];
	sandboxRows: Array<typeof sandboxCommands.$inferSelect>;
	scheduleRows: Array<typeof scheduleFireEvents.$inferSelect>;
	historySummary: TemporalHistorySummary;
}): TemporalConcept[] {
	const concepts: TemporalConcept[] = [
		{
			id: 'workflow-run',
			primitive: 'workflow',
			label: 'Workflow',
			summary: 'AgentRunWorkflow owns this durable turn.',
			evidence: `${input.run.workflowId} is ${input.run.status}.`,
			source: 'sqlite',
			href: input.temporalWebUrl,
			status: input.run.status
		},
		{
			id: 'task-queues',
			primitive: 'task-queue',
			label: 'Task Queues',
			summary: 'Workflow and activities are routed through named task queues.',
			evidence: taskQueuesForProjection(input.workflowRows, input.toolRows).join(', '),
			source: 'sqlite'
		}
	];

	for (const activity of input.activityAttempts) {
		concepts.push({
			id: `activity:${activity.callId}`,
			primitive: activity.heartbeatBacked ? 'heartbeat' : 'activity',
			label: activity.heartbeatBacked ? 'Heartbeat-backed Activity' : 'Activity',
			summary: `${activity.activityName} ran on ${activity.taskQueue}.`,
			evidence: `${activity.attempts} attempt${activity.attempts === 1 ? '' : 's'}; status ${activity.status}.`,
			source: 'sqlite',
			status: activity.status
		});
	}

	for (const approval of input.approvalRows) {
		concepts.push({
			id: `approval:${approval.id}`,
			primitive: 'update',
			label: 'Update',
			summary: 'A human approval update durably gates risky work.',
			evidence: `${approval.toolName} approval is ${approval.status}; expires ${approval.expiresAt}.`,
			source: 'sqlite',
			status: approval.status
		});
		if (approval.status === 'pending') {
			concepts.push({
				id: `approval-timer:${approval.id}`,
				primitive: 'timer',
				label: 'Timer',
				summary: 'The approval wait has an expiration timer.',
				evidence: `Timer deadline ${approval.expiresAt}.`,
				source: 'sqlite'
			});
		}
	}

	for (const workflow of input.workflowRows.filter((row) => row.parentWorkflowId)) {
		concepts.push({
			id: `child-workflow:${workflow.id}`,
			primitive: 'child-workflow',
			label: 'Child Workflow',
			summary: `${workflow.workflowType} is linked to the parent run.`,
			evidence: `${workflow.workflowId} on ${workflow.taskQueue}; status ${workflow.status}.`,
			source: 'sqlite',
			href: buildTemporalWebWorkflowUrl({ workflowId: workflow.workflowId }),
			status: workflow.status
		});
	}

	for (const fire of input.scheduleRows) {
		concepts.push({
			id: `schedule:${fire.id}`,
			primitive: 'schedule',
			label: 'Schedule',
			summary: 'A Temporal Schedule submitted a turn into a durable session workflow.',
			evidence: `${fire.scheduleId} ${fire.status}; accepted run ${fire.acceptedRunId ?? 'not available'}.`,
			source: 'sqlite',
			status: fire.status
		});
	}

	if (input.idempotencyRows.length > 0) {
		concepts.push({
			id: 'idempotency-ledger',
			primitive: 'retry',
			label: 'Retry Idempotency',
			summary: 'Tool side effects are guarded by a persisted idempotency ledger.',
			evidence: `${input.idempotencyRows.length} ledger entr${input.idempotencyRows.length === 1 ? 'y' : 'ies'}.`,
			source: 'sqlite'
		});
	}

	if (input.historySummary.available) {
		for (const event of input.historySummary.events.slice(0, 8)) {
			concepts.push({
				id: `history:${event.eventId}`,
				primitive: event.concept,
				label: event.label,
				summary: 'Read from Temporal workflow history.',
				evidence: `Event ${event.eventId}${event.timestamp ? ` at ${event.timestamp}` : ''}.`,
				source: 'temporal-history',
				href: input.temporalWebUrl
			});
		}
	}

	return concepts;
}

function buildCapabilityEvidence(
	toolRows: Array<typeof toolInvocations.$inferSelect>
): CapabilityEvidence[] {
	const definitions: Array<{
		id: CapabilityEvidence['id'];
		label: string;
		matches: (toolName: string) => boolean;
		emptyEvidence: string;
	}> = [
		{
			id: 'browser',
			label: 'Browser',
			matches: (toolName) => toolName.startsWith('browser.'),
			emptyEvidence: 'Playwright inspection ready'
		},
		{
			id: 'verification',
			label: 'Verification',
			matches: (toolName) => toolName === 'verification.run',
			emptyEvidence: 'Structured checks ready'
		},
		{
			id: 'temporal-mcp',
			label: 'Temporal MCP',
			matches: (toolName) => toolName === 'temporal.inspect' || toolName === 'temporal.mcp.call',
			emptyEvidence: 'Read-only Temporal triage ready'
		},
		{
			id: 'workspace-safety',
			label: 'Workspace Safety',
			matches: (toolName) =>
				toolName === 'workspace.diff' ||
				toolName === 'sandbox.restore' ||
				toolName === 'sandbox.snapshot' ||
				toolName === 'workspace.writeFile' ||
				toolName === 'workspace.applyPatch',
			emptyEvidence: 'Diff and rollback tools ready'
		},
		{
			id: 'parallel-delegates',
			label: 'Parallel Delegates',
			matches: (toolName) => toolName === 'delegate.parallel',
			emptyEvidence: 'Child workflow fan-out ready'
		},
		{
			id: 'reports',
			label: 'Reports',
			matches: (toolName) => toolName === 'artifact.createReport',
			emptyEvidence: 'Markdown artifacts ready'
		}
	];

	return definitions.map((definition) => {
		const rows = toolRows.filter((tool) => definition.matches(tool.toolName));
		const failed = rows.filter((tool) => tool.status === 'failed').length;
		const complete = rows.filter((tool) => tool.status === 'complete').length;
		return {
			id: definition.id,
			label: definition.label,
			count: rows.length,
			status: failed > 0 ? 'attention' : rows.length > 0 ? 'used' : 'available',
			evidence:
				rows.length === 0
					? definition.emptyEvidence
					: `${complete}/${rows.length} complete${failed > 0 ? `, ${failed} failed` : ''}`
		};
	});
}

function taskQueuesForProjection(
	workflowRows: Array<typeof workflowExecutions.$inferSelect>,
	toolRows: Array<typeof toolInvocations.$inferSelect>
): string[] {
	return Array.from(
		new Set([
			TASK_QUEUE_ORCHESTRATOR,
			...workflowRows.map((workflow) => workflow.taskQueue),
			...toolRows.map((tool) => tool.taskQueue)
		])
	).filter(Boolean);
}

export function buildTemporalWebWorkflowUrl(input: {
	workflowId: string;
	namespace?: string;
	baseUrl?: string;
}): string {
	const namespace = encodeURIComponent(input.namespace ?? TEMPORAL_NAMESPACE);
	const workflowId = encodeURIComponent(input.workflowId);
	const baseUrl = input.baseUrl ?? TEMPORAL_WEB_URL;
	return `${baseUrl}/namespaces/${namespace}/workflows/${workflowId}/history`;
}

export async function readRunInspectorProjection(
	database: DatabaseClient,
	runId: string
): Promise<RunInspectorProjection | null> {
	const runRows = await database.select().from(runs).where(eq(runs.id, runId)).limit(1);
	const run = runRows[0];
	if (!run) return null;

	const [
		transcript,
		toolRows,
		approvalRows,
		auditRows,
		idempotencyRows,
		streamRows,
		sandboxRows,
		workflowRows,
		scheduleRows,
		memoryCandidateRows
	] = await Promise.all([
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
			.where(eq(streamEvents.runId, runId))
			.orderBy(asc(streamEvents.sequence), asc(streamEvents.id)),
		database
			.select()
			.from(sandboxCommands)
			.where(eq(sandboxCommands.runId, runId))
			.orderBy(asc(sandboxCommands.createdAt)),
		database
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.runId, runId))
			.orderBy(asc(workflowExecutions.createdAt)),
		database
			.select()
			.from(scheduleFireEvents)
			.where(eq(scheduleFireEvents.acceptedRunId, runId))
			.orderBy(asc(scheduleFireEvents.actualTriggerTime)),
		database
			.select({ id: memoryNotes.id })
			.from(memoryNotes)
			.where(and(eq(memoryNotes.runId, runId), isNull(memoryNotes.confirmedAt)))
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

	const transcriptSubagentRows = lifecycleEvents.filter((event) => {
		const payload = parseMaybeRecord(event.payload);
		return payload?.type === 'subagent.start' || payload?.type === 'subagent.complete';
	});
	const streamSubagentRows = streamRows.filter(
		(event) => event.kind === 'subagent.start' || event.kind === 'subagent.complete'
	);
	const subagentEventRows = [...transcriptSubagentRows, ...streamSubagentRows].sort(
		(left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
	);
	const timelineLanes = buildTimelineLanes(runId, subagentEventRows);
	const enrichments = enrichTranscriptEvents(transcript);
	const activityAttempts = buildActivityAttempts(toolRows, sandboxRows, transcript);
	const temporalRunId =
		workflowRows.find((workflow) => workflow.workflowId === run.workflowId)?.temporalRunId ??
		workflowRows[0]?.temporalRunId ??
		null;
	const taskQueues = taskQueuesForProjection(workflowRows, toolRows);
	const temporalWebUrl = buildTemporalWebWorkflowUrl({ workflowId: run.workflowId });
	const fallbackHistorySummary = buildSqliteTemporalHistorySummary({
		workflowId: run.workflowId,
		temporalRunId,
		events: buildFallbackHistoryEvents({
			run,
			workflowRows,
			toolRows,
			approvalRows,
			scheduleRows,
			subagentEvents: subagentEventRows
		}),
		historyLength:
			workflowRows.find((workflow) => workflow.workflowId === run.workflowId)?.historyLength ?? null
	});
	const temporalHistorySummary = await readTemporalHistorySummary({
		workflowId: run.workflowId,
		temporalRunId,
		fallback: fallbackHistorySummary
	});
	const durabilityEvidence = buildDurabilityEvidence({
		transcript,
		streamRows,
		approvalRows,
		idempotencyRows,
		activityAttempts,
		sandboxRows,
		scheduleRows,
		memoryCandidateRows
	});
	const temporalConcepts = buildTemporalConcepts({
		run,
		temporalWebUrl,
		workflowRows,
		toolRows,
		approvalRows,
		idempotencyRows,
		activityAttempts,
		sandboxRows,
		scheduleRows,
		historySummary: temporalHistorySummary
	});

	return {
		run: {
			id: run.id,
			sessionId: run.sessionId,
			workflowId: run.workflowId,
			temporalRunId,
			status: run.status,
			model: run.model,
			finalAnswer: run.finalAnswer,
			usage: parseJsonOrNull<ModelUsage>(run.usage),
			budget: parseJsonOrNull<RunBudget>(run.budget),
			startedAt: run.startedAt,
			completedAt: run.completedAt
		},
		temporalWebUrl,
		taskQueue: TASK_QUEUE_ORCHESTRATOR,
		taskQueues,
		actionMeter: { total, breakdown },
		transcript: transcript.map((event, index) => ({
			id: event.id,
			kind: event.kind,
			sequence: event.sequence,
			createdAt: event.createdAt,
			payload: parsePayload(event.payload),
			...enrichments[index]
		})),
		temporalConcepts,
		temporalHistorySummary,
		durabilityEvidence,
		activityAttempts,
		workflowExecutions: workflowRows,
		scheduleRunLinkage: scheduleRows,
		capabilityEvidence: buildCapabilityEvidence(toolRows),
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
