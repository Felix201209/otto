/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 协议守卫与常量单测。isClientToServer 是 WS 入站第一道闸，边界必须全覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  isClientToServer,
  frame,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  DEFAULT_PORT,
  DEFAULT_HOST,
  type ServerToClient,
} from './protocol.js';

describe('isClientToServer 守卫', () => {
  it('合法 {type,payload} → true', () => {
    expect(isClientToServer({ type: 'list_sessions', payload: {} })).toBe(true);
    expect(
      isClientToServer({ type: 'subscribe', payload: { sessionId: 'x' } }),
    ).toBe(true);
  });

  it('null / undefined → false', () => {
    expect(isClientToServer(null)).toBe(false);
    expect(isClientToServer(undefined)).toBe(false);
  });

  it('字符串 / 数字 / 数组 → false', () => {
    expect(isClientToServer('hello')).toBe(false);
    expect(isClientToServer(42)).toBe(false);
    // 数组是 object，但其 .type 为 undefined（非 string），故守卫判 false。
    expect(isClientToServer([{ type: 'x', payload: {} }])).toBe(false);
    expect(isClientToServer(['a', 'b'])).toBe(false);
    expect(isClientToServer([])).toBe(false);
  });

  it('缺 type → false', () => {
    expect(isClientToServer({ payload: {} })).toBe(false);
  });

  it('缺 payload → false', () => {
    expect(isClientToServer({ type: 'list_sessions' })).toBe(false);
  });

  it('type 非 string → false', () => {
    expect(isClientToServer({ type: 123, payload: {} })).toBe(false);
    expect(isClientToServer({ type: null, payload: {} })).toBe(false);
  });
});

describe('frame 构造器', () => {
  it('恒等返回入参', () => {
    const f: ServerToClient = {
      type: 'welcome',
      payload: { protocolVersion: '1', serverVersion: '0.1.0' },
    };
    expect(frame(f)).toBe(f);
  });
});

describe('HTTP_ROUTES 与常量', () => {
  it('sessionHistory 拼串正确', () => {
    expect(HTTP_ROUTES.sessionHistory('abc')).toBe('/sessions/abc/history');
  });

  it('静态路由值', () => {
    expect(HTTP_ROUTES.health).toBe('/health');
    expect(HTTP_ROUTES.sessions).toBe('/sessions');
    expect(HTTP_ROUTES.models).toBe('/models');
    expect(HTTP_ROUTES.ws).toBe('/ws');
  });

  it('PROTOCOL_VERSION / DEFAULT_PORT / DEFAULT_HOST 冒烟', () => {
    expect(PROTOCOL_VERSION).toBe('1');
    expect(DEFAULT_PORT).toBe(7637);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });
});
