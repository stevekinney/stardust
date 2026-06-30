import { Client, Connection } from '@temporalio/client';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE } from '../config';

export type TemporalPrimitive =
	| 'workflow'
	| 'activity'
	| 'task-queue'
	| 'timer'
	| 'child-workflow'
	| 'update'
	| 'signal'
	| 'schedule'
	| 'retry'
	| 'heartbeat'
	| 'continue-as-new';

export type TemporalHistoryEventSummary = {
	eventId: string;
	eventType: string;
	concept: TemporalPrimitive;
	label: string;
	timestamp: string | null;
	attempt?: number;
	activityType?: string;
	taskQueue?: string;
	workflowId?: string;
	runId?: string;
};

export type TemporalHistorySummary = {
	available: boolean;
	source: 'temporal' | 'sqlite';
	workflowId: string;
	temporalRunId: string | null;
	namespace: string;
	historyLength: number | null;
	events: TemporalHistoryEventSummary[];
	counts: {
		workflowEvents: number;
		activityEvents: number;
		timerEvents: number;
		childWorkflowEvents: number;
		updateEvents: number;
		signalEvents: number;
		continueAsNewEvents: number;
		retryEvents: number;
	};
	unavailableReason?: string;
};

type RawTemporalHistory = {
	events?: RawTemporalEvent[];
};

type RawTemporalEvent = {
	eventId?: string | number | { toString(): string };
	eventType?: string | number;
	eventTime?: Date | string | { seconds?: string | number; nanos?: number };
	[key: string]: unknown;
};

export async function readTemporalHistorySummary(input: {
	workflowId: string;
	temporalRunId?: string | null;
	fallback: TemporalHistorySummary;
}): Promise<TemporalHistorySummary> {
	if (process.env.VITEST || process.env.STARDUST_SKIP_TEMPORAL_HISTORY === '1') {
		return {
			...input.fallback,
			unavailableReason: 'Temporal history fetch skipped in this process'
		};
	}

	let connection: Connection | null = null;
	try {
		connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
		const client = new Client({ connection, namespace: TEMPORAL_NAMESPACE });
		const handle = client.workflow.getHandle(input.workflowId, input.temporalRunId ?? undefined);
		const history = (await handle.fetchHistory()) as RawTemporalHistory;
		const events = (history.events ?? []).map(mapTemporalHistoryEvent);
		return {
			available: true,
			source: 'temporal',
			workflowId: input.workflowId,
			temporalRunId: input.temporalRunId ?? null,
			namespace: TEMPORAL_NAMESPACE,
			historyLength: events.length,
			events,
			counts: countHistoryEvents(events)
		};
	} catch (error) {
		return {
			...input.fallback,
			unavailableReason: error instanceof Error ? error.message : 'Temporal history unavailable'
		};
	} finally {
		await connection?.close().catch(() => undefined);
	}
}

export function buildSqliteTemporalHistorySummary(input: {
	workflowId: string;
	temporalRunId?: string | null;
	events: TemporalHistoryEventSummary[];
	historyLength?: number | null;
	unavailableReason?: string;
}): TemporalHistorySummary {
	return {
		available: false,
		source: 'sqlite',
		workflowId: input.workflowId,
		temporalRunId: input.temporalRunId ?? null,
		namespace: TEMPORAL_NAMESPACE,
		historyLength: input.historyLength ?? input.events.length,
		events: input.events,
		counts: countHistoryEvents(input.events),
		unavailableReason: input.unavailableReason
	};
}

export function countHistoryEvents(
	events: TemporalHistoryEventSummary[]
): TemporalHistorySummary['counts'] {
	return {
		workflowEvents: events.filter((event) => event.concept === 'workflow').length,
		activityEvents: events.filter((event) => event.concept === 'activity').length,
		timerEvents: events.filter((event) => event.concept === 'timer').length,
		childWorkflowEvents: events.filter((event) => event.concept === 'child-workflow').length,
		updateEvents: events.filter((event) => event.concept === 'update').length,
		signalEvents: events.filter((event) => event.concept === 'signal').length,
		continueAsNewEvents: events.filter((event) => event.concept === 'continue-as-new').length,
		retryEvents: events.filter((event) => event.concept === 'retry').length
	};
}

export function mapTemporalHistoryEvent(event: RawTemporalEvent): TemporalHistoryEventSummary {
	const eventType = normalizeEventType(event.eventType);
	const concept = conceptForTemporalEvent(eventType);
	const label = labelForTemporalEvent(eventType);
	const attributes = firstAttributeRecord(event);
	return {
		eventId: event.eventId?.toString() ?? 'unknown',
		eventType,
		concept,
		label,
		timestamp: formatTemporalTimestamp(event.eventTime),
		attempt: numberAttribute(attributes, 'attempt'),
		activityType: nestedName(attributes, 'activityType'),
		taskQueue: nestedName(attributes, 'taskQueue') ?? stringAttribute(attributes, 'taskQueue'),
		workflowId:
			stringAttribute(attributes, 'workflowId') ??
			nestedExecutionAttribute(attributes, 'workflowExecution', 'workflowId'),
		runId:
			stringAttribute(attributes, 'runId') ??
			nestedExecutionAttribute(attributes, 'workflowExecution', 'runId')
	};
}

function conceptForTemporalEvent(eventType: string): TemporalPrimitive {
	if (eventType.includes('CONTINUED_AS_NEW')) return 'continue-as-new';
	if (eventType.includes('CHILD_WORKFLOW_EXECUTION')) return 'child-workflow';
	if (eventType.includes('ACTIVITY_TASK')) {
		return eventType.includes('FAILED') || eventType.includes('TIMED_OUT') ? 'retry' : 'activity';
	}
	if (eventType.includes('TIMER')) return 'timer';
	if (eventType.includes('WORKFLOW_EXECUTION_UPDATE')) return 'update';
	if (eventType.includes('SIGNAL')) return 'signal';
	if (eventType.includes('WORKFLOW_EXECUTION')) return 'workflow';
	return 'workflow';
}

function labelForTemporalEvent(eventType: string): string {
	const labels: Record<string, string> = {
		EVENT_TYPE_WORKFLOW_EXECUTION_STARTED: 'Workflow started',
		EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED: 'Workflow completed',
		EVENT_TYPE_WORKFLOW_EXECUTION_FAILED: 'Workflow failed',
		EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED: 'Workflow cancelled',
		EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW: 'Workflow continued as new',
		EVENT_TYPE_ACTIVITY_TASK_SCHEDULED: 'Activity scheduled',
		EVENT_TYPE_ACTIVITY_TASK_STARTED: 'Activity started',
		EVENT_TYPE_ACTIVITY_TASK_COMPLETED: 'Activity completed',
		EVENT_TYPE_ACTIVITY_TASK_FAILED: 'Activity failed',
		EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT: 'Activity timed out',
		EVENT_TYPE_TIMER_STARTED: 'Timer started',
		EVENT_TYPE_TIMER_FIRED: 'Timer fired',
		EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED: 'Child workflow scheduled',
		EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_STARTED: 'Child workflow started',
		EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED: 'Child workflow completed',
		EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED: 'Update accepted',
		EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_COMPLETED: 'Update completed',
		EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED: 'Signal received'
	};
	return (
		labels[eventType] ??
		eventType
			.replace(/^EVENT_TYPE_/, '')
			.toLowerCase()
			.replace(/_/g, ' ')
	);
}

function normalizeEventType(value: string | number | undefined): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return `EVENT_TYPE_${value}`;
	return 'EVENT_TYPE_UNSPECIFIED';
}

function formatTemporalTimestamp(value: RawTemporalEvent['eventTime']): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') return value;
	const seconds = Number(value.seconds ?? 0);
	const nanos = Number(value.nanos ?? 0);
	if (!seconds) return null;
	return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

function firstAttributeRecord(event: RawTemporalEvent): Record<string, unknown> {
	const entry = Object.entries(event).find(
		([key, value]) => key.endsWith('EventAttributes') && isRecord(value)
	);
	return entry && isRecord(entry[1]) ? entry[1] : {};
}

function numberAttribute(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === 'number' ? value : undefined;
}

function stringAttribute(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

function nestedName(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (isRecord(value) && typeof value.name === 'string') return value.name;
	return undefined;
}

function nestedExecutionAttribute(
	record: Record<string, unknown>,
	key: string,
	attribute: 'workflowId' | 'runId'
): string | undefined {
	const value = record[key];
	if (isRecord(value) && typeof value[attribute] === 'string') return value[attribute];
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
