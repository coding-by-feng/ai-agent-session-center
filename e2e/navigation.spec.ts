import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('all 5 navigation views load', async ({ page }) => {
    await page.goto('/');

    // LIVE view (default)
    await expect(page.locator('nav')).toBeVisible();
    const navLinks = page.locator('nav a');
    await expect(navLinks).toHaveCount(5);

    // Navigate to HISTORY
    await page.getByRole('link', { name: 'HISTORY' }).click();
    await expect(page).toHaveURL('/history');

    // Navigate to TIMELINE
    await page.getByRole('link', { name: 'TIMELINE' }).click();
    await expect(page).toHaveURL('/timeline');

    // Navigate to ANALYTICS
    await page.getByRole('link', { name: 'ANALYTICS' }).click();
    await expect(page).toHaveURL('/analytics');

    // Navigate to QUEUE
    await page.getByRole('link', { name: 'QUEUE' }).click();
    await expect(page).toHaveURL('/queue');

    // Navigate back to LIVE
    await page.getByRole('link', { name: 'LIVE' }).click();
    await expect(page).toHaveURL('/');
  });

  test('active nav link is highlighted', async ({ page }) => {
    await page.goto('/');
    const liveLink = page.getByRole('link', { name: 'LIVE' });
    await expect(liveLink).toHaveClass(/active/);

    await page.getByRole('link', { name: 'HISTORY' }).click();
    const historyLink = page.getByRole('link', { name: 'HISTORY' });
    await expect(historyLink).toHaveClass(/active/);
    await expect(liveLink).not.toHaveClass(/active/);
  });

  test('new session button opens modal', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '+ NEW' }).click();
    // Modal should appear
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('shortcuts button opens shortcuts panel', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '?' }).click();
    // Shortcuts panel should appear
    await expect(page.getByText('Keyboard Shortcuts')).toBeVisible();
  });
});
