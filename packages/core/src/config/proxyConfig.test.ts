/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildProxyRequestUrl,
  isProxyServerConfigured,
} from './proxyConfig.js';

describe('Otto 托管模型服务地址', () => {
  it('未配置服务地址时在发出 fetch 前给出可读错误', () => {
    expect(isProxyServerConfigured('')).toBe(false);
    expect(() => buildProxyRequestUrl('', '/v1/chat/stream')).toThrow(
      '企业模型服务尚未配置，请联系企业管理员。',
    );
  });

  it('拒绝非法地址，不把相对路径交给 Node fetch', () => {
    expect(isProxyServerConfigured('/relative')).toBe(false);
    expect(() =>
      buildProxyRequestUrl('/relative', '/v1/chat/stream'),
    ).toThrow('企业模型服务地址无效，请联系企业管理员。');
  });

  it('规范拼接 http(s) 服务地址与 API 路径', () => {
    expect(isProxyServerConfigured('https://api.otto.example/')).toBe(true);
    expect(
      buildProxyRequestUrl(
        'https://api.otto.example/',
        '/v1/chat/stream',
      ),
    ).toBe('https://api.otto.example/v1/chat/stream');
  });
});
