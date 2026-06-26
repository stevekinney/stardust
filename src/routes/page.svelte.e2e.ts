import { expect, test } from '@playwright/test';

test('shows operations console', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1')).toHaveText('Operations Console');
	await expect(page.getByRole('heading', { name: 'Run Inspector' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Create Schedule' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
});
