import type { Client } from '@temporalio/client';
import type {
	CreateScheduleInput,
	DeleteScheduleResult,
	ScheduleProjection,
	TriggerScheduleResult
} from '@src/lib/types';
import type { ScheduleDescription } from '@temporalio/client';
import { ScheduleOverlapPolicy } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';
import { getTemporalClient } from './client';
import { scheduledAgentWorkflow } from '@src/workflows/scheduled-agent.workflow';
import { db } from '../db';
import { SchedulesProjectionRepository } from '../schedules/projection';

const SCHEDULE_ID_RE = /^[\w-]{1,128}$/;

function createScheduleId(): string {
	return `schedule-${randomUUID()}`;
}

function assertScheduleId(scheduleId: string): void {
	if (!SCHEDULE_ID_RE.test(scheduleId)) {
		throw new Error('Invalid schedule id');
	}
}

type ScheduleClientDependencies = {
	temporalClient?: Pick<Client, 'schedule'>;
	schedulesRepository?: SchedulesProjectionRepository;
	createScheduleId?: () => string;
};

export async function createTemporalSchedule(
	input: CreateScheduleInput,
	dependencies: ScheduleClientDependencies = {}
): Promise<ScheduleProjection> {
	const scheduleId = dependencies.createScheduleId?.() ?? createScheduleId();
	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);

	const handle = await client.schedule.create({
		scheduleId,
		spec: { cronExpressions: [input.cronExpression] },
		action: {
			type: 'startWorkflow',
			workflowType: scheduledAgentWorkflow,
			workflowId: `scheduled-agent:${scheduleId}`,
			taskQueue: TASK_QUEUE_ORCHESTRATOR,
			args: [{ scheduleId, prompt: input.prompt }]
		},
		policies: {
			overlap: ScheduleOverlapPolicy.BUFFER_ONE
		},
		memo: {
			name: input.name,
			description: input.description ?? null,
			cronExpression: input.cronExpression,
			prompt: input.prompt
		}
	});

	const description = await handle.describe();
	return repository.upsert({
		...input,
		scheduleId,
		descriptionFromTemporal: description
	});
}

export async function triggerTemporalSchedule(
	scheduleId: string,
	dependencies: ScheduleClientDependencies = {}
): Promise<TriggerScheduleResult> {
	assertScheduleId(scheduleId);

	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);
	const existing = await repository.findByScheduleId(scheduleId);
	if (!existing) {
		throw new Error('Schedule not found');
	}

	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const handle = client.schedule.getHandle(scheduleId);
	await handle.trigger(ScheduleOverlapPolicy.BUFFER_ONE);
	const description = await handle.describe();
	const schedule = await repository.refreshFromTemporal(scheduleId, description);

	return {
		schedule,
		targetSessionKey: schedule.targetSessionKey
	};
}

export async function pauseTemporalSchedule(
	scheduleId: string,
	dependencies: ScheduleClientDependencies = {}
): Promise<ScheduleProjection> {
	assertScheduleId(scheduleId);
	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);
	await assertProjectionExists(repository, scheduleId);

	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const handle = client.schedule.getHandle(scheduleId);
	await handle.pause('Paused from Stardust schedule manager');
	const description = await handle.describe();
	return repository.refreshFromTemporal(scheduleId, description);
}

export async function resumeTemporalSchedule(
	scheduleId: string,
	dependencies: ScheduleClientDependencies = {}
): Promise<ScheduleProjection> {
	assertScheduleId(scheduleId);
	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);
	await assertProjectionExists(repository, scheduleId);

	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const handle = client.schedule.getHandle(scheduleId);
	await handle.unpause('Resumed from Stardust schedule manager');
	const description = await handle.describe();
	return repository.refreshFromTemporal(scheduleId, description);
}

export async function deleteTemporalSchedule(
	scheduleId: string,
	dependencies: ScheduleClientDependencies = {}
): Promise<DeleteScheduleResult> {
	assertScheduleId(scheduleId);
	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);
	await assertProjectionExists(repository, scheduleId);

	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const handle = client.schedule.getHandle(scheduleId);
	await handle.delete();
	await repository.deleteByScheduleId(scheduleId);
	return { scheduleId, deleted: true };
}

export async function reconcileTemporalSchedules(
	dependencies: ScheduleClientDependencies = {}
): Promise<ScheduleProjection[]> {
	const client = dependencies.temporalClient ?? (await getTemporalClient());
	const repository = dependencies.schedulesRepository ?? new SchedulesProjectionRepository(db);
	const temporalScheduleIds = new Set<string>();
	const reconciledSchedules: ScheduleProjection[] = [];

	for await (const schedule of client.schedule.list()) {
		assertScheduleId(schedule.scheduleId);
		const handle = client.schedule.getHandle(schedule.scheduleId);
		const description = await handle.describe();
		if (!isStardustSchedule(description)) continue;

		temporalScheduleIds.add(schedule.scheduleId);
		const existing = await repository.findByScheduleId(schedule.scheduleId);
		reconciledSchedules.push(
			await repository.upsertFromTemporal(description, existing ?? undefined)
		);
	}

	for (const localSchedule of await repository.list()) {
		if (!temporalScheduleIds.has(localSchedule.temporalScheduleId)) {
			await repository.deleteByScheduleId(localSchedule.temporalScheduleId);
		}
	}

	return reconciledSchedules;
}

async function assertProjectionExists(
	repository: SchedulesProjectionRepository,
	scheduleId: string
): Promise<void> {
	const existing = await repository.findByScheduleId(scheduleId);
	if (!existing) throw new Error('Schedule not found');
}

function isStardustSchedule(description: ScheduleDescription): boolean {
	return (
		description.action.type === 'startWorkflow' &&
		typeof description.action.workflowId === 'string' &&
		description.action.workflowId.startsWith('scheduled-agent:') &&
		typeof description.memo?.prompt === 'string' &&
		typeof description.memo?.cronExpression === 'string'
	);
}
