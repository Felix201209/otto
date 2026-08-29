import { describe, expect, it } from 'vitest';

import type { CustomerModuleManifestV1 } from './customerModuleManifest.js';
import {
  InMemoryCustomerModuleRegistryStore,
  CustomerModuleRegistry,
} from './customerModuleRegistry.js';

function manifest(version: string, permissions: CustomerModuleManifestV1['permissions'] = []): CustomerModuleManifestV1 {
  return {
    schemaVersion: 1,
    id: 'com.acme.report',
    name: 'Report',
    version,
    publisher: { id: 'acme', name: 'Acme' },
    description: 'Report module',
    icon: 'icon.svg',
    entrypoint: 'module.wasm',
    hostApi: 'otto.customer-module.v1',
    minimumOttoVersion: '1.15.3',
    inputSchema: { type: 'object', properties: {} },
    outputs: ['text'],
    permissions,
    files: { 'module.wasm': 'a'.repeat(64), 'icon.svg': 'b'.repeat(64) },
    signature: { algorithm: 'ed25519', keyId: 'market', value: 'ed25519:sig' },
  };
}

describe('CustomerModuleRegistry', () => {
  const registry = (store = new InMemoryCustomerModuleRegistryStore()) => (
    new CustomerModuleRegistry(store, undefined, () => true)
  );

  it('installs disabled until permissions are explicitly approved', async () => {
    const subject = registry();
    const installed = await subject.stageInstall(manifest('1.0.0', [{ kind: 'model', paid: true }]));
    expect(installed.enabled).toBe(false);
    expect(installed.approvedPermissions).toEqual([]);

    const enabled = await subject.approveAndEnable('com.acme.report', '1.0.0', [{ kind: 'model', paid: true }]);
    expect(enabled.enabled).toBe(true);
  });

  it('requires manual approval for every upgrade and reports added permissions', async () => {
    const subject = registry();
    await subject.stageInstall(manifest('1.0.0'));
    await subject.approveAndEnable('com.acme.report', '1.0.0', []);
    const next = manifest('1.1.0', [{ kind: 'http', hosts: ['api.acme.test'], writes: true }]);
    const staged = await subject.stageInstall(next);
    expect(staged.enabled).toBe(true);
    expect(staged.version).toBe('1.0.0');
    expect(staged.pendingUpgrade?.version).toBe('1.1.0');
    expect(subject.permissionDiff([], next.permissions).added).toEqual(next.permissions);
  });

  it('does not enable a module when any declared permission was not approved', async () => {
    const subject = registry();
    await subject.stageInstall(manifest('1.0.0', [{ kind: 'model', paid: true }]));
    await expect(subject.approveAndEnable('com.acme.report', '1.0.0', []))
      .rejects.toThrow(/all declared/);
  });

  it('uninstall keeps scoped data unless separately cleared', async () => {
    const store = new InMemoryCustomerModuleRegistryStore();
    const subject = registry(store);
    await subject.stageInstall(manifest('1.0.0'));
    await store.writeData('com.acme.report', 'key', 'value');
    await subject.uninstall('com.acme.report');
    expect(await subject.get('com.acme.report')).toBeNull();
    expect(await store.readData('com.acme.report', 'key')).toBe('value');
    await subject.clearData('com.acme.report');
    expect(await store.readData('com.acme.report', 'key')).toBeNull();
  });

  it('fails closed when a marketplace signature is not trusted', async () => {
    const subject = new CustomerModuleRegistry(new InMemoryCustomerModuleRegistryStore());
    await expect(subject.stageInstall(manifest('1.0.0'))).rejects.toThrow(/not trusted/);
  });
});
