/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type ProductModuleLayer = 'runtime' | 'business' | 'platform' | 'surface' | 'integration';
export type ProductRuntimeSurface = 'core' | 'server' | 'desktop' | 'adapters';

export const ORGANIZATION_FEATURE_KEYS = [
  'enterprise_tree',
  'park_service',
  'feishu_auto_reply',
  'direct_messages',
  'atoa',
  'knowledge',
  'skill_market',
] as const;

export type OrganizationFeatureKey = (typeof ORGANIZATION_FEATURE_KEYS)[number];

export interface LicenseCapabilityManifest {
  id: string;
  features: readonly OrganizationFeatureKey[];
  legacyIds?: readonly string[];
}

export interface ProductModuleManifest {
  id: string;
  nameZh: string;
  description: string;
  layer: ProductModuleLayer;
  runtimeSurfaces: readonly ProductRuntimeSurface[];
  dependencies: readonly string[];
  dataOwnership: readonly string[];
  licenseCapabilities: readonly LicenseCapabilityManifest[];
  updateComponents: readonly string[];
}

export const PRODUCT_MODULES = [
  {
    id: 'agent_runtime',
    nameZh: '智能体运行内核',
    description: 'Owns turn lifecycle, context execution, tool scheduling, checkpoints and resource budgets.',
    layer: 'runtime',
    runtimeSurfaces: ['core', 'server'],
    dependencies: ['model_gateway', 'tool_skill_platform'],
    dataOwnership: ['runtime checkpoints', 'turn execution state'],
    licenseCapabilities: [],
    updateComponents: ['server_runtime_kernel'],
  },
  {
    id: 'model_gateway',
    nameZh: '模型接入中心',
    description: 'Owns provider capability detection, model routing and token usage normalization.',
    layer: 'runtime',
    runtimeSurfaces: ['core', 'server', 'adapters'],
    dependencies: ['data_platform'],
    dataOwnership: ['model configuration metadata', 'normalized token usage'],
    licenseCapabilities: [],
    updateComponents: ['model_catalog'],
  },
  {
    id: 'tool_skill_platform',
    nameZh: '工具与技能中心',
    description: 'Owns tool registration, skill discovery, generated skills and confirmation contracts.',
    layer: 'runtime',
    runtimeSurfaces: ['core', 'desktop'],
    dependencies: [],
    dataOwnership: ['skill manifests', 'tool registration metadata'],
    licenseCapabilities: [],
    updateComponents: ['skills'],
  },
  {
    id: 'personal_intelligence',
    nameZh: '个人智能中心',
    description: 'Owns personal memory, worklogs, habit learning and account-scoped restoration.',
    layer: 'business',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['agent_runtime', 'identity_organization', 'data_platform'],
    dataOwnership: ['personal memory', 'worklogs', 'auto skills', 'account sync snapshots'],
    licenseCapabilities: [],
    updateComponents: ['personal_memory'],
  },
  {
    id: 'document_experts',
    nameZh: '文档专家中心',
    description: 'Owns document, meeting and data-analysis expert workflows.',
    layer: 'business',
    runtimeSurfaces: ['core', 'desktop'],
    dependencies: ['agent_runtime', 'tool_skill_platform'],
    dataOwnership: ['expert workflow templates', 'document generation metadata'],
    licenseCapabilities: [],
    updateComponents: ['document_experts'],
  },
  {
    id: 'identity_organization',
    nameZh: '身份与组织管理',
    description: 'Owns accounts, sessions, organizations, departments, positions and invitations.',
    layer: 'business',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['data_platform'],
    dataOwnership: ['accounts', 'sessions', 'organizations', 'departments', 'positions', 'invites'],
    licenseCapabilities: [{ id: 'enterprise_tree', features: ['enterprise_tree', 'knowledge'] }],
    updateComponents: ['enterprise_tree'],
  },
  {
    id: 'authorization',
    nameZh: '权限管理中心',
    description: 'Owns fail-closed permission decisions for platform, enterprise and park roles.',
    layer: 'platform',
    runtimeSurfaces: ['core', 'server', 'desktop'],
    dependencies: ['identity_organization'],
    dataOwnership: ['permission policies', 'role assignments'],
    licenseCapabilities: [],
    updateComponents: ['authorization_policy'],
  },
  {
    id: 'secure_messaging',
    nameZh: '端到端加密通信',
    description: 'Owns account trust roots, device credentials, MLS key packages, signed device lifecycle proofs and key transparency.',
    layer: 'platform',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['identity_organization', 'authorization', 'data_platform'],
    dataOwnership: [
      'E2EE account trust roots',
      'device credentials',
      'MLS key packages',
      'signed device approval and revocation proofs',
      'key transparency checkpoints',
    ],
    licenseCapabilities: [],
    updateComponents: ['secure_messaging'],
  },
  {
    id: 'collaboration',
    nameZh: '企业协作中心',
    description: 'Owns direct messages, attachments, unread state, presence and A2A collaboration.',
    layer: 'business',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: [
      'identity_organization',
      'authorization',
      'secure_messaging',
      'data_platform',
    ],
    dataOwnership: ['direct messages', 'message attachments', 'presence', 'A2A requests'],
    licenseCapabilities: [
      { id: 'direct_messages', features: ['direct_messages'] },
      { id: 'atoa', features: ['atoa'] },
    ],
    updateComponents: ['collaboration'],
  },
  {
    id: 'enterprise_knowledge',
    nameZh: '企业知识中心',
    description: 'Owns enterprise knowledge, scoped retrieval and knowledge audit metadata.',
    layer: 'business',
    runtimeSurfaces: ['core', 'server', 'desktop'],
    dependencies: ['identity_organization', 'authorization', 'data_platform'],
    dataOwnership: ['enterprise knowledge', 'knowledge scopes'],
    licenseCapabilities: [
      { id: 'knowledge', features: ['knowledge'], legacyIds: ['enterprise_memory'] },
    ],
    updateComponents: ['enterprise_knowledge'],
  },
  {
    id: 'enterprise_skill_market',
    nameZh: '企业技能市场',
    description: 'Owns governed skill sharing, review, installation, feedback and evidence-based rankings.',
    layer: 'business',
    runtimeSurfaces: ['core', 'server', 'desktop'],
    dependencies: ['tool_skill_platform', 'identity_organization', 'authorization', 'data_platform'],
    dataOwnership: ['shared skill manifests', 'skill versions', 'install records', 'ratings', 'usage evidence'],
    licenseCapabilities: [
      { id: 'skill_market', features: ['skill_market'] },
    ],
    updateComponents: ['enterprise_skill_market'],
  },
  {
    id: 'park_services',
    nameZh: '产业园服务中心',
    description: 'Owns park certification, tenant membership, publications, service tickets and statistics.',
    layer: 'business',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['identity_organization', 'authorization', 'collaboration', 'data_platform'],
    dataOwnership: [
      'parks',
      'park tenants',
      'park publications',
      'park resources',
      'park reservations',
      'park services',
      'park tickets',
      'park statistics',
    ],
    licenseCapabilities: [
      { id: 'park_service', features: ['park_service'], legacyIds: ['park_services'] },
    ],
    updateComponents: ['park_services'],
  },
  {
    id: 'data_platform',
    nameZh: '数据存储中心',
    description: 'Owns persistence contracts, encryption, migrations, backup and object storage boundaries.',
    layer: 'platform',
    runtimeSurfaces: ['core', 'server', 'desktop'],
    dependencies: [],
    dataOwnership: ['database migrations', 'encryption keys', 'backup metadata', 'object metadata'],
    licenseCapabilities: [],
    updateComponents: ['storage_runtime'],
  },
  {
    id: 'commercial_control',
    nameZh: '商业授权中心',
    description: 'Owns deployment identity, licenses, seats, telemetry, diagnostics, audit and updates.',
    layer: 'platform',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['identity_organization', 'authorization', 'data_platform'],
    dataOwnership: [
      'deployment license',
      'telemetry queue',
      'module update manifest',
      'audit events',
      'credit ledger',
      'redeem codes',
    ],
    licenseCapabilities: [],
    updateComponents: ['commercial_control'],
  },
  {
    id: 'data_governance',
    nameZh: '数据治理与合规中心',
    description: 'Owns legal document versions, consent evidence, processing inventory, data export, deletion and retention controls.',
    layer: 'platform',
    runtimeSurfaces: ['server', 'desktop'],
    dependencies: ['identity_organization', 'authorization', 'data_platform', 'commercial_control'],
    dataOwnership: [
      'legal document versions',
      'consent records',
      'processing inventory',
      'privacy requests',
      'deletion receipts',
      'deletion tombstones',
    ],
    licenseCapabilities: [],
    updateComponents: ['data_governance'],
  },
  {
    id: 'desktop_shell',
    nameZh: '桌面应用外壳',
    description: 'Owns Electron windows, tray, native notifications, file selection and update UX.',
    layer: 'surface',
    runtimeSurfaces: ['desktop'],
    dependencies: [
      'agent_runtime',
      'personal_intelligence',
      'document_experts',
      'collaboration',
      'park_services',
      'commercial_control',
      'data_governance',
    ],
    dataOwnership: ['desktop preferences', 'local session envelope', 'downloaded update state'],
    licenseCapabilities: [],
    updateComponents: ['renderer_css', 'desktop_shell'],
  },
  {
    id: 'integration_adapters',
    nameZh: '外部服务接入中心',
    description: 'Owns Feishu, third-party service and replaceable provider adapters.',
    layer: 'integration',
    runtimeSurfaces: ['core', 'server', 'desktop', 'adapters'],
    dependencies: ['model_gateway', 'identity_organization', 'authorization'],
    dataOwnership: ['integration credentials', 'external tenant bindings'],
    licenseCapabilities: [
      { id: 'feishu_auto_reply', features: ['feishu_auto_reply'], legacyIds: ['feishu'] },
    ],
    updateComponents: ['integration_adapters'],
  },
] as const satisfies readonly ProductModuleManifest[];

export type ProductModuleId = (typeof PRODUCT_MODULES)[number]['id'];
export const PRODUCT_MODULE_IDS: readonly ProductModuleId[] = PRODUCT_MODULES.map(
  (module) => module.id,
);

export function validateProductModuleRegistry(
  modules: readonly ProductModuleManifest[],
): void {
  const byId = new Map<string, ProductModuleManifest>();
  const capabilityIds = new Set<string>();
  const capabilityAliases = new Set<string>();
  const featureKeys = new Set<string>(ORGANIZATION_FEATURE_KEYS);

  for (const module of modules) {
    if (!module.id || byId.has(module.id)) {
      throw new Error(`duplicate module id: ${module.id || '<empty>'}`);
    }
    byId.set(module.id, module);
    for (const capability of module.licenseCapabilities) {
      if (!capability.id || capabilityIds.has(capability.id)) {
        throw new Error(`duplicate license capability id: ${capability.id || '<empty>'}`);
      }
      capabilityIds.add(capability.id);
      for (const feature of capability.features) {
        if (!featureKeys.has(feature)) {
          throw new Error(`unknown organization feature: ${feature}`);
        }
      }
      for (const alias of capability.legacyIds ?? []) {
        if (!alias || capabilityAliases.has(alias)) {
          throw new Error(`duplicate license capability alias: ${alias || '<empty>'}`);
        }
        capabilityAliases.add(alias);
      }
    }
  }

  for (const alias of capabilityAliases) {
    if (capabilityIds.has(alias)) {
      throw new Error(`license capability alias collides with canonical id: ${alias}`);
    }
  }

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      if (dependency === module.id) {
        throw new Error(`module ${module.id} cannot depend on itself`);
      }
      if (!byId.has(dependency)) {
        throw new Error(`unknown dependency ${dependency} for module ${module.id}`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      throw new Error(`module dependency cycle: ${[...path.slice(cycleStart), id].join(' -> ')}`);
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

validateProductModuleRegistry(PRODUCT_MODULES);

interface LicenseCapabilityEntry {
  moduleId: ProductModuleId;
  capability: LicenseCapabilityManifest;
}

const capabilityEntries: LicenseCapabilityEntry[] = PRODUCT_MODULES.flatMap((module) =>
  (module.licenseCapabilities as readonly LicenseCapabilityManifest[]).map((capability) => ({
    moduleId: module.id as ProductModuleId,
    capability,
  })),
);
const capabilityById = new Map<string, LicenseCapabilityEntry>(
  capabilityEntries.map((entry) => [entry.capability.id, entry]),
);
const capabilityByAlias = new Map<string, LicenseCapabilityEntry>(
  capabilityEntries.flatMap((entry) =>
    (entry.capability.legacyIds ?? []).map((alias) => [alias, entry] as const)),
);

export function canonicalLicenseCapabilityId(value: string): string | null {
  const normalized = value.trim();
  return capabilityById.get(normalized)?.capability.id
    ?? capabilityByAlias.get(normalized)?.capability.id
    ?? null;
}

export function getLicenseCapabilityFeatures(
  value: string,
): readonly OrganizationFeatureKey[] | null {
  const canonical = canonicalLicenseCapabilityId(value);
  return canonical ? capabilityById.get(canonical)?.capability.features ?? null : null;
}

export function getLicenseCapabilityCatalog(): Array<{
  module: string;
  productModuleId: ProductModuleId;
  features: OrganizationFeatureKey[];
}> {
  return capabilityEntries.map(({ moduleId, capability }) => ({
    module: capability.id,
    productModuleId: moduleId,
    features: [...capability.features],
  }));
}

export function getLicenseCapabilityFeatureMap(
  options: { includeLegacyAliases?: boolean } = {},
): Record<string, OrganizationFeatureKey[]> {
  const result: Record<string, OrganizationFeatureKey[]> = {};
  for (const { capability } of capabilityEntries) {
    result[capability.id] = [...capability.features];
    if (options.includeLegacyAliases) {
      for (const alias of capability.legacyIds ?? []) {
        result[alias] = [...capability.features];
      }
    }
  }
  return result;
}
