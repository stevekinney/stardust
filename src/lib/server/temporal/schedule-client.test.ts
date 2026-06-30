import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Client, ScheduleDescription } from '@temporalio/client';
import * as schema from '../db/schema';
import { SchedulesProjectionRepository } from '../schedules/projection';
import {
	createTemporalSchedule,
	deleteTemporalSchedule,
	pauseTemporalSchedule,
	reconcileTemporalSchedules,
	resumeTemporalSchedule,
	triggerTemporalSchedule
} from './schedule-client';
import { TASK_QUEUE_ORCHESTRATOR } from './task-queues';

const TEST_DB_DIR = join(tmpdir(), 'stardust-t10-schedule-client-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let repository: SchedulesProjectionRepository;

function createDescription(overrides: Partial<ScheduleDescription> = {}): ScheduleDescription {
	return {
		scheduleId: 'schedule-fixed',
		spec: {
			cronExpressions: ['0 9 * * *']
		},
		action: { type: 'startWorkflow', workflowType: 'scheduledAgentWorkflow' },
		policies: { overlap: 'BUFFER_ONE', catchupWindow: 60_000, pauseOnFailure: false },
		memo: {},
		searchAttributes: {},
		typedSearchAttributes: {},
		state: { paused: false },
		info: {
			recentActions: [],
			nextActionTimes: [new Date('2026-01-01T09:00:00.000Z')],
			numActionsTaken: 0,
			numActionsMissedCatchupWindow: 0,
			numActionsSkippedOverlap: 0,
			createdAt: new Date('2025-12-31T00:00:00.000Z'),
			lastUpdatedAt: undefined,
			runningActions: []
		},
		raw: {},
		...overrides
	} as ScheduleDescription;
}

beforeEach(() => {
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DB_DIR, { recursive: true });
	sqlite = new Database(TEST_DB_PATH);
	sqlite.pragma('journal_mode = WAL');
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: './drizzle' });
	repository = new SchedulesProjectionRepository(database);
});

afterEach(() => {
	sqlite?.close();
	rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe('schedule client', () => {
	it('creates a Temporal Schedule and writes the projection row', async () => {
		const describe = vi.fn(async () => createDescription());
		const create = vi.fn(async () => ({ describe }));
		const temporalClient = { schedule: { create } } as unknown as Pick<Client, 'schedule'>;

		const projection = await createTemporalSchedule(
			{
				name: 'Daily digest',
				description: 'Summarize the previous day',
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.'
			},
			{
				temporalClient,
				schedulesRepository: repository,
				createScheduleId: () => 'schedule-fixed'
			}
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				scheduleId: 'schedule-fixed',
				spec: { cronExpressions: ['0 9 * * *'] },
				action: expect.objectContaining({
					type: 'startWorkflow',
					workflowId: 'scheduled-agent:schedule-fixed',
					args: [{ scheduleId: 'schedule-fixed', prompt: 'Write the daily digest.' }]
				}),
				memo: expect.objectContaining({
					cronExpression: '0 9 * * *'
				})
			})
		);
		expect(projection).toMatchObject({
			temporalScheduleId: 'schedule-fixed',
			targetSessionKey: 'sched-schedule-fixed',
			name: 'Daily digest',
			status: 'active',
			nextRunAt: '2026-01-01T09:00:00.000Z'
		});
	});

	it('triggers a Temporal Schedule and refreshes projection timing', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});

		const trigger = vi.fn(async () => undefined);
		const describe = vi.fn(async () =>
			createDescription({
				info: {
					recentActions: [
						{
							scheduledAt: new Date('2026-01-01T09:00:00.000Z'),
							takenAt: new Date('2026-01-01T09:00:03.000Z'),
							action: {
								type: 'startWorkflow',
								workflow: {
									workflowId: 'scheduled-agent:schedule-fixed',
									firstExecutionRunId: 'run-001'
								}
							}
						}
					],
					nextActionTimes: [new Date('2026-01-02T09:00:00.000Z')],
					numActionsTaken: 1,
					numActionsMissedCatchupWindow: 0,
					numActionsSkippedOverlap: 0,
					createdAt: new Date('2025-12-31T00:00:00.000Z'),
					lastUpdatedAt: undefined,
					runningActions: []
				}
			})
		);
		const getHandle = vi.fn(() => ({ trigger, describe }));
		const temporalClient = { schedule: { getHandle } } as unknown as Pick<Client, 'schedule'>;

		const result = await triggerTemporalSchedule('schedule-fixed', {
			temporalClient,
			schedulesRepository: repository
		});

		expect(getHandle).toHaveBeenCalledWith('schedule-fixed');
		expect(trigger).toHaveBeenCalledWith('BUFFER_ONE');
		expect(result).toMatchObject({
			targetSessionKey: 'sched-schedule-fixed',
			schedule: {
				lastRunAt: '2026-01-01T09:00:03.000Z',
				nextRunAt: '2026-01-02T09:00:00.000Z'
			}
		});
	});

	it('links schedule fire rows to produced runs in the projection', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});
		sqlite
			.prepare(
				`INSERT INTO schedule_fire_events (id, schedule_id, trigger_source, actual_trigger_time, overlap_policy, scheduled_workflow_id, scheduled_temporal_run_id, target_session_key, accepted_run_id, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				'fire-001',
				'schedule-fixed',
				'manual',
				'2026-01-01T09:00:03.000Z',
				'BUFFER_ONE',
				'scheduled-agent:schedule-fixed',
				'temporal-run-001',
				'sched-schedule-fixed',
				'run-accepted-001',
				'accepted'
			);

		const projection = await repository.findByScheduleId('schedule-fixed');

		expect(projection?.fireEvents).toHaveLength(1);
		expect(projection?.fireEvents[0]).toMatchObject({
			scheduleId: 'schedule-fixed',
			scheduledWorkflowId: 'scheduled-agent:schedule-fixed',
			acceptedRunId: 'run-accepted-001',
			overlapPolicy: 'BUFFER_ONE'
		});
	});

	it('pauses a Temporal Schedule and refreshes projection state', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});

		const pause = vi.fn(async () => undefined);
		const describe = vi.fn(async () => createDescription({ state: { paused: true } }));
		const getHandle = vi.fn(() => ({ pause, describe }));
		const temporalClient = { schedule: { getHandle } } as unknown as Pick<Client, 'schedule'>;

		const schedule = await pauseTemporalSchedule('schedule-fixed', {
			temporalClient,
			schedulesRepository: repository
		});

		expect(getHandle).toHaveBeenCalledWith('schedule-fixed');
		expect(pause).toHaveBeenCalledWith('Paused from Stardust schedule manager');
		expect(schedule.status).toBe('paused');
	});

	it('resumes a Temporal Schedule and refreshes projection state', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.',
			descriptionFromTemporal: createDescription({ state: { paused: true } })
		});

		const unpause = vi.fn(async () => undefined);
		const describe = vi.fn(async () => createDescription({ state: { paused: false } }));
		const getHandle = vi.fn(() => ({ unpause, describe }));
		const temporalClient = { schedule: { getHandle } } as unknown as Pick<Client, 'schedule'>;

		const schedule = await resumeTemporalSchedule('schedule-fixed', {
			temporalClient,
			schedulesRepository: repository
		});

		expect(getHandle).toHaveBeenCalledWith('schedule-fixed');
		expect(unpause).toHaveBeenCalledWith('Resumed from Stardust schedule manager');
		expect(schedule.status).toBe('active');
	});

	it('deletes a Temporal Schedule and removes the projection row', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});

		const deleteSchedule = vi.fn(async () => undefined);
		const getHandle = vi.fn(() => ({ delete: deleteSchedule }));
		const temporalClient = { schedule: { getHandle } } as unknown as Pick<Client, 'schedule'>;

		const result = await deleteTemporalSchedule('schedule-fixed', {
			temporalClient,
			schedulesRepository: repository
		});

		expect(getHandle).toHaveBeenCalledWith('schedule-fixed');
		expect(deleteSchedule).toHaveBeenCalled();
		expect(result).toEqual({ scheduleId: 'schedule-fixed', deleted: true });
		expect(await repository.findByScheduleId('schedule-fixed')).toBeNull();
	});

	it('reconciles projection drift from Temporal schedules', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Stale name',
			cronExpression: '0 8 * * *',
			prompt: 'Old prompt.'
		});
		await repository.upsert({
			scheduleId: 'schedule-deleted',
			name: 'Deleted locally stale schedule',
			cronExpression: '0 7 * * *',
			prompt: 'Remove me.'
		});

		const temporalDescription = createDescription({
			action: {
				type: 'startWorkflow',
				workflowType: 'scheduledAgentWorkflow',
				workflowId: 'scheduled-agent:schedule-fixed',
				taskQueue: TASK_QUEUE_ORCHESTRATOR,
				args: [{ scheduleId: 'schedule-fixed', prompt: 'Write the daily digest.' }]
			},
			memo: {
				name: 'Daily digest',
				description: 'Summarize the previous day',
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.'
			},
			info: {
				recentActions: [],
				nextActionTimes: [new Date('2026-01-02T09:00:00.000Z')],
				numActionsTaken: 0,
				numActionsMissedCatchupWindow: 0,
				numActionsSkippedOverlap: 0,
				createdAt: new Date('2025-12-31T00:00:00.000Z'),
				lastUpdatedAt: undefined,
				runningActions: []
			}
		});
		const describe = vi.fn(async () => temporalDescription);
		const getHandle = vi.fn(() => ({ describe }));
		async function* list() {
			yield { scheduleId: 'schedule-fixed' };
		}
		const temporalClient = { schedule: { getHandle, list } } as unknown as Pick<Client, 'schedule'>;

		const schedules = await reconcileTemporalSchedules({
			temporalClient,
			schedulesRepository: repository
		});

		expect(getHandle).toHaveBeenCalledWith('schedule-fixed');
		expect(schedules).toHaveLength(1);
		expect(schedules[0]).toMatchObject({
			temporalScheduleId: 'schedule-fixed',
			name: 'Daily digest',
			description: 'Summarize the previous day',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.',
			nextRunAt: '2026-01-02T09:00:00.000Z'
		});
		expect(await repository.findByScheduleId('schedule-deleted')).toBeNull();
	});
});
