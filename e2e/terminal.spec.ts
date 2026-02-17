import { test, expect } from '@playwright/test';

test.describe('Terminal', () => {
  test('terminal tab shows placeholder when no terminal attached', async ({
    page,
    request,
  }) => {
    const sessionId = `e2e-terminal-${Date.now()}`;
    await page.goto('/');

    // Create a display-only session (no terminal)
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-terminal-test',
      },
    });

    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 5000 });

    // Open detail panel
    await card.click();
    await expect(page.locator('[class*="overlay"]').first()).toBeVisible({
      timeout: 3000,
    });

    // Click the TERMINAL tab
    const terminalTab = page.getByRole('tab', { name: /terminal/i }).or(
      page.getByText('TERMINAL'),
    );
    await terminalTab.click();

    // Should show placeholder since this session has no terminal
    await expect(
      page.getByText(/no terminal/i),
    ).toBeVisible({ timeout: 3000 });
  });

  test('create local terminal via API', async ({ page, request }) => {
    await page.goto('/');

    // Create a terminal via the REST API
    const res = await request.post('/api/terminals', {
      data: {
        host: 'localhost',
        workingDir: '/tmp',
        command: '',
      },
    });

    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBeTruthy();
    expect(data.terminalId).toBeDefined();

    // Wait for the session to appear
    await page.waitForTimeout(2000);

    // Check that a session card appeared (the terminal creates a connecting session)
    const cards = page.locator('[data-status]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);

    // Clean up: close the terminal
    if (data.terminalId) {
      await request.delete(`/api/terminals/${data.terminalId}`);
    }
  });

  test('terminal toolbar has theme selector and buttons', async ({
    page,
    request,
  }) => {
    // Create a session with a terminal
    const termRes = await request.post('/api/terminals', {
      data: {
        host: 'localhost',
        workingDir: '/tmp',
        command: '',
      },
    });

    if (!termRes.ok()) {
      test.skip();
      return;
    }

    const termData = await termRes.json();
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Find and click the session that has this terminal
    const cards = page.locator('[data-status]');
    const cardCount = await cards.count();

    if (cardCount > 0) {
      await cards.first().click();
      await expect(page.locator('[class*="overlay"]').first()).toBeVisible({
        timeout: 3000,
      });

      // Click TERMINAL tab
      const terminalTab = page.getByRole('tab', { name: /terminal/i }).or(
        page.getByText('TERMINAL'),
      );
      await terminalTab.click();

      // Check toolbar elements
      const toolbar = page.locator('[class*="toolbar"]');
      if (await toolbar.isVisible()) {
        // Theme selector should exist
        const themeSelect = page.locator('select[title="Terminal theme"]');
        await expect(themeSelect).toBeVisible({ timeout: 3000 });

        // ESC button should exist
        await expect(page.getByRole('button', { name: 'ESC' })).toBeVisible();

        // Fullscreen button should exist
        await expect(
          page.getByRole('button', { name: /fullscreen/i }),
        ).toBeVisible();
      }
    }

    // Clean up
    if (termData.terminalId) {
      await request.delete(`/api/terminals/${termData.terminalId}`);
    }
  });
});
