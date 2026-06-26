import { eq } from 'drizzle-orm';
import type { ToolExecutionResult } from '@src/lib/types';
import type { DatabaseClient } from '../db/client';
import { idempotencyLedger } from '../db/schema';

type IdempotentExecutionInput = {
	database: DatabaseClient;
	idempotencyKey: string;
	runId: string;
	toolCallId: string;
	execute: () => Promise<ToolExecutionResult>;
};

function replayedResult(input: {
	idempotencyKey: string;
	toolCallId: string;
	resultRef: string | null;
}): ToolExecutionResult {
	return {
		callId: input.toolCallId,
		toolName: 'idempotency.replay',
		outcome: 'success',
		content: {
			idempotencyKey: input.idempotencyKey,
			resultRef: input.resultRef,
			replayed: true
		},
		metadata: {
			idempotencyKey: input.idempotencyKey,
			idempotencyReplayed: true
		}
	};
}

export async function executeWithIdempotency(
	input: IdempotentExecutionInput
): Promise<ToolExecutionResult> {
	const existingRows = await input.database
		.select()
		.from(idempotencyLedger)
		.where(eq(idempotencyLedger.idempotencyKey, input.idempotencyKey))
		.limit(1);
	const existing = existingRows[0];
	if (existing) {
		return replayedResult({
			idempotencyKey: input.idempotencyKey,
			toolCallId: input.toolCallId,
			resultRef: existing.resultRef
		});
	}

	const now = new Date().toISOString();
	await input.database.insert(idempotencyLedger).values({
		id: `${input.runId}:${input.toolCallId}:idempotency`,
		idempotencyKey: input.idempotencyKey,
		runId: input.runId,
		toolCallId: input.toolCallId,
		status: 'pending',
		createdAt: now
	});

	const result = await input.execute();
	const completedAt = new Date().toISOString();
	await input.database
		.update(idempotencyLedger)
		.set({
			status: result.outcome === 'success' ? 'complete' : 'failed',
			resultRef: JSON.stringify(result.content),
			completedAt
		})
		.where(eq(idempotencyLedger.idempotencyKey, input.idempotencyKey));

	return {
		...result,
		metadata: {
			...result.metadata,
			idempotencyKey: input.idempotencyKey,
			idempotencyReplayed: false
		}
	};
}
