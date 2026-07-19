/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 入口。挂载 App 到 #root。
 *
 * 对照 webview src/index.tsx：那边先 acquireVsCodeApi() 存 window.vscode；
 * 这边的等价物是 preload 注入的 window.otto（见 ../preload/index.ts），
 * renderer 经 ./transport 使用，无需在此初始化。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import './browserPreviewBridge.js';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 容器');
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
