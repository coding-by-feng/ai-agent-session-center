import { defineConfig } from 'vitest/config';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

// Server tests transitively import server/db.ts, which opens a real SQLite
// database at $APP_USER_DATA/data/sessions.db on import. Point that at a
// scratch directory so tests never touch the developer's live data — and see
// test/globalSetup.ts, which wipes it once per run to stop state leaking
// between runs.
const SERVER_TEST_DATA_DIR = join(tmpdir(), 'aasc-server-tests');

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10_000,
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/**/*.test.{js,ts}'],
          globalSetup: ['test/globalSetup.ts'],
          env: { APP_USER_DATA: SERVER_TEST_DATA_DIR },
        },
      },
      {
        resolve: {
          alias: {
            '@': resolve(__dirname, 'src'),
          },
        },
        test: {
          name: 'client',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/__tests__/setup.ts'],
        },
      },
    ],
  },
});
