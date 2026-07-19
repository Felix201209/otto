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
 * monorepo 里 root 的 react 是 19、desktop 自带 react 18。@testing-library/react@16
 * 从 root 解析会拿到 react / react-dom 19，而被测 hook 从 desktop 解析拿到 react 18 ——
 * 两份 react 实例导致 hooks dispatcher 为 null（useReducer 崩）。
 *
 * `dedupe` 在本仓不可靠（root 与 desktop 各有一份完整副本，去重不一定命中同一份），
 * 且把入口钉到 desktop 的 react 18 又拦不住 RTL 内部对 `react-dom/client` 的解析
 * （RTL 16 在仓内仍命中 root 的 react-dom 19）。改为把 react / react-dom 全部钉死到
 * **root 的 react 19**——RTL 16 原生兼容 19，hook 与 RTL 渲染器共用同一实例，dispatcher
 * 正常。被测内容是 store 的 reducer（纯函数）与基础 hook（useReducer/useRef），18→19
 * 行为无差异；生产 renderer 仍由 webpack 用 desktop 的 react 18 编译，测试解析独立于打包。
 */
// 从 monorepo 根解析 react 副本（19），避免 desktop 自带的 18 与 RTL 16 解析的 19
// 分裂成两份实例。RTL 16 原生兼容 react 19。
const rootRequire = createRequire(new URL('../../package.json', import.meta.url));
const reactDir = dirname(rootRequire.resolve('react/package.json'));
const reactDomDir = dirname(rootRequire.resolve('react-dom/package.json'));

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
