import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

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
