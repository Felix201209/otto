/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { EnterpriseOrganizationFeatures } from '../../preload/index.js';

interface FeatureCacheEntry {
  value?: EnterpriseOrganizationFeatures;
  inFlight?: Promise<EnterpriseOrganizationFeatures>;
}

const featureCache = new Map<string, FeatureCacheEntry>();

/**
 * 按中心组织缓存功能开关。需要执行企业侧副作用的调用方应传 force=true，
 * 先刷新权限再写入；纯展示可以复用同组织最近一次成功快照。
 */
export async function getEnterpriseOrganizationFeatures(
  organizationId: string,
  options: { force?: boolean } = {},
): Promise<EnterpriseOrganizationFeatures> {
  const key = organizationId.trim();
  if (!key) throw new Error('缺少企业组织标识');

  const cached = featureCache.get(key);
  if (cached?.inFlight) return cached.inFlight;
  if (!options.force && cached?.value) return cached.value;

  const inFlight = window.otto.enterpriseOrganizationFeaturesGet()
    .then((features) => {
      featureCache.set(key, { value: features });
      return features;
    })
    .catch((error: unknown) => {
      // 请求失败时不保留可能过期的 true，后续操作继续 fail closed。
      featureCache.delete(key);
      throw error;
    });
  featureCache.set(key, { value: cached?.value, inFlight });
  return inFlight;
}

export function clearEnterpriseOrganizationFeaturesCache(
  organizationId?: string,
): void {
  if (organizationId) {
    featureCache.delete(organizationId.trim());
    return;
  }
  featureCache.clear();
}
