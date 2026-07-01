import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Client, ScheduleDescription } from '@temporalio/client';
import { TASK_QUEUE_ORCHESTRATOR, TASK_QUEUE_TOOLS } from '@src/lib/types';
import * as schema from '../db/schema';
import { SchedulesProjectionRepository } from '../schedules/projection';
import {
	defineScheduleTools,
	executeScheduleCreate,
	executeScheduleList,
	scheduleCreateInput,
	scheduleListInput
} from './schedule-tools';

const TEST_DB_DIR = join(tmpdir(), 'stardust-schedule-tools-test');
const TEST_DB_PATH = join(TEST_DB_DIR, 'test.db');

let sqlite: Database.Database;
let repository: SchedulesProjectionRepository;

function createDescription(overrides: Partial<ScheduleDescription> = {}): ScheduleDescription {
	return {
		scheduleId: 'schedule-fixed',
		spec: { cronExpressions: ['0 9 * * *'] },
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

describe('scheduleCreateInput', () => {
	it('accepts a valid 5-field cron expression', () => {
		const parsed = scheduleCreateInput.safeParse({
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts named and stepped cron fields', () => {
		expect(
			scheduleCreateInput.safeParse({
				name: 'Weekday standup',
				cronExpression: '*/15 9-17 * * MON-FRI',
				prompt: 'Summarize open PRs.'
			}).success
		).toBe(true);
	});

	it('rejects a cron expression with too few fields', () => {
		const parsed = scheduleCreateInput.safeParse({
			name: 'Daily digest',
			cronExpression: '0 9 * *',
			prompt: 'Write the daily digest.'
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects a cron expression with too many fields', () => {
		const parsed = scheduleCreateInput.safeParse({
			name: 'Daily digest',
			cronExpression: '0 9 * * * *',
			prompt: 'Write the daily digest.'
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects an empty name or prompt', () => {
		expect(
			scheduleCreateInput.safeParse({ name: '', cronExpression: '0 9 * * *', prompt: 'x' }).success
		).toBe(false);
		expect(
			scheduleCreateInput.safeParse({ name: 'x', cronExpression: '0 9 * * *', prompt: '' }).success
		).toBe(false);
	});

	it('treats description as optional', () => {
		const parsed = scheduleCreateInput.safeParse({
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});
		expect(parsed.success).toBe(true);
	});
});

describe('scheduleListInput', () => {
	it('accepts an empty object', () => {
		expect(scheduleListInput.safeParse({}).success).toBe(true);
	});
});

describe('executeScheduleCreate', () => {
	it('delegates to createTemporalSchedule and returns a compact result', async () => {
		const describe = vi.fn(async () => createDescription());
		const create = vi.fn(async () => ({ describe }));
		const temporalClient = { schedule: { create } } as unknown as Pick<Client, 'schedule'>;

		const result = await executeScheduleCreate(
			{
				name: 'Daily digest',
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
				spec: { cronExpressions: ['0 9 * * *'] }
			})
		);
		expect(result).toEqual({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *'
		});
	});

	it('forwards an optional description into the schedule projection', async () => {
		const describe = vi.fn(async () => createDescription());
		const create = vi.fn(async () => ({ describe }));
		const temporalClient = { schedule: { create } } as unknown as Pick<Client, 'schedule'>;

		await executeScheduleCreate(
			{
				name: 'Daily digest',
				description: 'Summarize the previous day',
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.'
			},
			{ temporalClient, schedulesRepository: repository, createScheduleId: () => 'schedule-fixed' }
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				memo: expect.objectContaining({ description: 'Summarize the previous day' })
			})
		);
	});
});

describe('executeScheduleList', () => {
	it('reconciles schedules and returns a compact projection including paused state', async () => {
		await repository.upsert({
			scheduleId: 'schedule-fixed',
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.'
		});

		const pausedDescription = createDescription({
			action: {
				type: 'startWorkflow',
				workflowType: 'scheduledAgentWorkflow',
				workflowId: 'scheduled-agent:schedule-fixed',
				taskQueue: TASK_QUEUE_ORCHESTRATOR
			},
			memo: {
				name: 'Daily digest',
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.'
			},
			state: { paused: true }
		});
		const describe = vi.fn(async () => pausedDescription);
		const getHandle = vi.fn(() => ({ describe }));
		async function* list() {
			yield { scheduleId: 'schedule-fixed' };
		}
		const temporalClient = { schedule: { getHandle, list } } as unknown as Pick<Client, 'schedule'>;

		const result = await executeScheduleList({ temporalClient, schedulesRepository: repository });

		expect(result).toEqual([
			{
				scheduleId: 'schedule-fixed',
				name: 'Daily digest',
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.',
				paused: true
			}
		]);
	});

	it('returns an empty list when Temporal has no Stardust schedules', async () => {
		async function* list() {
			// no schedules
		}
		const getHandle = vi.fn();
		const temporalClient = { schedule: { getHandle, list } } as unknown as Pick<Client, 'schedule'>;

		const result = await executeScheduleList({ temporalClient, schedulesRepository: repository });
		expect(result).toEqual([]);
	});
});

describe('defineScheduleTools', () => {
	it('registers schedule.create and schedule.list', () => {
		const tools = defineScheduleTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(['schedule.create', 'schedule.list']);
	});

	it('requires approval and a dedupe key for schedule.create', () => {
		const tools = defineScheduleTools();
		const createTool = tools.find((tool) => tool.name === 'schedule.create');
		expect(createTool?.metadata.requiresApproval).toBe(true);
		expect(createTool?.metadata.idempotencyBehavior).toBe('key-required');
		expect(createTool?.metadata.taskQueue).toBe(TASK_QUEUE_TOOLS);
	});

	it('never requires approval for schedule.list', () => {
		const tools = defineScheduleTools();
		const listTool = tools.find((tool) => tool.name === 'schedule.list');
		expect(listTool?.metadata.requiresApproval).toBe(false);
		expect(listTool?.metadata.risk).toBe('low');
	});
});
