import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites start real runtimes and child shells.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
