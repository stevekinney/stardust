import type { ScheduleDescription } from '@temporalio/client';
import { desc, eq } from 'drizzle-orm';
import type {
	CreateScheduleInput,
	ScheduleFireProjection,
	ScheduleProjection
} from '@src/lib/types';
import type { DatabaseClient } from '../db';
import { scheduleFireEvents, schedules } from '../db';
import { getScheduledSessionKey } from '../temporal/scheduled-turn';

type ScheduleRow = typeof schedules.$inferSelect;
type ScheduleFireRow = typeof scheduleFireEvents.$inferSelect;

export type UpsertScheduleProjectionInput = CreateScheduleInput & {
	scheduleId: string;
	descriptionFromTemporal?: ScheduleDescription;
};

function toScheduleFireProjection(row: ScheduleFireRow): ScheduleFireProjection {
	return {
		id: row.id,
		scheduleId: row.scheduleId,
		triggerSource: row.triggerSource,
		scheduledTime: row.scheduledTime,
		actualTriggerTime: row.actualTriggerTime,
		overlapPolicy: row.overlapPolicy,
		scheduledWorkflowId: row.scheduledWorkflowId,
		scheduledTemporalRunId: row.scheduledTemporalRunId,
		targetSessionKey: row.targetSessionKey,
		acceptedRunId: row.acceptedRunId,
		status: row.status,
		error: row.error
	};
}

function toScheduleProjection(
	row: ScheduleRow,
	fireRows: ScheduleFireRow[] = []
): ScheduleProjection {
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
		fireEvents: fireRows.map(toScheduleFireProjection),
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

	async list(): Promise<ScheduleProjection[]> {
		const rows = await this.database.select().from(schedules);
		const fireRows = await this.database
			.select()
			.from(scheduleFireEvents)
			.orderBy(desc(scheduleFireEvents.actualTriggerTime));
		const byScheduleId = new Map<string, ScheduleFireRow[]>();
		for (const fireRow of fireRows) {
			const existing = byScheduleId.get(fireRow.scheduleId) ?? [];
			if (existing.length < 10) existing.push(fireRow);
			byScheduleId.set(fireRow.scheduleId, existing);
		}
		return rows.map((row) =>
			toScheduleProjection(row, byScheduleId.get(row.temporalScheduleId) ?? [])
		);
	}

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

		return this.upsertFromTemporal(description, existing);
	}

	async upsertFromTemporal(
		description: ScheduleDescription,
		fallback?: ScheduleProjection
	): Promise<ScheduleProjection> {
		const scheduleId = description.scheduleId;
		return this.upsert({
			scheduleId,
			name: memoString(description.memo, 'name') ?? fallback?.name ?? scheduleId,
			description:
				memoString(description.memo, 'description') ?? fallback?.description ?? undefined,
			cronExpression:
				memoString(description.memo, 'cronExpression') ?? fallback?.cronExpression ?? '',
			prompt: memoString(description.memo, 'prompt') ?? fallback?.prompt ?? '',
			descriptionFromTemporal: description
		});
	}

	async findByScheduleId(scheduleId: string): Promise<ScheduleProjection | null> {
		const rows = await this.database
			.select()
			.from(schedules)
			.where(eq(schedules.temporalScheduleId, scheduleId))
			.limit(1);
		if (!rows[0]) return null;
		const fireRows = await this.database
			.select()
			.from(scheduleFireEvents)
			.where(eq(scheduleFireEvents.scheduleId, scheduleId))
			.orderBy(desc(scheduleFireEvents.actualTriggerTime))
			.limit(10);
		return toScheduleProjection(rows[0], fireRows);
	}

	async deleteByScheduleId(scheduleId: string): Promise<void> {
		await this.database.delete(schedules).where(eq(schedules.temporalScheduleId, scheduleId));
	}
}

function memoString(memo: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = memo?.[key];
	return typeof value === 'string' && value.trim() ? value : undefined;
}
