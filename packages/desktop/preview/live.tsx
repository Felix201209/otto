/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 浏览器实时模式入口 —— 用真实 WS 桥连 otto-server，不再是 mock 数据。
 *
 * 对照 preview/mock.tsx：mock 回放假数据只能看个壳。本文件换用 live-bridge，
 * 让 renderer（App.tsx）真正跟本机 otto-server 对话：拉真实会话列表、发消息、
 * 收流式回复。Electron 崩了也能在浏览器里完整跑 Otto 桌面界面。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App.js';
import './live-bridge.js'; // 侧效：把 (window as any).otto 设好

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
