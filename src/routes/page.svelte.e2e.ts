import { expect, test } from '@playwright/test';

test('shows schedule manager', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toHaveText('Schedule Manager');
	await expect(page.getByRole('heading', { name: 'Create Schedule' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
});
