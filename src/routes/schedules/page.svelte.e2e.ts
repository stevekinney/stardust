import { expect, test } from '@playwright/test';

test('new schedule button opens the create form and submits a schedule', async ({ page }) => {
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ sessions: [] })
		});
	});

	let createdScheduleBody: unknown;

	await page.route('/api/schedules', (route) => {
		if (route.request().method() === 'POST') {
			createdScheduleBody = route.request().postDataJSON();
			void route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					schedule: {
						id: 'sched-row-001',
						temporalScheduleId: 'schedule-001',
						targetSessionKey: 'sched-schedule-001',
						name: 'Weekly checks',
						description: 'Run the weekly maintenance checklist',
						cronExpression: '0 9 * * 1',
						prompt: 'Run the checks and summarize failures.',
						status: 'active',
						lastRunAt: null,
						nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
						fireEvents: [],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString()
					}
				})
			});
			return;
		}

		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ schedules: [] })
		});
	});

	await page.goto('/schedules');

	await page.getByRole('button', { name: 'New schedule' }).click();
	await expect(page.getByRole('heading', { name: 'Create schedule' })).toBeVisible();

	await page.getByLabel('Name').fill('Weekly checks');
	await page.getByLabel('Description').fill('Run the weekly maintenance checklist');
	await page.getByLabel('Cron expression').fill('0 9 * * 1');
	await page.getByLabel('Prompt').fill('Run the checks and summarize failures.');
	await page.getByRole('button', { name: 'Create schedule' }).click();

	// "Weekly checks" appears in both the 24h fire timeline and the schedule row.
	const main = page.getByRole('main');
	await expect(main.getByText('Weekly checks')).toHaveCount(2);
	await expect(main.getByText('0 9 * * 1')).toBeVisible();
	await expect(main.getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(main.getByRole('button', { name: 'Trigger now' })).toBeVisible();
	expect(createdScheduleBody).toEqual({
		name: 'Weekly checks',
		description: 'Run the weekly maintenance checklist',
		cronExpression: '0 9 * * 1',
		prompt: 'Run the checks and summarize failures.'
	});
});
