/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildRendererCsp } from './renderer-csp.js';

describe('desktop renderer CSP', () => {
  it('仅为远程员工头像放行 HTTPS 图片，不放宽脚本和网络请求', () => {
    const csp = buildRendererCsp('127.0.0.1', 7777);

    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(
      "connect-src 'self' http://127.0.0.1:7777 ws://127.0.0.1:7777",
    );
    expect(csp).not.toContain("script-src 'self' https:");
    expect(csp).not.toContain("connect-src 'self' https:");
  });
});
