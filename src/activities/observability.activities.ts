import { eq } from 'drizzle-orm';
import { db } from '../lib/server/db/client';
import { runs, sessions } from '../lib/server/db/schema';
import type { ModelUsage, SubagentKind } from '../lib/types';
import { appendTranscriptEvent, publishStreamEvent } from '../lib/server/stream';

type RunCompletionStatus = 'complete' | 'failed' | 'cancelled';

export async function recordRunStarted(input: {
	sessionId: string;
	runId: string;
	message: string;
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
			input: JSON.stringify({ message: input.message }),
			startedAt: now,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: runs.id,
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
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'subagent.start',
		payload: JSON.stringify({
			subagentRunId: input.subagentRunId,
			kind: input.kind,
			label: input.label,
			startedAt: now
		}),
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
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'subagent.complete',
		payload: JSON.stringify({
			subagentRunId: input.subagentRunId,
			kind: input.kind,
			label: input.label,
			status: input.status,
			budget: input.budget ?? null,
			completedAt: now
		}),
		createdAt: now
	});
}

export async function recordRunCompleted(input: {
	sessionId: string;
	runId: string;
	status: RunCompletionStatus;
	finalAnswer: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(runs)
		.set({
			status: input.status,
			finalAnswer: input.finalAnswer,
			completedAt: now,
			updatedAt: now
		})
		.where(eq(runs.id, input.runId));
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
	await appendTranscriptEvent(db, {
		id: `${input.runId}:completed`,
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: input.status, recoverySafe: true }),
		createdAt: now
	}).catch((error: unknown) => {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE')) throw error;
	});
	await publishStreamEvent(db, {
		sessionId: input.sessionId,
		runId: input.runId,
		kind: 'lifecycle',
		payload: JSON.stringify({ status: input.status }),
		createdAt: now
	});
}
