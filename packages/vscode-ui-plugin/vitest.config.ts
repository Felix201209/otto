import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    // Use vitest projects so frontend (jsdom + jest-dom setup) and backend (node, no DOM)
    // can coexist with their own setup files.
    projects: [
      {
        extends: true,
        test: {
          name: 'webview',
          environment: 'jsdom',
          setupFiles: ['./webview/src/test-setup.ts'],
          include: ['webview/src/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'extension',
          environment: 'node',
          // No setupFiles: backend tests declare their own vi.mock('vscode', ...)
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
    // 性能优化：限制并发和资源使用
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2,
        minForks: 1,
      },
    },
    maxConcurrency: 5,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './webview/src'),
    },
  },
});
