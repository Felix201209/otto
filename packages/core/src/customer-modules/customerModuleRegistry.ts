import {
  parseCustomerModuleManifest,
  type CustomerModuleManifestV1,
  type CustomerModulePermission,
} from './customerModuleManifest.js';

export interface InstalledCustomerModule {
  moduleId: string;
  version: string;
  manifest: CustomerModuleManifestV1;
  enabled: boolean;
  approvedPermissions: CustomerModulePermission[];
  backgroundEnabled: boolean;
  installedAt: string;
  pendingUpgrade?: { version: string; manifest: CustomerModuleManifestV1; stagedAt: string };
  suspendedReason?: string;
}

export interface CustomerModuleRegistryStore {
  list(): Promise<InstalledCustomerModule[]>;
  put(record: InstalledCustomerModule): Promise<void>;
  remove(moduleId: string): Promise<void>;
  clearData(moduleId: string): Promise<void>;
}

function permissionKey(permission: CustomerModulePermission): string {
  return JSON.stringify(permission, Object.keys(permission).sort());
}

export class CustomerModuleRegistry {
  constructor(
    private readonly store: CustomerModuleRegistryStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly verifySignature: (manifest: CustomerModuleManifestV1) => boolean = () => false,
  ) {}

  async list(): Promise<InstalledCustomerModule[]> {
    return this.store.list();
  }

  async get(moduleId: string): Promise<InstalledCustomerModule | null> {
    return (await this.store.list()).find((record) => record.moduleId === moduleId) ?? null;
  }

  permissionDiff(
    current: readonly CustomerModulePermission[],
    next: readonly CustomerModulePermission[],
  ): { added: CustomerModulePermission[]; removed: CustomerModulePermission[] } {
    const currentKeys = new Set(current.map(permissionKey));
    const nextKeys = new Set(next.map(permissionKey));
    return {
      added: next.filter((permission) => !currentKeys.has(permissionKey(permission))),
      removed: current.filter((permission) => !nextKeys.has(permissionKey(permission))),
    };
  }

  async stageInstall(rawManifest: unknown): Promise<InstalledCustomerModule> {
    const manifest = parseCustomerModuleManifest(rawManifest);
    if (!this.verifySignature(manifest)) throw new Error('customer module marketplace signature is not trusted');
    const current = await this.get(manifest.id);
    if (current) {
      const staged = {
        ...current,
        pendingUpgrade: { version: manifest.version, manifest, stagedAt: this.now() },
      };
      await this.store.put(staged);
      return staged;
    }
    const record: InstalledCustomerModule = {
      moduleId: manifest.id,
      version: manifest.version,
      manifest,
      enabled: false,
      approvedPermissions: [],
      backgroundEnabled: false,
      installedAt: this.now(),
    };
    await this.store.put(record);
    return record;
  }

  async approveAndEnable(
    moduleId: string,
    version: string,
    approvedPermissions: readonly CustomerModulePermission[],
  ): Promise<InstalledCustomerModule> {
    const record = await this.get(moduleId);
    if (!record) throw new Error('customer module version is not staged');
    const targetManifest = record.pendingUpgrade?.version === version
      ? record.pendingUpgrade.manifest
      : record.version === version ? record.manifest : null;
    if (!targetManifest) throw new Error('customer module version is not staged');
    const declared = new Set(targetManifest.permissions.map(permissionKey));
    const approved = new Set(approvedPermissions.map(permissionKey));
    if (declared.size !== approved.size || [...declared].some((permission) => !approved.has(permission))) {
      throw new Error('all declared customer module permissions require explicit approval');
    }
    const next = {
      ...record,
      version: targetManifest.version,
      manifest: targetManifest,
      enabled: true,
      approvedPermissions: [...approvedPermissions],
      pendingUpgrade: undefined,
    };
    await this.store.put(next);
    return next;
  }

  async suspend(moduleId: string, reason: string): Promise<void> {
    const record = await this.get(moduleId);
    if (!record) return;
    await this.store.put({ ...record, enabled: false, backgroundEnabled: false, suspendedReason: reason });
  }

  async uninstall(moduleId: string): Promise<void> {
    await this.store.remove(moduleId);
  }

  async clearData(moduleId: string): Promise<void> {
    await this.store.clearData(moduleId);
  }
}

export class InMemoryCustomerModuleRegistryStore implements CustomerModuleRegistryStore {
  private readonly records = new Map<string, InstalledCustomerModule>();
  private readonly data = new Map<string, Map<string, string>>();

  async list(): Promise<InstalledCustomerModule[]> {
    return [...this.records.values()];
  }

  async put(record: InstalledCustomerModule): Promise<void> {
    this.records.set(record.moduleId, record);
  }

  async remove(moduleId: string): Promise<void> {
    this.records.delete(moduleId);
  }

  async clearData(moduleId: string): Promise<void> {
    this.data.delete(moduleId);
  }

  async writeData(moduleId: string, key: string, value: string): Promise<void> {
    const scoped = this.data.get(moduleId) ?? new Map<string, string>();
    scoped.set(key, value);
    this.data.set(moduleId, scoped);
  }

  async readData(moduleId: string, key: string): Promise<string | null> {
    return this.data.get(moduleId)?.get(key) ?? null;
  }
}
