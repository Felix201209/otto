/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseOrganizationFeatures } from '../../preload/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearEnterpriseOrganizationFeaturesCache,
  getEnterpriseOrganizationFeatures,
} from './enterpriseOrganizationFeatures.js';

const FEATURES: EnterpriseOrganizationFeatures = {
  enterprise_tree: true,
  park_service: false,
  feishu_auto_reply: false,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: false,
};

afterEach(() => {
  clearEnterpriseOrganizationFeaturesCache();
  vi.restoreAllMocks();
});

describe('enterprise organization feature cache', () => {
  it('rejects an empty organization id before requesting server permissions', async () => {
    const request = vi.fn(async () => FEATURES);
    Object.assign(window.otto, { enterpriseOrganizationFeaturesGet: request });

    await expect(getEnterpriseOrganizationFeatures('  ')).rejects.toThrow(
      '缺少企业组织标识',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('deduplicates in-flight requests, caches successes and supports forced refresh', async () => {
    let resolveRequest!: (value: EnterpriseOrganizationFeatures) => void;
    const firstRequest = new Promise<EnterpriseOrganizationFeatures>(
      (resolve) => {
        resolveRequest = resolve;
      },
    );
    const request = vi
      .fn()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValue(FEATURES);
    Object.assign(window.otto, { enterpriseOrganizationFeaturesGet: request });

    const first = getEnterpriseOrganizationFeatures(' org-1 ');
    const concurrent = getEnterpriseOrganizationFeatures('org-1');
    expect(request).toHaveBeenCalledOnce();
    resolveRequest(FEATURES);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      FEATURES,
      FEATURES,
    ]);

    await expect(getEnterpriseOrganizationFeatures('org-1')).resolves.toBe(
      FEATURES,
    );
    expect(request).toHaveBeenCalledOnce();
    await expect(
      getEnterpriseOrganizationFeatures('org-1', { force: true }),
    ).resolves.toBe(FEATURES);
    expect(request).toHaveBeenCalledTimes(2);

    clearEnterpriseOrganizationFeaturesCache(' org-1 ');
    await getEnterpriseOrganizationFeatures('org-1');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('drops a failed request so the next attempt can recover', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(FEATURES);
    Object.assign(window.otto, { enterpriseOrganizationFeaturesGet: request });

    await expect(getEnterpriseOrganizationFeatures('org-2')).rejects.toThrow(
      'offline',
    );
    await expect(getEnterpriseOrganizationFeatures('org-2')).resolves.toBe(
      FEATURES,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
