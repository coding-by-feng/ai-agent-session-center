import { defineConfig } from '@playwright/test';
/** Explicit invocation only: no default webServer, existing server reuse, hooks or MQ. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /cloud-(resources|projects|notes)\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: 'test-screenshots/task14/playwright',
  // Trace finalization hangs with two manually owned contexts on the host runtime;
  // retain explicit screenshots and failure screenshots without trace recording.
  use: {
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 15000,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
});
