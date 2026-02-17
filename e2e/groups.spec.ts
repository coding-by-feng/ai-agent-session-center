import { test, expect } from '@playwright/test';

test.describe('Session groups', () => {
  test('toggle between flat and grouped view', async ({ page, request }) => {
    const sessionId = `e2e-groups-${Date.now()}`;
    await page.goto('/');

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
      timeout: 5000,
    });

    // Find the FLAT/GROUPED toggle button
    const toggleBtn = page.getByRole('button', { name: /flat|grouped/i });
    await expect(toggleBtn).toBeVisible();

    // Click to switch to GROUPED view
    const initialText = await toggleBtn.textContent();
    await toggleBtn.click();

    // The button text should have changed
    const newText = await toggleBtn.textContent();
    expect(newText).not.toBe(initialText);

    // Click again to switch back
    await toggleBtn.click();
    const revertedText = await toggleBtn.textContent();
    expect(revertedText).toBe(initialText);
  });

  test('grouped view shows Ungrouped section', async ({ page, request }) => {
    const sessionId = `e2e-ungroup-${Date.now()}`;
    await page.goto('/');

    // Create session
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-ungroup-test',
      },
    });

    await page.locator(`[data-session-id="${sessionId}"]`).waitFor({
      state: 'visible',
      timeout: 5000,
    });

    // Switch to grouped view
    const toggleBtn = page.getByRole('button', { name: /flat/i });
    if (await toggleBtn.isVisible()) {
      await toggleBtn.click();
    }

    // Should see the "Ungrouped" section header
    const ungroupedHeader = page.getByText(/ungrouped/i);
    await expect(ungroupedHeader).toBeVisible({ timeout: 3000 });
  });
});
