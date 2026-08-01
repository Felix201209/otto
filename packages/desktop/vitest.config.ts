/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 单测配置（jsdom）。
 *
 * 依赖（vitest / jsdom / @testing-library/react）已 hoist 到 root node_modules，
 * 无需在本包新增依赖即可解析。renderer 从 'otto-server' 一律 import type，
 * 类型在编译期被擦除，运行时不加载该模块，故无需其 dist 产物。
 */

import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/**
 * desktop 生产构建使用 React 18，而 renderer 测试使用 hoist 的 Testing Library。
 * pnpm 可能为 Testing Library 建立独立 peer 目录；直接绑定 root React 仍会形成两份实例。
 * 因此从 Testing Library 自身的解析上下文定位 React / ReactDOM，确保组件和渲染器共用
 * 同一个 hooks dispatcher。该配置只影响测试，生产 webpack 构建不受影响。
 */
// Resolve Testing Library from the desktop package first. This keeps React,
// ReactDOM and the renderer under test on one instance even when a worktree
// has package-local dependencies in addition to the hoisted workspace set.
const desktopRequire = createRequire(new URL('./package.json', import.meta.url));
const testingLibraryRequire = createRequire(
  desktopRequire.resolve('@testing-library/react/package.json'),
);
const reactDir = dirname(testingLibraryRequire.resolve('react/package.json'));
const reactDomDir = dirname(testingLibraryRequire.resolve('react-dom/package.json'));

export default defineConfig({
  resolve: {
    alias: {
      // 顺序敏感：先精确子路径，后裸包，避免裸包前缀吞掉子路径。
      'react-dom/client': `${reactDomDir}/client.js`,
      'react-dom/test-utils': `${reactDomDir}/test-utils.js`,
      'react-dom': `${reactDomDir}/index.js`,
      'react/jsx-runtime': `${reactDir}/jsx-runtime.js`,
      'react/jsx-dev-runtime': `${reactDir}/jsx-dev-runtime.js`,
      react: `${reactDir}/index.js`,
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/renderer/test-setup.ts'],
    include: [
      'src/renderer/**/*.test.{ts,tsx}',
      'src/main/**/*.test.ts',
      'src/preload/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    // 把 RTL 强制内联，让上面的 alias 对其内部 `react-dom/client` import 也生效，
    // 否则 RTL（CJS）会绕过 vite 解析、自行命中另一份 react-dom 实例。
    server: {
      deps: {
        inline: [/@testing-library\//],
      },
    },
  },
});
