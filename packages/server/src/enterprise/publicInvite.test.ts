/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业公开引入链接：公网基址必须显式可信，不能从任意 Host 头拼接。
 */

import { describe, expect, it } from 'vitest';
import {
  buildOrganizationInviteLink,
  DEFAULT_ENTERPRISE_PUBLIC_URL,
  resolveEnterprisePublicBaseUrl,
} from './publicInvite.js';

describe('企业公开引入链接', () => {
  it('使用显式 HTTPS 公网基址并保留部署路径前缀', () => {
    const baseUrl = resolveEnterprisePublicBaseUrl({
      configuredUrl: 'https://join.otto.example/otto/',
      host: '0.0.0.0',
      port: 7777,
    });

    expect(baseUrl).toBe('https://join.otto.example/otto');
    expect(buildOrganizationInviteLink(baseUrl, 'ABCD-2345'))
      .toBe('https://join.otto.example/otto/enterprise/join/ABCD-2345');
  });

  it('拒绝非 HTTP(S)、凭据、query 与 fragment，避免生成可伪装链接', () => {
    for (const configuredUrl of [
      'javascript:alert(1)',
      'ftp://join.otto.example',
      'https://user:pass@join.otto.example',
      'https://join.otto.example?next=https://evil.example',
      'https://join.otto.example/#evil',
    ]) {
      expect(() => resolveEnterprisePublicBaseUrl({
        configuredUrl,
        host: '127.0.0.1',
        port: 7777,
      }), configuredUrl).toThrow(/OTTO_ENTERPRISE_PUBLIC_URL/);
    }
  });

  it('未配置时使用经过确认的 Otto 公网基址，而不是监听地址或请求 Host', () => {
    expect(DEFAULT_ENTERPRISE_PUBLIC_URL).toBe('https://59.110.154.44:7777');
    expect(resolveEnterprisePublicBaseUrl({ host: '127.0.0.1', port: 7777 }))
      .toBe(DEFAULT_ENTERPRISE_PUBLIC_URL);
    expect(resolveEnterprisePublicBaseUrl({ host: '0.0.0.0', port: 9999 }))
      .toBe(DEFAULT_ENTERPRISE_PUBLIC_URL);
  });

  it('只接受规范的 8 位企业邀请码', () => {
    expect(() => buildOrganizationInviteLink('https://join.otto.example', '../admin'))
      .toThrow(/邀请码格式/);
    expect(() => buildOrganizationInviteLink('https://join.otto.example', 'ABCI-2345'))
      .toThrow(/邀请码格式/);
  });
});
