import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { gte } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { runs } from '$lib/server/db/schema';
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_WEB_URL } from '$lib/server/config';
import { getTemporalClient } from '$lib/server/temporal/client';
import {
	TASK_QUEUE_MEMORY,
	TASK_QUEUE_MODEL,
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_TOOLS
} from '$lib/server/temporal/task-queues';
import type { HealthSnapshot, ModelUsage } from '$lib/types';

const KNOWN_TASK_QUEUES = [
	TASK_QUEUE_ORCHESTRATOR,
	TASK_QUEUE_MODEL,
	TASK_QUEUE_TOOLS,
	TASK_QUEUE_SANDBOX,
	TASK_QUEUE_MEMORY
];

/** Workflow task-queue type in the Temporal API's TaskQueueType enum. */
const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;

type QueuePoll = { name: string; pollerIdentities: string[] };

async function describeQueues(): Promise<QueuePoll[] | null> {
	try {
		const client = await getTemporalClient();
		return await Promise.all(
			KNOWN_TASK_QUEUES.map(async (name) => {
				const identities = new Set<string>();
				for (const taskQueueType of [TASK_QUEUE_TYPE_WORKFLOW, TASK_QUEUE_TYPE_ACTIVITY]) {
					const response = await client.workflowService.describeTaskQueue({
						namespace: TEMPORAL_NAMESPACE,
						taskQueue: { name },
						taskQueueType
					});
					for (const poller of response.pollers ?? []) {
						if (poller.identity) identities.add(poller.identity);
					}
				}
				return { name, pollerIdentities: [...identities] };
			})
		);
	} catch {
		return null;
	}
}

async function spendToday(): Promise<{ spendUsd: number; tokens: number }> {
	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const rows = await db
		.select({ usage: runs.usage })
		.from(runs)
		.where(gte(runs.createdAt, startOfToday.toISOString()));

	let spendUsd = 0;
	let tokens = 0;
	for (const row of rows) {
		if (!row.usage) continue;
		try {
			const usage = JSON.parse(row.usage) as ModelUsage;
			spendUsd += usage.estimatedCostUsd;
			tokens += usage.inputTokens + usage.outputTokens;
		} catch {
			// ignore malformed usage
		}
	}
	return { spendUsd, tokens };
}

/**
 * Infrastructure health for the header cluster: Temporal reachability, worker
 * pollers per known task queue, and today's spend. Read-only.
 */
export const GET: RequestHandler = async () => {
	const [queues, spend] = await Promise.all([describeQueues(), spendToday()]);

	const workerIdentities = new Set<string>();
	for (const queue of queues ?? []) {
		for (const identity of queue.pollerIdentities) workerIdentities.add(identity);
	}

	const snapshot: HealthSnapshot = {
		address: TEMPORAL_ADDRESS,
		namespace: TEMPORAL_NAMESPACE,
		reachable: queues !== null,
		workerCount: queues === null ? null : workerIdentities.size,
		taskQueues:
			queues === null
				? []
				: queues.map((queue) => ({ name: queue.name, healthy: queue.pollerIdentities.length > 0 })),
		spendTodayUsd: spend.spendUsd,
		tokensToday: spend.tokens,
		temporalWebUrl: TEMPORAL_WEB_URL
	};

	return json(snapshot);
};
