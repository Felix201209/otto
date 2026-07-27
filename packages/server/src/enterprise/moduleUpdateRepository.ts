import type {
  ModuleUpdateDescriptor,
  ModuleUpdateManifest,
  ModuleUpdateRollout,
} from './moduleUpdateManifest.js';
import {
  MODULE_UPDATE_ROLLOUTS,
  MODULE_UPDATE_SHA256_RE,
  licenseModuleCatalog,
  parseModuleUpdateDescriptors,
} from './moduleUpdateManifest.js';
import { canonicalLicenseCapabilityId } from '../productModules.js';

const MODULE_UPDATE_MANIFEST_SETTING = 'module_update_manifest';

export interface ModuleUpdateRepositoryStore {
  readSetting(key: string): string | null;
  writeSetting(key: string, value: string): void;
  deploymentId(): string;
  audit(input: {
    event: string;
    employeeId: string | null;
    message: string;
    organizationId: string;
  }): void;
}

export interface ModuleUpdateDescriptorInput {
  module: string;
  version?: string;
  rollout?: ModuleUpdateRollout;
  notes?: string | null;
  minAppVersion?: string | null;
  manifestUrl?: string | null;
  sha256?: string | null;
  publishedAt?: string | null;
  actorAccountId?: string | null;
  organizationId: string;
}

export function getModuleUpdateManifestFromStore(
  store: ModuleUpdateRepositoryStore,
): ModuleUpdateManifest {
  return {
    format: 'otto-module-updates-v1',
    deploymentId: store.deploymentId(),
    generatedAt: new Date().toISOString(),
    modules: parseModuleUpdateDescriptors(store.readSetting(MODULE_UPDATE_MANIFEST_SETTING)),
    catalog: licenseModuleCatalog(),
  };
}

export function updateModuleUpdateDescriptorInStore(
  store: ModuleUpdateRepositoryStore,
  input: ModuleUpdateDescriptorInput,
): ModuleUpdateDescriptor {
  const module = canonicalLicenseCapabilityId(input.module);
  if (!module) throw new Error('未知模块');
  const current = new Map(
    getModuleUpdateManifestFromStore(store).modules.map((item) => [item.module, item]),
  );
  const existing = current.get(module);
  const rollout = input.rollout ?? existing?.rollout ?? 'stable';
  if (!MODULE_UPDATE_ROLLOUTS.has(rollout)) throw new Error('无效发布通道');
  const version = input.version?.trim() || existing?.version || '';
  if (!version) throw new Error('模块版本不能为空');
  const sha256 = input.sha256?.trim() || existing?.sha256 || null;
  if (sha256 && !MODULE_UPDATE_SHA256_RE.test(sha256)) {
    throw new Error('sha256 必须是 64 位十六进制');
  }
  const descriptor: ModuleUpdateDescriptor = {
    module,
    version,
    rollout,
    notes: input.notes == null ? existing?.notes ?? '' : input.notes.slice(0, 2_000),
    minAppVersion: input.minAppVersion == null
      ? existing?.minAppVersion ?? null
      : input.minAppVersion.trim() || null,
    manifestUrl: input.manifestUrl == null
      ? existing?.manifestUrl ?? null
      : input.manifestUrl.trim() || null,
    sha256: sha256 ? sha256.toLowerCase() : null,
    publishedAt: input.publishedAt == null
      ? existing?.publishedAt ?? new Date().toISOString()
      : input.publishedAt.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  if (rollout === 'off') current.delete(module);
  else current.set(module, descriptor);
  store.writeSetting(
    MODULE_UPDATE_MANIFEST_SETTING,
    JSON.stringify([...current.values()].sort((a, b) => a.module.localeCompare(b.module))),
  );
  store.audit({
    event: 'module_update_publish',
    employeeId: null,
    message: `Module update ${module}@${version} rollout=${rollout}`,
    organizationId: input.organizationId,
  });
  return descriptor;
}
