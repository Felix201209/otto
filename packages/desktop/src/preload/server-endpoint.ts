/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServerEndpoint } from 'otto-server';

type ClientServerEndpoint = Pick<
  ServerEndpoint,
  'host' | 'port' | 'clientToken'
>;

/**
 * 为本机 OttoServer 构造受 client token 保护的 WS 地址。
 *
 * clientToken 仅允许建立 WS；权限更高的 controlToken 永远不会进入 renderer。
 * 对旧端点 fail closed，避免静默退回未鉴权的 `/ws`。
 */
export function serverWebSocketUrl(
  endpoint: ClientServerEndpoint,
): string {
  if (!endpoint.clientToken?.trim()) {
    throw new Error('本机 OttoServer 端点缺少 client token，请重启 Otto');
  }
  const host = formatWebSocketHost(endpoint.host);
  return `ws://${host}:${endpoint.port}/ws?clientToken=${
    encodeURIComponent(endpoint.clientToken)
  }`;
}

/** client token 轮换与 host/port 变化一样，必须主动关闭旧 WS 后重新鉴权。 */
export function serverEndpointChanged(
  current: ClientServerEndpoint | null,
  next: ClientServerEndpoint | null,
): boolean {
  return next?.host !== current?.host
    || next?.port !== current?.port
    || next?.clientToken !== current?.clientToken;
}

function formatWebSocketHost(host: string): string {
  const normalized = host.replace(/^\[|\]$/g, '');
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}
