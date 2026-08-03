import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../scripts/tests/test-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
});
