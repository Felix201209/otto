/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import {
  canonicalLicenseCapabilityId,
  getLicenseCapabilityCatalog,
  getLicenseCapabilityFeatureMap,
  type OrganizationFeatureKey,
  type ProductModuleId,
} from '../productModules.js';

export type ModuleUpdateRollout = 'off' | 'canary' | 'stable' | 'required';

export interface ModuleUpdateDescriptor {
  module: string;
  version: string;
  rollout: ModuleUpdateRollout;
  notes: string;
  minAppVersion: string | null;
  manifestUrl: string | null;
  sha256: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface ModuleUpdateManifest {
  format: 'otto-module-updates-v1';
  deploymentId: string;
  generatedAt: string;
  modules: ModuleUpdateDescriptor[];
  catalog: Array<{
    module: string;
    productModuleId: ProductModuleId;
    features: OrganizationFeatureKey[];
  }>;
}

export const LICENSE_MODULE_FEATURES = getLicenseCapabilityFeatureMap({
  includeLegacyAliases: true,
});

export const MODULE_UPDATE_ROLLOUTS = new Set<ModuleUpdateRollout>([
  'off',
  'canary',
  'stable',
  'required',
]);

export const MODULE_UPDATE_SHA256_RE = /^[0-9a-f]{64}$/i;

export function licenseModuleCatalog(): Array<{
  module: string;
  productModuleId: ProductModuleId;
  features: OrganizationFeatureKey[];
}> {
  return getLicenseCapabilityCatalog();
}

export function parseModuleUpdateDescriptors(raw: string | null): ModuleUpdateDescriptor[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const result = new Map<string, ModuleUpdateDescriptor>();
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const module = typeof row.module === 'string'
        ? canonicalLicenseCapabilityId(row.module) ?? ''
        : '';
      const version = typeof row.version === 'string' ? row.version.trim() : '';
      const rollout = typeof row.rollout === 'string' && MODULE_UPDATE_ROLLOUTS.has(row.rollout as ModuleUpdateRollout)
        ? row.rollout as ModuleUpdateRollout
        : 'off';
      const updatedAt = typeof row.updatedAt === 'string' && row.updatedAt.trim()
        ? row.updatedAt.trim()
        : new Date(0).toISOString();
      if (!module || !version) continue;
      result.set(module, {
        module,
        version,
        rollout,
        notes: typeof row.notes === 'string' ? row.notes.slice(0, 2_000) : '',
        minAppVersion: typeof row.minAppVersion === 'string' && row.minAppVersion.trim()
          ? row.minAppVersion.trim()
          : null,
        manifestUrl: typeof row.manifestUrl === 'string' && row.manifestUrl.trim()
          ? row.manifestUrl.trim()
          : null,
        sha256: typeof row.sha256 === 'string' && MODULE_UPDATE_SHA256_RE.test(row.sha256)
          ? row.sha256.toLowerCase()
          : null,
        publishedAt: typeof row.publishedAt === 'string' && row.publishedAt.trim()
          ? row.publishedAt.trim()
          : null,
        updatedAt,
      });
    }
    return [...result.values()].sort((a, b) => a.module.localeCompare(b.module));
  } catch {
    return [];
  }
}
