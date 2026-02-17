import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('page loads and shows header', async ({ page }) => {
    await page.goto('/');
    // Header should be visible with the app title
    await expect(page.locator('header')).toBeVisible();
  });

  test('page loads without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await page.waitForTimeout(2000);

    expect(errors).toHaveLength(0);
  });

  test('WebSocket connects', async ({ page }) => {
    const wsConnected = page.waitForEvent('websocket');
    await page.goto('/');
    const ws = await wsConnected;
    expect(ws.url()).toContain('/ws');
  });

  test('auth status endpoint responds', async ({ request }) => {
    const res = await request.get('/api/auth/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('passwordRequired');
  });

  test('no active sessions shows empty state', async ({ page }) => {
    await page.goto('/');
    // Either we see session cards or the empty state
    const hasCards = await page.locator('[data-status]').count();
    if (hasCards === 0) {
      await expect(page.getByText('No Active Sessions')).toBeVisible();
    }
  });
});
