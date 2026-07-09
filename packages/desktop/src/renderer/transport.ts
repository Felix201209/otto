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
export type ConnectionHandler = (connected: boolean) => void;
/** 应用菜单动作回调（'new-chat' | 'open-settings'）。 */
export type MenuHandler = (action: string) => void;

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

/**
 * 订阅连接状态变化（断线/重连）。返回取消订阅函数。
 * 透传封装：组件/store 经此订阅，不直接碰 window.otto。
 * preload 会在注册时立即以当前状态回调一次。
 */
export function onConnectionChange(handler: ConnectionHandler): () => void {
  return window.otto.onConnectionChange(handler);
}

export function isConnected(): boolean {
  return window.otto.isConnected();
}

/**
 * 订阅应用菜单动作（main 经 preload 下发）：'new-chat' | 'open-settings'。
 * 返回取消订阅函数。透传封装：App 经此订阅，不直接碰 window.otto。
 */
export function onMenu(handler: MenuHandler): () => void {
  return window.otto.onMenu(handler);
}

/** host-only：用系统浏览器打开外链（斜杠命令 /hooks 等）。透传封装，不直接碰 window.otto。 */
export function openExternal(url: string): Promise<void> {
  return window.otto.openExternal(url);
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
