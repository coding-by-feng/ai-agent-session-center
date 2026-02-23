import { test, expect } from '@playwright/test';

test.describe('Kill session', () => {
  test('kill button shows confirm modal and removes session', async ({
    page,
    request,
  }) => {
    const sessionId = `e2e-kill-${Date.now()}`;
    await page.goto('/');
    await page.waitForEvent('websocket', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Create a test session via hook API
    await request.post('/api/hooks', {
      data: {
        session_id: sessionId,
        hook_event_name: 'SessionStart',
        cwd: '/tmp/e2e-kill-test',
      },
    });

    // Wait for card to appear
    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 10000 });

    // Click card to select it and open detail panel
    await card.click();
    await expect(page.locator('[class*="overlay"]').first()).toBeVisible({
      timeout: 5000,
    });

    // Use keyboard shortcut K to trigger kill
    await page.keyboard.press('k');

    // Kill confirm modal should appear
    const killModal = page.getByRole('dialog');
    await expect(killModal).toBeVisible({ timeout: 5000 });

    // Confirm the kill
    const confirmBtn = page.getByRole('button', { name: /confirm|kill|yes/i });
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }

    // Session card should eventually be removed or show ended status
    await expect(card).toHaveAttribute('data-status', 'ended', {
      timeout: 15000,
    });
  });
});
