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
  validateClientPayload,
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

describe('validateClientPayload 形状校验（第二道闸）', () => {
  it('合法 send_user_message → null（通过）', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'hi' }],
          source: 'local',
        },
      }),
    ).toBeNull();
  });

  it('send_user_message：content 传字符串 / null / 对象 → 拒绝', () => {
    for (const content of ['不是数组', null, { type: 'text', value: 'x' }]) {
      expect(
        validateClientPayload({
          type: 'send_user_message',
          payload: { sessionId: 's1', content, source: 'local' },
        }),
      ).not.toBeNull();
    }
  });

  it('send_user_message：content 数组内片段畸形 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 42 }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: { sessionId: 's1', content: [null], source: 'local' },
      }),
    ).not.toBeNull();
  });

  it('send_user_message：sessionId 空 / source 非法 → 拒绝', () => {
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: '',
          content: [{ type: 'text', value: 'x' }],
          source: 'local',
        },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'send_user_message',
        payload: {
          sessionId: 's1',
          content: [{ type: 'text', value: 'x' }],
          source: 'evil',
        },
      }),
    ).not.toBeNull();
  });

  it('未知 type → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'nope_type', payload: {} }),
    ).not.toBeNull();
  });

  it('subscribe / cancel / set_model：sessionId 缺失或非字符串 → 拒绝', () => {
    expect(
      validateClientPayload({ type: 'subscribe', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'cancel', payload: { sessionId: 1 } }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'set_model',
        payload: { sessionId: 's1', model: 'm1' },
      }),
    ).toBeNull();
  });

  it('save_custom_model：必填字段缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: { baseUrl: 'https://x', apiKey: 'k', modelId: 'm' },
      }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'save_custom_model',
        payload: {
          provider: 'openai',
          baseUrl: 'https://x',
          apiKey: 'k',
          modelId: 'm',
        },
      }),
    ).toBeNull();
  });

  it('delete_session：sessionId 缺失 → 拒绝；齐全 → 通过', () => {
    expect(
      validateClientPayload({ type: 'delete_session', payload: {} }),
    ).not.toBeNull();
    expect(
      validateClientPayload({
        type: 'delete_session',
        payload: { sessionId: 's1' },
      }),
    ).toBeNull();
  });

  it('rename_session：sessionId/title 校验（空白 title 拒绝，齐全通过）', () => {
    // sessionId 缺失
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { title: '新名' },
      }),
    ).not.toBeNull();
    // title 非字符串
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: 42 },
      }),
    ).not.toBeNull();
    // title 纯空白
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '   ' },
      }),
    ).not.toBeNull();
    // 齐全通过
    expect(
      validateClientPayload({
        type: 'rename_session',
        payload: { sessionId: 's1', title: '新名' },
      }),
    ).toBeNull();
  });

  it('payload 非对象（null / 字符串）→ 拒绝', () => {
    expect(
      validateClientPayload({ type: 'list_sessions', payload: null }),
    ).not.toBeNull();
    expect(
      validateClientPayload({ type: 'get_history', payload: 'x' }),
    ).not.toBeNull();
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
