import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteTemporalSchedule } from '$lib/server/schedules';

export const DELETE: RequestHandler = async ({ params }) => {
	try {
		return json(await deleteTemporalSchedule(params.scheduleId));
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : 'Failed to delete schedule';
		if (message === 'Schedule not found') throw error(404, message);
		if (message === 'Invalid schedule id') throw error(400, message);
		throw caught;
	}
};
