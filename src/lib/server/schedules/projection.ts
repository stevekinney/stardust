import type { ScheduleDescription } from '@temporalio/client';
import { eq } from 'drizzle-orm';
import type { CreateScheduleInput, ScheduleProjection } from '@src/lib/types';
import type { DatabaseClient } from '../db';
import { schedules } from '../db';
import { getScheduledSessionKey } from '../temporal/scheduled-turn';

type ScheduleRow = typeof schedules.$inferSelect;

export type UpsertScheduleProjectionInput = CreateScheduleInput & {
	scheduleId: string;
	descriptionFromTemporal?: ScheduleDescription;
};

function toScheduleProjection(row: ScheduleRow): ScheduleProjection {
	return {
		id: row.id,
		temporalScheduleId: row.temporalScheduleId,
		targetSessionKey: row.targetSessionKey,
		name: row.name,
		description: row.description,
		cronExpression: row.cronExpression,
		prompt: row.prompt,
		status: row.status,
		lastRunAt: row.lastRunAt,
		nextRunAt: row.nextRunAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

function isoDate(value: Date | undefined): string | null {
	return value ? value.toISOString() : null;
}

function statusFromTemporal(
	description: ScheduleDescription | undefined
): ScheduleProjection['status'] {
	return description?.state.paused ? 'paused' : 'active';
}

export class SchedulesProjectionRepository {
	constructor(private readonly database: DatabaseClient) {}

	async upsert(input: UpsertScheduleProjectionInput): Promise<ScheduleProjection> {
		const now = new Date().toISOString();
		const lastRunAt = isoDate(input.descriptionFromTemporal?.info.recentActions.at(-1)?.takenAt);
		const nextRunAt = isoDate(input.descriptionFromTemporal?.info.nextActionTimes[0]);
		const status = statusFromTemporal(input.descriptionFromTemporal);

		await this.database
			.insert(schedules)
			.values({
				id: input.scheduleId,
				temporalScheduleId: input.scheduleId,
				targetSessionKey: getScheduledSessionKey(input.scheduleId),
				name: input.name,
				description: input.description ?? null,
				cronExpression: input.cronExpression,
				prompt: input.prompt,
				status,
				lastRunAt,
				nextRunAt,
				createdAt: now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: schedules.temporalScheduleId,
				set: {
					targetSessionKey: getScheduledSessionKey(input.scheduleId),
					name: input.name,
					description: input.description ?? null,
					cronExpression: input.cronExpression,
					prompt: input.prompt,
					status,
					lastRunAt,
					nextRunAt,
					updatedAt: now
				}
			});

		const projection = await this.findByScheduleId(input.scheduleId);
		if (!projection) throw new Error(`Schedule projection was not written: ${input.scheduleId}`);
		return projection;
	}

	async refreshFromTemporal(
		scheduleId: string,
		description: ScheduleDescription
	): Promise<ScheduleProjection> {
		const existing = await this.findByScheduleId(scheduleId);
		if (!existing) throw new Error(`Schedule projection is missing: ${scheduleId}`);

		return this.upsert({
			scheduleId,
			name: existing.name,
			description: existing.description ?? undefined,
			cronExpression: existing.cronExpression,
			prompt: existing.prompt,
			descriptionFromTemporal: description
		});
	}

	async findByScheduleId(scheduleId: string): Promise<ScheduleProjection | null> {
		const rows = await this.database
			.select()
			.from(schedules)
			.where(eq(schedules.temporalScheduleId, scheduleId))
			.limit(1);
		return rows[0] ? toScheduleProjection(rows[0]) : null;
	}
}
