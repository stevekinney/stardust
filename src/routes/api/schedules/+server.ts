import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { inArray } from 'drizzle-orm';
import { db } from '$lib/server/db/client';
import { runs } from '$lib/server/db/schema';
import { TEMPORAL_NAMESPACE, TEMPORAL_WEB_URL } from '$lib/server/config';
import { createTemporalSchedule, reconcileTemporalSchedules } from '$lib/server/schedules';
import type { ModelUsage, ScheduleProjection } from '$lib/types';

/**
 * Join each fire event's accepted run back to the runs table so schedule rows
 * can show real duration and cost per fire. One batched query; fires without
 * a finished run keep null enrichment.
 */
async function enrichFireEventsWithRuns(
	schedules: ScheduleProjection[]
): Promise<ScheduleProjection[]> {
	const runIds = schedules.flatMap((schedule) =>
		schedule.fireEvents.map((fire) => fire.acceptedRunId).filter((id): id is string => id !== null)
	);
	const runRows =
		runIds.length === 0
			? []
			: await db
					.select({
						id: runs.id,
						startedAt: runs.startedAt,
						completedAt: runs.completedAt,
						usage: runs.usage
					})
					.from(runs)
					.where(inArray(runs.id, runIds));
	const runsById = new Map(runRows.map((row) => [row.id, row]));

	return schedules.map((schedule) => ({
		...schedule,
		temporalWebUrl: `${TEMPORAL_WEB_URL}/namespaces/${TEMPORAL_NAMESPACE}/schedules/${encodeURIComponent(schedule.temporalScheduleId)}`,
		fireEvents: schedule.fireEvents.map((fire) => {
			const run = fire.acceptedRunId ? runsById.get(fire.acceptedRunId) : undefined;
			if (!run) return fire;
			const durationMs =
				run.startedAt && run.completedAt
					? new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()
					: null;
			let costUsd: number | null = null;
			if (run.usage) {
				try {
					costUsd = (JSON.parse(run.usage) as ModelUsage).estimatedCostUsd ?? null;
				} catch {
					costUsd = null;
				}
			}
			return { ...fire, runDurationMs: durationMs, runCostUsd: costUsd };
		})
	}));
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === 'string' ? value.trim() : '';
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'JSON body is required');

	const name = readRequiredString(body, 'name');
	const cronExpression = readRequiredString(body, 'cronExpression');
	const prompt = readRequiredString(body, 'prompt');
	const description = readRequiredString(body, 'description');

	if (!name) throw error(400, 'name is required');
	if (!cronExpression) throw error(400, 'cronExpression is required');
	if (!prompt) throw error(400, 'prompt is required');

	const schedule = await createTemporalSchedule({
		name,
		cronExpression,
		prompt,
		description: description || undefined
	});

	return json({ schedule }, { status: 201 });
};

export const GET: RequestHandler = async () => {
	const schedules = await reconcileTemporalSchedules();
	return json({ schedules: await enrichFireEventsWithRuns(schedules) });
};
