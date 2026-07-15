/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decodeEnterpriseSession,
  encodeEnterpriseSession,
} from './enterprise-session-store.js';

describe('企业登录态持久化', () => {
  it('保存加密 token，并在 App 再次启动时恢复同一会话', () => {
    const encoded = encodeEnterpriseSession(
      { serverUrl: 'https://59.110.154.44:7777', token: 'session-token' },
      (token) => Buffer.from(`sealed:${token}`).toString('base64'),
    );
    expect(encoded).not.toContain('session-token');

    const restored = decodeEnterpriseSession(
      encoded,
      'https://59.110.154.44:7777',
      (encrypted) => Buffer.from(encrypted, 'base64').toString('utf8').replace(/^sealed:/, ''),
    );
    expect(restored).toEqual({
      serverUrl: 'https://59.110.154.44:7777',
      token: 'session-token',
    });
  });

  it('文件损坏或无法解密时安全回到内置服务器的未登录状态', () => {
    expect(decodeEnterpriseSession('{bad json', 'https://enterprise.otto.test', () => 'x'))
      .toEqual({ serverUrl: 'https://enterprise.otto.test', token: null });
    expect(decodeEnterpriseSession(
      JSON.stringify({ serverUrl: 'https://enterprise.otto.test', encryptedToken: 'broken' }),
      'https://enterprise.otto.test',
      () => { throw new Error('keychain unavailable'); },
    )).toEqual({ serverUrl: 'https://enterprise.otto.test', token: null });
  });
});
