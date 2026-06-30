import { eq } from 'drizzle-orm';
import { db } from '../lib/server/db/client';
import { runs, sessions, workflowExecutions } from '../lib/server/db/schema';
import type { ModelUsage, RunBudget, SubagentKind } from '../lib/types';
import {
	appendTranscriptEvent,
	persistToolResult as runPersistToolResult,
	publishStreamEvent,
	trimCompletedRunStream
} from '../lib/server/stream';
import { TASK_QUEUE_ORCHESTRATOR } from '../lib/server/temporal/task-queues';

type RunCompletionStatus = 'complete' | 'failed' | 'cancelled';

export async function recordRunStarted(input: {
	sessionId: string;
	runId: string;
	message: string;
	/** Resolved model ID (caller should supply the actual model, not the raw optional input). */
	model?: string;
	/** Budget caps snapshot to persist alongside the run start. */
	budget?: RunBudget;
}): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(sessions)
		.values({
			id: input.sessionId,
			sessionKey: input.sessionId,
			status: 'active',
			workflowId: `agent-session:${input.sessionId}`,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing();
	await db
		.insert(runs)
		.values({
			id: input.runId,
			sessionId: input.sessionId,
			workflowId: `agent-run:${input.runId}`,
			status: 'running',
			model: input.model ?? null,
			input: JSON.stringify({ message: input.message }),
			budget: input.budget != null ? JSON.stringify(input.budget) : null,
			startedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: runs.id,
			set: {
				status: 'running',
				model: input.model ?? null,
				budget: input.budget != null ? JSON.stringify(input.budget) : null,
				startedAt: now,
				updatedAt: now
			}
		});

	await db
		.insert(workflowExecutions)
		.values({
			id: `${input.runId}:workflow`,
			workflowId: `agent-run:${input.runId}`,
			workflowType: 'AgentRunWorkflow',
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			sessionId: input.sessionId,
			runId: input.runId,
			status: 'running',
			startedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: workflowExecutions.id,
			set: {
				status: 'running',
				startedAt: now,
				updatedAt: now
			}
		});

	await appendTranscriptEvent(db, {
		id: `${input.runId}:user-message`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'user_message',
		payload: JSON.stringify({ text: input.message }),
		createdAt: now
	}).catch((error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
	});
	await appendTranscriptEvent(db, {
		id: `${input.runId}:started`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: 'started', recoverySafe: true }),
		createdAt: now
	}).catch((error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
	});
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: 'started' }),
		deduplicationKey: 'lifecycle:started',
		createdAt: now
	});
}

export async function recordSubagentStarted(input: {
	sessionId: string;
	runId: string;
	subagentRunId: string;
	kind: SubagentKind;
	label: string;
}): Promise<void> {
	const now = new Date().toISOString();
	const workflowId = `agent-run:${input.runId}:${input.kind}`;
	const payload = {
		type: 'subagent.start',
		subagentRunId: input.subagentRunId,
		kind: input.kind,
		label: input.label,
		startedAt: now
	};
	await db
		.insert(workflowExecutions)
		.values({
			id: `${input.subagentRunId}:workflow`,
			workflowId,
			workflowType: `${input.kind}SubagentWorkflow`,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			parentWorkflowId: `agent-run:${input.runId}`,
			sessionId: input.sessionId,
			runId: input.runId,
			status: 'running',
			startedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: workflowExecutions.id,
			set: {
				status: 'running',
				startedAt: now,
				updatedAt: now
			}
		});
	await appendTranscriptEvent(db, {
		id: `${input.runId}:subagent:${input.subagentRunId}:started`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify(payload),
		createdAt: now
	});
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'subagent.start',
		deduplicationKey: `subagent:start:${input.subagentRunId}`,
		payload: JSON.stringify(payload),
		createdAt: now
	});
}

export async function recordSubagentCompleted(input: {
	sessionId: string;
	runId: string;
	subagentRunId: string;
	kind: SubagentKind;
	label: string;
	status: 'complete' | 'failed' | 'cancelled';
	budget?: ModelUsage;
}): Promise<void> {
	const now = new Date().toISOString();
	const payload = {
		type: 'subagent.complete',
		subagentRunId: input.subagentRunId,
		kind: input.kind,
		label: input.label,
		status: input.status,
		budget: input.budget ?? null,
		completedAt: now
	};
	await db
		.update(workflowExecutions)
		.set({
			status:
				input.status === 'complete'
					? 'completed'
					: input.status === 'failed'
						? 'failed'
						: 'cancelled',
			closedAt: now,
			updatedAt: now
		})
		.where(eq(workflowExecutions.id, `${input.subagentRunId}:workflow`));
	await appendTranscriptEvent(db, {
		id: `${input.runId}:subagent:${input.subagentRunId}:completed`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify(payload),
		createdAt: now
	});
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'subagent.complete',
		deduplicationKey: `subagent:complete:${input.subagentRunId}`,
		payload: JSON.stringify(payload),
		createdAt: now
	});
}

/**
 * Persists a tool execution result to both the canonical transcript and the
 * live stream bus. Called by the workflow after each tool execution so the
 * context builder can reconstruct tool result context for subsequent model calls.
 */
export async function persistToolResult(input: {
	sessionId: string;
	runId: string;
	callId: string;
	content: unknown;
	isError?: boolean;
}): Promise<void> {
	await runPersistToolResult(db, input);
}

export async function recordRunCompleted(input: {
	sessionId: string;
	runId: string;
	status: RunCompletionStatus;
	finalAnswer: string;
	/** Grand total token usage (parent model calls + reconciled subagent usage). */
	usage?: ModelUsage;
	/** Human-readable error message included in the lifecycle payload when status is 'failed'. */
	reason?: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(runs)
		.set({
			status: input.status,
			finalAnswer: input.finalAnswer,
			usage: input.usage != null ? JSON.stringify(input.usage) : null,
			completedAt: now,
			updatedAt: now
		})
		.where(eq(runs.id, input.runId));
	await db
		.update(workflowExecutions)
		.set({
			status:
				input.status === 'complete'
					? 'completed'
					: input.status === 'failed'
						? 'failed'
						: 'cancelled',
			closedAt: now,
			updatedAt: now
		})
		.where(eq(workflowExecutions.id, `${input.runId}:workflow`));
	await appendTranscriptEvent(db, {
		id: `${input.runId}:assistant-message`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'assistant_message',
		payload: JSON.stringify({ text: input.finalAnswer }),
		createdAt: now
	}).catch((error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
	});
	const transcriptLifecyclePayload: Record<string, unknown> = {
		status: input.status,
		recoverySafe: true
	};
	if (input.status === 'failed' && input.reason != null) {
		transcriptLifecyclePayload.reason = input.reason;
	}
	await appendTranscriptEvent(db, {
		id: `${input.runId}:completed`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify(transcriptLifecyclePayload),
		createdAt: now
	}).catch((error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
	});
	const streamLifecyclePayload: Record<string, unknown> = { status: input.status };
	if (input.status === 'failed' && input.reason != null) {
		streamLifecyclePayload.reason = input.reason;
	}
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify(streamLifecyclePayload),
		deduplicationKey: 'lifecycle:completed',
		createdAt: now
	});

	// Trim the live stream bus once the canonical transcript has been committed.
	// Only 'complete' runs are trimmed; failed/cancelled runs retain their events
	// for post-mortem inspection. The trim must run after the status update so
	// trimCompletedRunStream's guard passes.
	if (input.status === 'complete') {
		await trimCompletedRunStream(db, input.runId);
	}
}
