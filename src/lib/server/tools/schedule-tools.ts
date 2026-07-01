import { z } from 'zod';
import type { RegisteredTool } from '../policy/policy-engine';
import { LOW_RISK_TOOL, SCHEDULE_CREATE_TOOL } from '../policy/risk';
import { createTemporalSchedule, reconcileTemporalSchedules } from '../temporal/schedule-client';
import { defineStardustTool } from './define-tool';

/**
 * Dependencies accepted by `executeScheduleCreate`, lifted structurally from
 * `createTemporalSchedule`'s own dependency parameter (not exported by
 * `schedule-client.ts`) so tests can inject a mocked Temporal client and
 * schedules repository without a live server.
 */
type ScheduleCreateDependencies = NonNullable<Parameters<typeof createTemporalSchedule>[1]>;

/** Dependencies accepted by `executeScheduleList`, lifted the same way. */
type ScheduleListDependencies = NonNullable<Parameters<typeof reconcileTemporalSchedules>[0]>;

/** Matches a single cron field: digits, `*`, ranges, steps, lists, or names (e.g. `MON`, `JAN`). */
const CRON_FIELD_PATTERN = /^[A-Za-z0-9*/,-]+$/;

/** Returns true when `value` is a standard 5-field cron expression. */
function isFiveFieldCronExpression(value: string): boolean {
	const fields = value.trim().split(/\s+/);
	return fields.length === 5 && fields.every((field) => CRON_FIELD_PATTERN.test(field));
}

/** Input schema for `schedule.create`. */
export const scheduleCreateInput = z.object({
	name: z.string().min(1),
	description: z.string().min(1).optional(),
	cronExpression: z.string().min(1).refine(isFiveFieldCronExpression, {
		message: 'cronExpression must be a 5-field cron expression (minute hour day month weekday)'
	}),
	prompt: z.string().min(1)
});

export type ScheduleCreateInput = z.infer<typeof scheduleCreateInput>;

/** Input schema for `schedule.list` — no arguments. */
export const scheduleListInput = z.object({});

export type ScheduleListInput = z.infer<typeof scheduleListInput>;

export type ScheduleCreateResult = {
	scheduleId: string;
	name: string;
	cronExpression: string;
};

export type ScheduleListEntry = {
	scheduleId: string;
	name: string;
	cronExpression: string;
	prompt: string;
	paused: boolean;
};

/**
 * Executes `schedule.create` by delegating to `createTemporalSchedule` — the
 * same code path used by `POST /api/schedules`. `dependencies` is threaded
 * straight through so callers (and tests) can supply a mocked Temporal client
 * and schedules repository instead of a live server.
 */
export async function executeScheduleCreate(
	input: ScheduleCreateInput,
	dependencies: ScheduleCreateDependencies = {}
): Promise<ScheduleCreateResult> {
	const schedule = await createTemporalSchedule(
		{
			name: input.name,
			cronExpression: input.cronExpression,
			prompt: input.prompt,
			...(input.description !== undefined ? { description: input.description } : {})
		},
		dependencies
	);
	return {
		scheduleId: schedule.temporalScheduleId,
		name: schedule.name,
		cronExpression: schedule.cronExpression
	};
}

/**
 * Executes `schedule.list` by reconciling Temporal's live Schedule list with
 * the local projection — the same code path used by `GET /api/schedules`.
 * Returns a compact projection instead of the full `ScheduleProjection` shape.
 */
export async function executeScheduleList(
	dependencies: ScheduleListDependencies = {}
): Promise<ScheduleListEntry[]> {
	const schedules = await reconcileTemporalSchedules(dependencies);
	return schedules.map((schedule) => ({
		scheduleId: schedule.temporalScheduleId,
		name: schedule.name,
		cronExpression: schedule.cronExpression,
		prompt: schedule.prompt,
		paused: schedule.status === 'paused'
	}));
}

/** Registers `schedule.create` and `schedule.list`. */
export function defineScheduleTools(): RegisteredTool[] {
	return [
		defineStardustTool({
			name: 'schedule.create',
			description:
				'Create a standing Temporal Schedule that runs a prompt on a 5-field cron expression. Requires approval.',
			schema: scheduleCreateInput,
			metadata: SCHEDULE_CREATE_TOOL
		}),
		defineStardustTool({
			name: 'schedule.list',
			description: 'List standing Temporal Schedules with their cron expressions and prompts.',
			schema: scheduleListInput,
			metadata: LOW_RISK_TOOL
		})
	];
}
