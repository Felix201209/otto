/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PRODUCT_MODULE_IDS,
  PRODUCT_MODULES,
  canonicalLicenseCapabilityId,
  getLicenseCapabilityCatalog,
  validateProductModuleRegistry,
  type ProductModuleManifest,
} from './productModules.js';
import {
  licenseModuleCatalog,
  parseModuleUpdateDescriptors,
} from './modules/commercial_control/index.js';

function moduleDefinition(
  id: string,
  dependencies: readonly string[] = [],
): ProductModuleManifest {
  return {
    id,
    nameZh: id,
    description: `${id} module`,
    layer: 'business',
    runtimeSurfaces: ['server'],
    dependencies,
    dataOwnership: [],
    licenseCapabilities: [],
    updateComponents: [],
  };
}

describe('product module registry', () => {
  it('publishes the stable product module ids from one registry', () => {
    expect(PRODUCT_MODULES.map((module) => module.id)).toEqual(PRODUCT_MODULE_IDS);
    expect(() => validateProductModuleRegistry(PRODUCT_MODULES)).not.toThrow();
  });

  it('publishes canonical license capabilities and keeps legacy aliases read-compatible', () => {
    const catalog = getLicenseCapabilityCatalog();
    expect(catalog.map((entry) => entry.module)).toEqual([
      'enterprise_tree',
      'direct_messages',
      'atoa',
      'knowledge',
      'park_service',
      'feishu_auto_reply',
    ]);
    expect(catalog.map((entry) => entry.module)).not.toContain('tui_sync');
    expect(catalog.map((entry) => entry.module)).not.toContain('park_services');
    expect(canonicalLicenseCapabilityId('park_services')).toBe('park_service');
    expect(canonicalLicenseCapabilityId('feishu')).toBe('feishu_auto_reply');
    expect(canonicalLicenseCapabilityId('enterprise_memory')).toBe('knowledge');
    expect(canonicalLicenseCapabilityId('tui_sync')).toBeNull();
  });

  it('normalizes legacy update descriptors and never exposes aliases in the public catalog', () => {
    expect(licenseModuleCatalog()).toEqual(getLicenseCapabilityCatalog());
    expect(parseModuleUpdateDescriptors(JSON.stringify([
      {
        module: 'park_services',
        version: '1.9.8-park.1',
        rollout: 'stable',
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
    ]))).toEqual([
      expect.objectContaining({ module: 'park_service', version: '1.9.8-park.1' }),
    ]);
  });

  it('rejects duplicate, unknown, self-referencing and circular dependencies', () => {
    expect(() => validateProductModuleRegistry([
      moduleDefinition('one'),
      moduleDefinition('one'),
    ])).toThrow(/duplicate module id/i);
    expect(() => validateProductModuleRegistry([
      moduleDefinition('one', ['missing']),
    ])).toThrow(/unknown dependency/i);
    expect(() => validateProductModuleRegistry([
      moduleDefinition('one', ['one']),
    ])).toThrow(/cannot depend on itself/i);
    expect(() => validateProductModuleRegistry([
      moduleDefinition('one', ['two']),
      moduleDefinition('two', ['one']),
    ])).toThrow(/dependency cycle/i);
    expect(() => validateProductModuleRegistry([
      {
        ...moduleDefinition('one'),
        licenseCapabilities: [
          { id: 'canonical', features: [], legacyIds: ['canonical'] },
        ],
      },
    ])).toThrow(/alias collides with canonical id/i);
  });
});
