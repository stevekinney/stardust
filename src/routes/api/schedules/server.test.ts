import { describe, expect, it, vi } from 'vitest';
import { GET, POST } from './+server';
import { createTemporalSchedule, reconcileTemporalSchedules } from '$lib/server/schedules';

vi.mock('$lib/server/schedules', () => ({
	createTemporalSchedule: vi.fn(),
	reconcileTemporalSchedules: vi.fn()
}));

describe('schedules create route', () => {
	it('reconciles schedules and returns the projection list', async () => {
		vi.mocked(reconcileTemporalSchedules).mockResolvedValueOnce([
			{
				id: 'schedule-001',
				temporalScheduleId: 'schedule-001',
				targetSessionKey: 'sched-schedule-001',
				name: 'Daily digest',
				description: null,
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.',
				status: 'active',
				lastRunAt: null,
				nextRunAt: '2026-01-02T09:00:00.000Z',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z'
			}
		]);

		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		expect(reconcileTemporalSchedules).toHaveBeenCalled();
		expect(await response.json()).toEqual({
			schedules: [
				expect.objectContaining({
					temporalScheduleId: 'schedule-001',
					nextRunAt: '2026-01-02T09:00:00.000Z'
				})
			]
		});
	});

	it('creates a schedule and returns the projection', async () => {
		vi.mocked(createTemporalSchedule).mockResolvedValueOnce({
			id: 'schedule-001',
			temporalScheduleId: 'schedule-001',
			targetSessionKey: 'sched-schedule-001',
			name: 'Daily digest',
			description: null,
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.',
			status: 'active',
			lastRunAt: null,
			nextRunAt: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		});

		const response = await POST({
			request: new Request('http://localhost/api/schedules', {
				method: 'POST',
				body: JSON.stringify({
					name: 'Daily digest',
					cronExpression: '0 9 * * *',
					prompt: 'Write the daily digest.'
				})
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(201);
		expect(createTemporalSchedule).toHaveBeenCalledWith({
			name: 'Daily digest',
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.',
			description: undefined
		});
		expect(await response.json()).toEqual({
			schedule: expect.objectContaining({
				temporalScheduleId: 'schedule-001',
				targetSessionKey: 'sched-schedule-001'
			})
		});
	});
});
