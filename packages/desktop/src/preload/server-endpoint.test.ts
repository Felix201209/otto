/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  serverEndpointChanged,
  serverWebSocketUrl,
} from './server-endpoint.js';

describe('serverWebSocketUrl', () => {
  it('把独立 client token 编码进 WS query，且不改变连接端点', () => {
    expect(serverWebSocketUrl({
      host: '127.0.0.1',
      port: 7_637,
      clientToken: 'desktop/+ token?&=值',
    })).toBe(
      'ws://127.0.0.1:7637/ws?clientToken=desktop%2F%2B%20token%3F%26%3D%E5%80%BC',
    );
  });

  it('拒绝旧端点或空 token，绝不退回无鉴权 WS', () => {
    expect(() => serverWebSocketUrl({
      host: '127.0.0.1',
      port: 7_637,
      clientToken: '   ',
    })).toThrow('缺少 client token');
  });
});

describe('serverEndpointChanged', () => {
  it('host/port 不变但 client token 轮换时也要求主动重连', () => {
    const current = {
      host: '127.0.0.1',
      port: 7_637,
      clientToken: 'old-client-token',
    };

    expect(serverEndpointChanged(current, {
      ...current,
      clientToken: 'new-client-token',
    })).toBe(true);
    expect(serverEndpointChanged(current, { ...current })).toBe(false);
  });
});
