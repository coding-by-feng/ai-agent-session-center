import { test, expect } from '@playwright/test';

const TEST_SESSION_ID = `e2e-test-${Date.now()}`;

test.describe('Session lifecycle', () => {
  test('session appears after hook event and detail panel opens on click', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // Send a SessionStart hook event via the HTTP fallback API
    const hookPayload = {
      session_id: TEST_SESSION_ID,
      hook_event_name: 'SessionStart',
      cwd: '/tmp/e2e-test-project',
      source: 'test',
    };

    const hookRes = await request.post('/api/hooks', {
      data: hookPayload,
    });
    expect(hookRes.ok()).toBeTruthy();

    // Wait for the session card to appear in the UI
    const card = page.locator(`[data-session-id="${TEST_SESSION_ID}"]`);
    await expect(card).toBeVisible({ timeout: 5000 });

    // Click the session card to open detail panel
    await card.click();

    // Detail panel should slide in with session info
    const detailPanel = page.locator('[class*="overlay"]').first();
    await expect(detailPanel).toBeVisible({ timeout: 3000 });

    // Project name should appear in the panel
    await expect(page.getByText('e2e-test-project')).toBeVisible();

    // Close the panel by pressing Escape
    await page.keyboard.press('Escape');
    await expect(detailPanel).not.toBeVisible({ timeout: 3000 });
  });

  test('session status updates when receiving events', async ({
    page,
    request,
  }) => {
    const sessionId = `e2e-status-${Date.now()}`;
    await page.goto('/');

    // Create session
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-status-test',
      },
    });

    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 5000 });

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
      timeout: 5000,
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
      timeout: 5000,
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
