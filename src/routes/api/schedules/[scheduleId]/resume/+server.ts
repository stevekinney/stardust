import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resumeTemporalSchedule } from '$lib/server/schedules';

export const POST: RequestHandler = async ({ params }) => {
	try {
		const schedule = await resumeTemporalSchedule(params.scheduleId);
		return json({ schedule });
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : 'Failed to resume schedule';
		if (message === 'Schedule not found') throw error(404, message);
		if (message === 'Invalid schedule id') throw error(400, message);
		throw caught;
	}
};
