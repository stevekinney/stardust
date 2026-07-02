import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import {
	approvalRequests,
	runs,
	scheduleFireEvents,
	sessions,
	transcriptEvents
} from '$lib/server/db/schema';
import type { InsightsSummary, ModelUsage } from '$lib/types';

function parseUsage(raw: string | null): ModelUsage | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ModelUsage;
	} catch {
		return null;
	}
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Failed-then-healed activity attempts, counted the same way the run
 * inspector's durability evidence does: multiple tool_result rows sharing a
 * callId mean Temporal retried the activity.
 */
function countRetries(resultRows: Array<{ payload: string }>): number {
	const resultsByCallId = new Map<string, number>();
	for (const row of resultRows) {
		try {
			const payload = JSON.parse(row.payload) as { callId?: string };
			if (!payload.callId) continue;
			resultsByCallId.set(payload.callId, (resultsByCallId.get(payload.callId) ?? 0) + 1);
		} catch {
			// ignore malformed payloads
		}
	}
	let retries = 0;
	for (const count of resultsByCallId.values()) {
		retries += Math.max(0, count - 1);
	}
	return retries;
}

/** Read-only aggregates over today's runs, approvals, and schedule fires. */
export const GET: RequestHandler = async () => {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const since = startOfToday.toISOString();

	const [runRows, approvalRows, fireRows, resultRows] = await Promise.all([
		db
			.select({
				id: runs.id,
				sessionId: runs.sessionId,
				usage: runs.usage,
				sessionKey: sessions.sessionKey,
				sessionName: sessions.name
			})
			.from(runs)
			.leftJoin(sessions, eq(runs.sessionId, sessions.id))
			.where(gte(runs.createdAt, since)),
		db
			.select({
				createdAt: approvalRequests.createdAt,
				resolvedAt: approvalRequests.resolvedAt
			})
			.from(approvalRequests)
			.where(and(gte(approvalRequests.createdAt, since), isNotNull(approvalRequests.resolvedAt))),
		db
			.select({ id: scheduleFireEvents.id })
			.from(scheduleFireEvents)
			.where(gte(scheduleFireEvents.actualTriggerTime, since)),
		db
			.select({ payload: transcriptEvents.payload })
			.from(transcriptEvents)
			.where(and(eq(transcriptEvents.kind, 'tool_result'), gte(transcriptEvents.createdAt, since)))
	]);

	let spendTodayUsd = 0;
	let tokensToday = 0;
	const spendBySessionKey = new Map<
		string,
		{ sessionKey: string | null; title: string; costUsd: number }
	>();
	const sessionIds = new Set<string>();

	for (const run of runRows) {
		sessionIds.add(run.sessionId);
		const usage = parseUsage(run.usage);
		if (!usage) continue;
		spendTodayUsd += usage.estimatedCostUsd;
		tokensToday += usage.inputTokens + usage.outputTokens;

		const key = run.sessionKey ?? run.sessionId;
		const existing = spendBySessionKey.get(key);
		if (existing) {
			existing.costUsd += usage.estimatedCostUsd;
		} else {
			spendBySessionKey.set(key, {
				sessionKey: run.sessionKey,
				title: run.sessionName ?? run.sessionKey ?? run.sessionId,
				costUsd: usage.estimatedCostUsd
			});
		}
	}

	const waits = approvalRows
		.filter((row) => row.resolvedAt !== null)
		.map((row) => new Date(row.resolvedAt as string).getTime() - new Date(row.createdAt).getTime())
		.filter((ms) => ms >= 0);

	const summary: InsightsSummary = {
		spendTodayUsd,
		tokensToday,
		runsToday: runRows.length,
		sessionsToday: sessionIds.size,
		retriesAutoHealed: countRetries(resultRows),
		approvalsResolvedToday: approvalRows.length,
		approvalMedianWaitMs: median(waits),
		scheduleFiresToday: fireRows.length,
		spendBySession: [...spendBySessionKey.values()].sort((a, b) => b.costUsd - a.costUsd)
	};

	return json(summary);
};
