import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/evals/src/**/*.scenario.test.ts'],
    setupFiles: ['scripts/tests/test-setup.ts'],
    reporters: ['default', 'junit'],
    outputFile: {
      junit: 'packages/evals/artifacts/junit.xml',
    },
  },
});
