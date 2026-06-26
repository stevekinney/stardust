import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { triggerTemporalSchedule } from '$lib/server/schedules';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const result = await triggerTemporalSchedule(params.scheduleId);
		return json(result);
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : 'Failed to trigger schedule';
		if (message === 'Schedule not found') throw error(404, message);
		if (message === 'Invalid schedule id') throw error(400, message);
		throw caught;
	}
};
