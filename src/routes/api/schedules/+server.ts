import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createTemporalSchedule, reconcileTemporalSchedules } from '$lib/server/schedules';

function readRequiredString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === 'string' ? value.trim() : '';
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) throw error(400, 'JSON body is required');

	const name = readRequiredString(body, 'name');
	const cronExpression = readRequiredString(body, 'cronExpression');
	const prompt = readRequiredString(body, 'prompt');
	const description = readRequiredString(body, 'description');

	if (!name) throw error(400, 'name is required');
	if (!cronExpression) throw error(400, 'cronExpression is required');
	if (!prompt) throw error(400, 'prompt is required');

	const schedule = await createTemporalSchedule({
		name,
		cronExpression,
		prompt,
		description: description || undefined
	});

	return json({ schedule }, { status: 201 });
};

export const GET: RequestHandler = async () => {
	const schedules = await reconcileTemporalSchedules();
	return json({ schedules });
};
