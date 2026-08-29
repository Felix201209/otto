import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalCustomerModuleManifest, encodeCustomerModulePackageV1, type CustomerModulePermission } from 'otto-core';
import {
  installCustomerModule,
  clearCustomerModuleData,
  exportCustomerModuleData,
  listInstalledCustomerModules,
  recoverCustomerModuleInstallReceipts,
  refreshCustomerModuleMarketStatus,
  setCustomerModuleEnabled,
  setCustomerModuleBackgroundEnabled,
  uninstallCustomerModule,
} from './customerModuleInstaller.js';

const roots: string[] = [];
afterEach(async () => {
  delete process.env.OTTO_CUSTOMER_MODULE_TRUSTED_PUBLIC_KEYS;
  await Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

function packageFixture(permissions: CustomerModulePermission[] = [{ kind: 'model', paid: true }]) {
  const wasm = Uint8Array.from([
    0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
    7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,6,1,4,0,65,0,11,
  ]);
  const icon = new TextEncoder().encode('<svg/>');
  const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
  const unsigned = {
    schemaVersion: 1 as const, id: 'com.acme.install', name: 'Install', version: '1.0.0',
    publisher: { id: 'publisher', name: 'Publisher' }, description: 'Install module',
    icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1' as const,
    minimumOttoVersion: '1.15.3', inputSchema: { type: 'object' as const, properties: {} },
    outputs: ['text' as const], permissions,
    files: { 'module.wasm': digest(wasm), 'icon.svg': digest(icon) },
  };
  const keys = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(canonicalCustomerModuleManifest(unsigned)), keys.privateKey).toString('base64url');
  process.env.OTTO_CUSTOMER_MODULE_TRUSTED_PUBLIC_KEYS = JSON.stringify({
    market: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  const manifest = { ...unsigned, signature: { algorithm: 'ed25519' as const, keyId: 'market', value: `ed25519:${signature}` } };
  const files = { 'module.wasm': Buffer.from(wasm).toString('base64'), 'icon.svg': Buffer.from(icon).toString('base64') };
  return { manifest, files, archive: Buffer.from(encodeCustomerModulePackageV1({ manifest, files })).toString('base64') };
}

describe('customer module installer', () => {
  const ottoVersion = '1.15.3';
  it('verifies, installs atomically and records an idempotent receipt', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-install-')); roots.push(root);
    const bundle = packageFixture();
    const client = {
      downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle),
      recordCustomerModuleInstall: vi.fn().mockResolvedValue(undefined),
    };
    const record = await installCustomerModule({
      root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version,
      approvedPermissions: bundle.manifest.permissions, ottoVersion,
    });
    expect(record.receiptStatus).toBe('committed');
    expect(await fs.promises.readFile(path.join(record.artifactPath, 'module.wasm'))).toBeTruthy();
    expect(client.recordCustomerModuleInstall).toHaveBeenCalledWith(record.id, record.version, record.receiptId);
  });

  it('keeps a pending receipt after network failure and recovers without reinstalling', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-recover-')); roots.push(root);
    const bundle = packageFixture();
    const client = {
      downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle),
      recordCustomerModuleInstall: vi.fn().mockRejectedValueOnce(new Error('offline')),
    };
    await expect(installCustomerModule({
      root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version,
      approvedPermissions: bundle.manifest.permissions, ottoVersion,
    })).rejects.toThrow(/offline/);
    expect((await listInstalledCustomerModules(root))[0].receiptStatus).toBe('pending');
    client.recordCustomerModuleInstall.mockResolvedValueOnce(undefined);
    await recoverCustomerModuleInstallReceipts(root, client as never);
    expect((await listInstalledCustomerModules(root))[0].receiptStatus).toBe('committed');
  });

  it('rejects untrusted signatures before writing artifacts', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-untrusted-')); roots.push(root);
    const bundle = packageFixture(); delete process.env.OTTO_CUSTOMER_MODULE_TRUSTED_PUBLIC_KEYS;
    await expect(installCustomerModule({
      root,
      client: { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle) } as never,
      moduleId: bundle.manifest.id, version: bundle.manifest.version,
      approvedPermissions: bundle.manifest.permissions, ottoVersion,
    })).rejects.toThrow(/不可信/);
    expect(await listInstalledCustomerModules(root)).toEqual([]);
  });

  it('rejects a package that requires a newer Otto version', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-version-')); roots.push(root);
    const bundle = packageFixture();
    await expect(installCustomerModule({
      root, client: { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle) } as never,
      moduleId: bundle.manifest.id, version: bundle.manifest.version,
      approvedPermissions: bundle.manifest.permissions, ottoVersion: '1.15.2',
    })).rejects.toThrow(/1\.15\.3/);
  });

  it('refuses to reuse a tampered version directory', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-tamper-')); roots.push(root);
    const bundle = packageFixture();
    const client = { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle), recordCustomerModuleInstall: vi.fn() };
    const record = await installCustomerModule({ root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version, approvedPermissions: bundle.manifest.permissions, ottoVersion });
    await fs.promises.writeFile(path.join(record.artifactPath, 'module.wasm'), 'tampered');
    await expect(installCustomerModule({ root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version, approvedPermissions: bundle.manifest.permissions, ottoVersion })).rejects.toThrow(/hash mismatch/);
  });

  it('separates disable, uninstall, and scoped-data clearing', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-lifecycle-')); roots.push(root);
    const bundle = packageFixture();
    const record = await installCustomerModule({
      root,
      client: { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle), recordCustomerModuleInstall: vi.fn() } as never,
      moduleId: bundle.manifest.id, version: bundle.manifest.version,
      approvedPermissions: bundle.manifest.permissions, ottoVersion,
    });
    const dataRoot = path.join(root, 'data', encodeURIComponent(record.id));
    await fs.promises.mkdir(dataRoot, { recursive: true });
    await fs.promises.writeFile(path.join(dataRoot, 'value.json'), '{}');
    expect(await exportCustomerModuleData(root, record.id)).toMatchObject({ moduleId: record.id, values: { value: {} } });
    expect((await setCustomerModuleEnabled(root, record.id, false)).enabled).toBe(false);
    await uninstallCustomerModule(root, record.id);
    expect(await listInstalledCustomerModules(root)).toEqual([]);
    await expect(fs.promises.access(dataRoot)).resolves.toBeUndefined();
    await clearCustomerModuleData(root, record.id);
    await expect(fs.promises.access(dataRoot)).rejects.toThrow();
  });

  it('fail-closes an installed version after marketplace suspension', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-suspend-')); roots.push(root);
    const bundle = packageFixture();
    const client = { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle), recordCustomerModuleInstall: vi.fn() };
    await installCustomerModule({ root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version, approvedPermissions: bundle.manifest.permissions, ottoVersion });
    const records = await refreshCustomerModuleMarketStatus(root, {
      getCustomerModuleStatus: vi.fn().mockResolvedValue({ status: 'suspended' }),
    } as never);
    expect(records[0]).toMatchObject({ enabled: false, riskStatus: 'suspended' });
    await expect(setCustomerModuleEnabled(root, bundle.manifest.id, true)).rejects.toThrow(/风险状态/);
  });

  it('preserves the committed registry when an atomic switch fails with disk full', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-disk-full-')); roots.push(root);
    const bundle = packageFixture();
    const client = { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle), recordCustomerModuleInstall: vi.fn() };
    await installCustomerModule({ root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version, approvedPermissions: bundle.manifest.permissions, ottoVersion });
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    await expect(setCustomerModuleEnabled(root, bundle.manifest.id, false)).rejects.toMatchObject({ code: 'ENOSPC' });
    rename.mockRestore();
    expect((await listInstalledCustomerModules(root))[0].enabled).toBe(true);
  });

  it('keeps declared background capability off until a separate explicit authorization', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-background-')); roots.push(root);
    const bundle = packageFixture([{ kind: 'background', defaultEnabled: false }]);
    const client = { downloadCustomerModulePackage: vi.fn().mockResolvedValue(bundle), recordCustomerModuleInstall: vi.fn() };
    const installed = await installCustomerModule({ root, client: client as never, moduleId: bundle.manifest.id, version: bundle.manifest.version, approvedPermissions: bundle.manifest.permissions, ottoVersion });
    expect(installed.backgroundEnabled).toBe(false);
    expect((await setCustomerModuleBackgroundEnabled(root, installed.id, true)).backgroundEnabled).toBe(true);
    expect((await setCustomerModuleBackgroundEnabled(root, installed.id, false)).backgroundEnabled).toBe(false);
  });
});
