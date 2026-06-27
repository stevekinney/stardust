import { expect, test } from '@playwright/test';

test('ops console shows operations console heading and panels', async ({ page }) => {
	// Mock all data endpoints so the test does not need a real database.
	await page.route('/api/sessions', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ sessions: [] })
		});
	});
	await page.route('/api/schedules', (route) => {
		void route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ schedules: [] })
		});
	});

	await page.goto('/ops');

	await expect(page.locator('h1')).toHaveText('Operations Console');
	await expect(page.getByRole('heading', { name: 'Manual Run Inspector' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Create Schedule' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
});
