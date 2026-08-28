import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  parseCustomerModuleManifest,
  scanCustomerModuleWasm,
  verifyCustomerModuleFileHashes,
  verifyCustomerModuleSignature,
  CustomerModuleRunner,
  decodeCustomerModulePackageV1,
  type CustomerModuleAuditEvent,
  type CustomerModuleHostV1,
  type CustomerModuleRunResult,
  type CustomerModuleManifestV1,
  type CustomerModulePermission,
} from 'otto-core';
import type { EnterpriseClient } from './enterprise-client.js';

export interface InstalledCustomerModuleRecord {
  id: string;
  version: string;
  name: string;
  description: string;
  permissions: CustomerModulePermission[];
  enabled: boolean;
  installedAt: string;
  artifactPath: string;
  iconDataUrl: string;
  receiptId: string;
  receiptStatus: 'pending' | 'committed';
  riskStatus?: 'suspended' | 'withdrawn';
  manifest: CustomerModuleManifestV1;
}

function permissionKey(value: CustomerModulePermission): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

function isVersionCompatible(current: string, minimum: string): boolean {
  const parts = (value: string) => value.split('-', 1)[0].split('.').map(Number);
  const left = parts(current); const right = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

function trustedKeys(): Record<string, string> {
  const raw = process.env.OTTO_CUSTOMER_MODULE_TRUSTED_PUBLIC_KEYS?.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].includes('PUBLIC KEY'),
    ));
  } catch {
    return {};
  }
}

async function readRegistry(root: string): Promise<InstalledCustomerModuleRecord[]> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(root, 'registry.json'), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is InstalledCustomerModuleRecord => (
      Boolean(item) && typeof item === 'object' && typeof (item as InstalledCustomerModuleRecord).id === 'string'
    )) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRegistry(root: string, records: InstalledCustomerModuleRecord[]): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `.registry-${randomUUID()}.tmp`);
  await fs.promises.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temporary, path.join(root, 'registry.json'));
}

function decodeFiles(encoded: Record<string, string>): Map<string, Uint8Array> {
  return new Map(Object.entries(encoded).map(([name, body]) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(body)) throw new Error(`客户模块文件不是有效 base64：${name}`);
    return [name, Uint8Array.from(Buffer.from(body, 'base64'))];
  }));
}

export async function listInstalledCustomerModules(root: string): Promise<InstalledCustomerModuleRecord[]> {
  return readRegistry(root);
}

export async function setCustomerModuleEnabled(root: string, moduleId: string, enabled: boolean): Promise<InstalledCustomerModuleRecord> {
  const records = await readRegistry(root);
  const record = records.find((item) => item.id === moduleId);
  if (!record) throw new Error('客户模块未安装');
  if (enabled && record.riskStatus) throw new Error(`客户模块版本处于风险状态：${record.riskStatus}`);
  record.enabled = enabled;
  await writeRegistry(root, records);
  return record;
}

export async function uninstallCustomerModule(root: string, moduleId: string): Promise<void> {
  const records = await readRegistry(root);
  const installed = records.filter((item) => item.id === moduleId);
  if (installed.length === 0) throw new Error('客户模块未安装');
  await writeRegistry(root, records.filter((item) => item.id !== moduleId));
  for (const record of installed) {
    await fs.promises.rm(record.artifactPath, { recursive: true, force: true });
  }
  // Deliberately preserve root/data/<moduleId>; clearing scoped data is a separate confirmation.
}

export async function clearCustomerModuleData(root: string, moduleId: string): Promise<void> {
  await fs.promises.rm(path.join(root, 'data', encodeURIComponent(moduleId)), { recursive: true, force: true });
}

export async function recoverCustomerModuleInstallReceipts(
  root: string,
  client: EnterpriseClient,
): Promise<InstalledCustomerModuleRecord[]> {
  const records = await readRegistry(root);
  let changed = false;
  for (const record of records) {
    if (record.receiptStatus !== 'pending') continue;
    await client.recordCustomerModuleInstall(record.id, record.version, record.receiptId);
    record.receiptStatus = 'committed';
    changed = true;
  }
  if (changed) await writeRegistry(root, records);
  return records;
}

export async function refreshCustomerModuleMarketStatus(
  root: string,
  client: EnterpriseClient,
): Promise<InstalledCustomerModuleRecord[]> {
  const records = await readRegistry(root);
  let changed = false;
  await Promise.all(records.map(async (record) => {
    const remote = await client.getCustomerModuleStatus(record.id, record.version);
    const riskStatus = remote.status === 'suspended' || remote.status === 'withdrawn' ? remote.status : undefined;
    if (record.riskStatus !== riskStatus || (riskStatus && record.enabled)) changed = true;
    record.riskStatus = riskStatus;
    if (riskStatus) record.enabled = false;
  }));
  if (changed) await writeRegistry(root, records);
  return records;
}

export async function installCustomerModule(input: {
  root: string;
  client: EnterpriseClient;
  moduleId: string;
  version: string;
  ottoVersion: string;
  approvedPermissions: CustomerModulePermission[];
}): Promise<InstalledCustomerModuleRecord> {
  const downloaded = await input.client.downloadCustomerModulePackage(input.moduleId, input.version);
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(downloaded.archive)) throw new Error('客户模块归档不是有效 base64');
  const bundle = decodeCustomerModulePackageV1(Uint8Array.from(Buffer.from(downloaded.archive, 'base64')));
  const manifest = parseCustomerModuleManifest(bundle.manifest);
  if (manifest.id !== input.moduleId || manifest.version !== input.version) throw new Error('客户模块包身份不匹配');
  if (!isVersionCompatible(input.ottoVersion, manifest.minimumOttoVersion)) throw new Error(`客户模块要求 Otto ${manifest.minimumOttoVersion} 或更高版本`);
  if (!verifyCustomerModuleSignature(manifest, trustedKeys())) throw new Error('客户模块市场签名不可信');
  const declared = new Set(manifest.permissions.map(permissionKey));
  const approved = new Set(input.approvedPermissions.map(permissionKey));
  if (declared.size !== approved.size || [...declared].some((permission) => !approved.has(permission))) {
    throw new Error('必须明确批准客户模块声明的全部权限');
  }
  const files = decodeFiles(bundle.files);
  await verifyCustomerModuleFileHashes(manifest.files, files);
  await scanCustomerModuleWasm(files.get(manifest.entrypoint) ?? new Uint8Array());

  const versionRoot = path.join(input.root, 'artifacts', encodeURIComponent(manifest.id), encodeURIComponent(manifest.version));
  const versionExists = await fs.promises.access(versionRoot).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (versionExists) {
    const installedFiles = new Map<string, Uint8Array>();
    for (const filePath of Object.keys(manifest.files)) {
      installedFiles.set(filePath, Uint8Array.from(await fs.promises.readFile(path.join(versionRoot, filePath))));
    }
    await verifyCustomerModuleFileHashes(manifest.files, installedFiles);
    await scanCustomerModuleWasm(installedFiles.get(manifest.entrypoint) ?? new Uint8Array());
  } else {
    const temporary = `${versionRoot}.staging-${randomUUID()}`;
    try {
      await fs.promises.mkdir(temporary, { recursive: true, mode: 0o700 });
      for (const [filePath, body] of files) {
        const target = path.join(temporary, filePath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(target, body, { mode: 0o600 });
      }
      await fs.promises.mkdir(path.dirname(versionRoot), { recursive: true, mode: 0o700 });
      await fs.promises.rename(temporary, versionRoot);
    } catch (error) {
      await fs.promises.rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  const icon = files.get(manifest.icon) ?? new Uint8Array();
  const receiptId = randomUUID();
  const record: InstalledCustomerModuleRecord = {
    id: manifest.id, version: manifest.version, name: manifest.name,
    description: manifest.description, permissions: [...manifest.permissions], enabled: true,
    installedAt: new Date().toISOString(), artifactPath: versionRoot,
    iconDataUrl: `data:image/svg+xml;base64,${Buffer.from(icon).toString('base64')}`,
    receiptId, receiptStatus: 'pending',
    manifest,
  };
  const records = await readRegistry(input.root);
  const next = [...records.filter((item) => item.id !== record.id), record];
  await writeRegistry(input.root, next);
  await input.client.recordCustomerModuleInstall(record.id, record.version, receiptId);
  record.receiptStatus = 'committed';
  await writeRegistry(input.root, [...next.filter((item) => item.id !== record.id), record]);
  return record;
}

export async function runInstalledCustomerModule(input: {
  root: string;
  moduleId: string;
  version: string;
  formInput: Record<string, unknown>;
  host: CustomerModuleHostV1;
  signal?: AbortSignal;
}): Promise<{ result: CustomerModuleRunResult; audit: CustomerModuleAuditEvent[] }> {
  const record = (await readRegistry(input.root)).find((item) => (
    item.id === input.moduleId && item.version === input.version && item.enabled
  ));
  if (!record) throw new Error('客户模块未安装、已禁用或版本不匹配');
  parseCustomerModuleManifest(record.manifest);
  if (!verifyCustomerModuleSignature(record.manifest, trustedKeys())) throw new Error('客户模块运行授权签名不可信');
  const wasm = await fs.promises.readFile(path.join(record.artifactPath, record.manifest.entrypoint));
  if (createHash('sha256').update(wasm).digest('hex') !== record.manifest.files[record.manifest.entrypoint]) {
    throw new Error('客户模块运行文件完整性校验失败');
  }
  const audit: CustomerModuleAuditEvent[] = [];
  const runner = new CustomerModuleRunner({ host: input.host, onAudit: (event) => audit.push(event) });
  const result = await runner.run({
    moduleId: record.id,
    version: record.version,
    wasm,
    input: input.formInput,
    approvedCapabilities: record.permissions.map((permission) => permission.kind),
    limits: { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { result, audit };
}
