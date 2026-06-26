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
import { createTemporalSchedule, triggerTemporalSchedule } from './schedule-client';

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
				})
			})
		);
		expect(projection).toMatchObject({
			temporalScheduleId: 'schedule-fixed',
			targetSessionKey: 'scheduled:schedule-fixed',
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
			targetSessionKey: 'scheduled:schedule-fixed',
			schedule: {
				lastRunAt: '2026-01-01T09:00:03.000Z',
				nextRunAt: '2026-01-02T09:00:00.000Z'
			}
		});
	});
});
