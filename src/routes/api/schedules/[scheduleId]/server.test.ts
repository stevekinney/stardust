import { describe, expect, it, vi } from 'vitest';
import { deleteTemporalSchedule } from '$lib/server/schedules';
import { DELETE } from './+server';

vi.mock('$lib/server/schedules', () => ({
	deleteTemporalSchedule: vi.fn()
}));

describe('schedule delete route', () => {
	it('deletes a schedule and returns a deletion acknowledgment', async () => {
		vi.mocked(deleteTemporalSchedule).mockResolvedValueOnce({
			scheduleId: 'schedule-001',
			deleted: true
		});

		const response = await DELETE({
			params: { scheduleId: 'schedule-001' },
			request: new Request('http://localhost/api/schedules/schedule-001', {
				method: 'DELETE'
			})
		} as Parameters<typeof DELETE>[0]);

		expect(response.status).toBe(200);
		expect(deleteTemporalSchedule).toHaveBeenCalledWith('schedule-001');
		expect(await response.json()).toEqual({
			scheduleId: 'schedule-001',
			deleted: true
		});
	});
});
