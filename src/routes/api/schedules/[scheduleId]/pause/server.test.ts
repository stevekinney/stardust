import { describe, expect, it, vi } from 'vitest';
import { pauseTemporalSchedule } from '$lib/server/schedules';
import { POST } from './+server';

vi.mock('$lib/server/schedules', () => ({
	pauseTemporalSchedule: vi.fn()
}));

describe('schedule pause route', () => {
	it('pauses a schedule and returns the updated projection', async () => {
		vi.mocked(pauseTemporalSchedule).mockResolvedValueOnce({
			id: 'schedule-001',
			temporalScheduleId: 'schedule-001',
			targetSessionKey: 'sched-schedule-001',
			name: 'Daily digest',
			description: null,
			cronExpression: '0 9 * * *',
			prompt: 'Write the daily digest.',
			status: 'paused',
			lastRunAt: null,
			nextRunAt: null,
			fireEvents: [],
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z'
		});

		const response = await POST({
			params: { scheduleId: 'schedule-001' },
			request: new Request('http://localhost/api/schedules/schedule-001/pause', {
				method: 'POST'
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(pauseTemporalSchedule).toHaveBeenCalledWith('schedule-001');
		expect(await response.json()).toEqual({
			schedule: expect.objectContaining({
				temporalScheduleId: 'schedule-001',
				status: 'paused'
			})
		});
	});
});
