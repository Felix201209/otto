/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildProxyRequestUrl,
  isProxyServerConfigured,
} from './proxyConfig.js';

describe('模型服务地址兜底', () => {
  it('未配置服务地址时在发出 fetch 前给出可读错误', () => {
    expect(isProxyServerConfigured('')).toBe(false);
    expect(() => buildProxyRequestUrl('', '/v1/chat/stream')).toThrow(
      '模型服务地址尚未配置，请先绑定个人 API。',
    );
  });

  it('拒绝非法地址，不把相对路径交给 Node fetch', () => {
    expect(isProxyServerConfigured('/relative')).toBe(false);
    expect(() =>
      buildProxyRequestUrl('/relative', '/v1/chat/stream'),
    ).toThrow('模型服务地址无效，请检查个人 API 配置。');
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
