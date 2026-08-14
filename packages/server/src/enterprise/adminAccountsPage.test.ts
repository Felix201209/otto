/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { adminAccountsHTML } from './adminAccountsPage.js';

describe('enterprise admin operations security page', () => {
  it('shows each security subsystem and emits syntactically valid page JavaScript', () => {
    const html = adminAccountsHTML();

    expect(html).toContain('运维安全状态');
    expect(html).toContain('SQLCipher');
    expect(html).toContain('PostgreSQL');
    expect(html).toContain('附件对象存储');
    expect(html).toContain('共享缓存');
    expect(html).toContain('KMS/HSM');
    expect(html).toContain('密钥轮换');
    const script = html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script ?? '')).not.toThrow();
  });
});
