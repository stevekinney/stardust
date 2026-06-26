import { describe, expect, it, vi } from 'vitest';
import { triggerTemporalSchedule } from '$lib/server/schedules';
import { POST } from './+server';

vi.mock('$lib/server/schedules', () => ({
	triggerTemporalSchedule: vi.fn()
}));

describe('schedule trigger route', () => {
	it('triggers a schedule and returns the target session key', async () => {
		vi.mocked(triggerTemporalSchedule).mockResolvedValueOnce({
			targetSessionKey: 'scheduled:schedule-001',
			schedule: {
				id: 'schedule-001',
				temporalScheduleId: 'schedule-001',
				targetSessionKey: 'scheduled:schedule-001',
				name: 'Daily digest',
				description: null,
				cronExpression: '0 9 * * *',
				prompt: 'Write the daily digest.',
				status: 'active',
				lastRunAt: '2026-01-01T09:00:03.000Z',
				nextRunAt: '2026-01-02T09:00:00.000Z',
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T09:00:03.000Z'
			}
		});

		const response = await POST({
			params: { scheduleId: 'schedule-001' },
			request: new Request('http://localhost/api/schedules/schedule-001/trigger', {
				method: 'POST'
			})
		} as Parameters<typeof POST>[0]);

		expect(response.status).toBe(200);
		expect(triggerTemporalSchedule).toHaveBeenCalledWith('schedule-001');
		expect(await response.json()).toEqual({
			targetSessionKey: 'scheduled:schedule-001',
			schedule: expect.objectContaining({
				lastRunAt: '2026-01-01T09:00:03.000Z'
			})
		});
	});
});
