/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseNetworkFetch,
  internalTestEnterpriseSession,
} from './enterprise-network-policy.js';

describe('enterprise network policy', () => {
  it('内测免登录模式仍允许显式企业认证请求使用真实传输', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const guardedFetch = createEnterpriseNetworkFetch(
      fetchImpl as unknown as typeof fetch,
      true,
    );

    await expect(guardedFetch('https://enterprise.example.com/enterprise/health'))
      .resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('delegates to the real transport when internal-test mode is disabled', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const guardedFetch = createEnterpriseNetworkFetch(
      fetchImpl as unknown as typeof fetch,
      false,
    );

    await expect(guardedFetch('https://enterprise.example.com/health'))
      .resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('内测免登录模式不再覆盖已经持久化的真实企业会话', () => {
    expect(internalTestEnterpriseSession('https://enterprise.example.com', true))
      .toBeNull();
    expect(internalTestEnterpriseSession('https://enterprise.example.com', false))
      .toBeNull();
  });
});
