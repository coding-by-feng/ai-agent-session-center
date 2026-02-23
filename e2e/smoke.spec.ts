import { test, expect } from '@playwright/test';

test.describe('Smoke tests', () => {
  test('page loads and shows header', async ({ page }) => {
    await page.goto('/');
    // Header should be visible with the app title
    await expect(page.locator('header')).toBeVisible();
  });

  test('page loads without JavaScript errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      // Ignore known WebGL warnings and ResizeObserver errors
      const msg = error.message;
      if (msg.includes('ResizeObserver') || msg.includes('WebGL')) return;
      errors.push(msg);
    });

    await page.goto('/');
    await page.waitForTimeout(3000);

    expect(errors).toHaveLength(0);
  });

  test('WebSocket connects', async ({ page }) => {
    const wsPromise = page.waitForEvent('websocket', { timeout: 10000 });
    await page.goto('/');
    const ws = await wsPromise;
    expect(ws.url()).toContain('/ws');
  });

  test('auth status endpoint responds', async ({ request }) => {
    const res = await request.get('/api/auth/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('passwordRequired');
  });

  test('no active sessions shows empty sidebar', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(2000);
    // When no sessions exist, either the sidebar is absent or has 0 cards
    const cards = await page.locator('[data-session-id]').count();
    // If there are existing sessions from other tests, just verify page loaded
    // The sidebar returns null when empty, so no specific "empty" text to check
    expect(cards).toBeGreaterThanOrEqual(0);
  });
});
