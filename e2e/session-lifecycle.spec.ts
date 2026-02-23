import { test, expect } from '@playwright/test';

test.describe('Session lifecycle', () => {
  test('session appears after hook event and detail panel opens on click', async ({
    page,
    request,
  }) => {
    const sessionId = `e2e-test-${Date.now()}`;
    await page.goto('/');
    // Wait for WebSocket to connect
    await page.waitForEvent('websocket', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Send a SessionStart hook event via the HTTP fallback API
    const hookRes = await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-test-project',
        source: 'test',
      },
    });
    expect(hookRes.ok()).toBeTruthy();

    // Wait for the session entry to appear in the sidebar
    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // Click the session entry to open detail panel
    await card.click();

    // Detail panel should slide in with session info
    const detailPanel = page.locator('[class*="overlay"]').first();
    await expect(detailPanel).toBeVisible({ timeout: 5000 });

    // Project name should appear in the panel
    await expect(page.getByText('e2e-test-project')).toBeVisible();

    // Close the panel by pressing Escape
    await page.keyboard.press('Escape');
    await expect(detailPanel).not.toBeVisible({ timeout: 5000 });
  });

  test('session status updates when receiving events', async ({
    page,
    request,
  }) => {
    const sessionId = `e2e-status-${Date.now()}`;
    await page.goto('/');
    await page.waitForEvent('websocket', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Create session
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-status-test',
      },
    });

    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // Send a UserPromptSubmit to change status to prompting
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/e2e-status-test',
      },
    });

    // Card should reflect the status change
    await expect(card).toHaveAttribute('data-status', 'prompting', {
      timeout: 10000,
    });

    // Send PreToolUse to change to working
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        cwd: '/tmp/e2e-status-test',
      },
    });

    await expect(card).toHaveAttribute('data-status', 'working', {
      timeout: 10000,
    });

    // Clean up: end session
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'Stop',
        cwd: '/tmp/e2e-status-test',
      },
    });
  });
});
