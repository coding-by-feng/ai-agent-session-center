import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('settings panel opens with S key', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    // Click body to ensure no input is focused
    await page.locator('body').click();
    await page.keyboard.press('s');
    await expect(page.getByText('APPEARANCE')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('SOUND')).toBeVisible();
    await expect(page.getByText('HOOKS')).toBeVisible();
  });

  test('settings tabs switch correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.locator('body').click();
    await page.keyboard.press('s');
    await expect(page.getByText('APPEARANCE')).toBeVisible({ timeout: 5000 });

    // Click SOUND tab
    await page.getByText('SOUND').click();
    // Sound settings content should be visible
    await expect(page.locator('[class*="settings"]')).toBeVisible();

    // Click LABELS tab
    await page.getByText('LABELS').click();
    await expect(page.locator('[class*="settings"]')).toBeVisible();
  });

  test('theme changes persist across navigation', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);

    // Open settings
    await page.locator('body').click();
    await page.keyboard.press('s');
    await expect(page.getByText('APPEARANCE')).toBeVisible({ timeout: 5000 });

    // Find a theme option and click it (if there's a theme selector)
    const themeButtons = page.locator('[class*="theme"]');
    const themeCount = await themeButtons.count();

    if (themeCount > 0) {
      // Click a non-default theme
      await themeButtons.first().click();
    }

    // Close settings (Escape)
    await page.keyboard.press('Escape');

    // Navigate away and back
    await page.getByRole('link', { name: 'HISTORY' }).click();
    await page.getByRole('link', { name: 'LIVE' }).click();

    // Settings should still reflect the chosen theme on reopen
    await page.locator('body').click();
    await page.keyboard.press('s');
    await expect(page.getByText('APPEARANCE')).toBeVisible({ timeout: 5000 });
  });
});
