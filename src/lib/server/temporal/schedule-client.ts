import type { Client } from '@temporalio/client';
import type {
	CreateScheduleInput,
	ScheduleProjection,
	TriggerScheduleResult
} from '@src/lib/types';
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
