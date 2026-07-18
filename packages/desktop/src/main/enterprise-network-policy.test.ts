/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createEnterpriseNetworkFetch,
  internalTestEnterpriseSession,
} from './enterprise-network-policy.js';

describe('enterprise network policy', () => {
  it('fails closed without transmitting enterprise data in internal-test mode', async () => {
    const fetchImpl = vi.fn();
    const guardedFetch = createEnterpriseNetworkFetch(
      fetchImpl as unknown as typeof fetch,
      true,
    );

    await expect(guardedFetch('https://enterprise.example.com/enterprise/usage'))
      .rejects.toThrow('内部测试模式已停用企业网络访问');
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('ignores, but does not delete, a persisted token in internal-test mode', () => {
    expect(internalTestEnterpriseSession('https://enterprise.example.com', true))
      .toEqual({
        serverUrl: 'https://enterprise.example.com',
        token: null,
      });
    expect(internalTestEnterpriseSession('https://enterprise.example.com', false))
      .toBeNull();
  });
});
