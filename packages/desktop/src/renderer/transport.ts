/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 传输层（接缝）。
 *
 * 这是替代 webview `multiSessionMessageService` 的 `window.vscode.postMessage` /
 * `window.addEventListener('message')` 的最小封装（交付文档 [WEBVIEW] §5「必须替换」第 1 条）。
 *
 * Issue #5 实装：把 webview 源码移进 renderer 后，让其传输底调用本模块即可，
 * 信封 `{ type, payload }` 与 webview 完全一致，组件零改。
 */

import type {
  ClientToServer,
  ServerToClient,
  OttoMessage,
  SessionSummary,
} from 'otto-server';
import type { OttoBridge } from '../preload/index.js';

declare global {
  interface Window {
    /** preload 经 contextBridge 暴露的桥。 */
    otto: OttoBridge;
  }
}

export type FrameHandler = (frame: ServerToClient) => void;

/** 连接到本地 server（preload 已持有端点）。 */
export async function connect(): Promise<boolean> {
  return window.otto.connect();
}

/** 发一帧。 */
export function send(frame: ClientToServer): void {
  window.otto.send(frame);
}

/** 订阅入站帧。 */
export function onFrame(handler: FrameHandler): () => void {
  return window.otto.onFrame(handler);
}

export function isConnected(): boolean {
  return window.otto.isConnected();
}

// ── 便捷封装（实装可直接用，也可由 webview service 自行组装）──

export function listSessions(): void {
  send({ type: 'list_sessions', payload: {} });
}

export function subscribe(sessionId: string): void {
  send({ type: 'subscribe', payload: { sessionId } });
}

export function sendUserMessage(
  sessionId: string,
  text: string,
  source: 'local' | 'feishu' = 'local',
): void {
  send({
    type: 'send_user_message',
    payload: { sessionId, content: [{ type: 'text', value: text }], source },
  });
}

// 重导出常用协议类型，方便 renderer 子模块 import 一处。
export type { OttoMessage, SessionSummary, ServerToClient, ClientToServer };
