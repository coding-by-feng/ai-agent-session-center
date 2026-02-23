import { test, expect } from '@playwright/test';

test.describe('Session groups', () => {
  test('sidebar shows sessions grouped by room', async ({ page, request }) => {
    const sessionId = `e2e-groups-${Date.now()}`;
    await page.goto('/');
    await page.waitForEvent('websocket', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Create a test session so we're not in empty state
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-groups-test',
      },
    });

    await page.locator(`[data-session-id="${sessionId}"]`).waitFor({
      state: 'visible',
      timeout: 10000,
    });

    // The sidebar groups sessions by room — "Common Area" is the default group
    await expect(page.getByText('Common Area')).toBeVisible({ timeout: 5000 });
  });

  test('multiple sessions appear in sidebar', async ({ page, request }) => {
    const session1 = `e2e-multi1-${Date.now()}`;
    const session2 = `e2e-multi2-${Date.now()}`;
    await page.goto('/');
    await page.waitForEvent('websocket', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Create two sessions
    await request.post('/api/hooks', {
      data: {
        session_id: session1,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-multi-test-1',
      },
    });
    await request.post('/api/hooks', {
      data: {
        session_id: session2,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-multi-test-2',
      },
    });

    // Both should appear
    await expect(page.locator(`[data-session-id="${session1}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`[data-session-id="${session2}"]`)).toBeVisible({ timeout: 10000 });
  });
});
