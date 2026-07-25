/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { computeFileSha256 } from './update-verify.js';

export interface InstalledKernelRecord {
  id: string;
  version: string;
  target: string;
  kernelAbi: string;
  artifactPath: string;
  extractedPath: string;
  modulePath: string;
  binPath: string;
  sha256: string;
  signature: string;
  size: number;
  installedAt: string;
}

export interface KernelRollbackReceipt {
  id: string;
  target: string;
  fromVersion: string | null;
  toVersion: string;
  previousArtifactPath: string | null;
  previousModulePath: string | null;
  previousBinPath: string | null;
  installedArtifactPath: string;
  installedModulePath: string;
  installedBinPath: string;
  createdAt: string;
}

export interface IncrementalKernelRegistry {
  schemaVersion: 1;
  updatedAt: string;
  kernels: Record<string, InstalledKernelRecord>;
  active: {
    serverRuntimeKernelId: string | null;
  };
  receipts: KernelRollbackReceipt[];
}

export type InstallKernelUpdateResult =
  | { ok: true; record: InstalledKernelRecord; receipt: KernelRollbackReceipt }
  | { ok: false; error: string };

interface KernelBundleFile {
  path: string;
  contentBase64: string;
}

interface KernelBundle {
  schemaVersion: 1;
  files: KernelBundleFile[];
}

const MAX_KERNEL_FILES = 2500;
const MAX_KERNEL_BYTES = 80 * 1024 * 1024;
const SERVER_RUNTIME_TARGET = 'server/runtime';
const SERVER_MODULE_ENTRY = 'dist/index.js';
const SERVER_BIN_ENTRY = 'dist/bin.js';

export function resolveKernelUpdateRoot(userDataPath: string): string {
  return path.join(userDataPath, 'incremental-updates', 'kernels');
}

function registryPath(rootDir: string): string {
  return path.join(rootDir, 'registry.json');
}

function emptyRegistry(now: string): IncrementalKernelRegistry {
  return {
    schemaVersion: 1,
    updatedAt: now,
    kernels: {},
    active: { serverRuntimeKernelId: null },
    receipts: [],
  };
}

function safePathSegment(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

function safeBundleRelativePath(value: string): string | null {
  if (!value || value.includes('\\')) return null;
  if (path.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
}

async function readRegistry(rootDir: string, now: string): Promise<IncrementalKernelRegistry> {
  try {
    const raw = await fs.promises.readFile(registryPath(rootDir), 'utf8');
    const parsed = JSON.parse(raw) as IncrementalKernelRegistry;
    if (parsed.schemaVersion !== 1 || typeof parsed.kernels !== 'object') {
      return emptyRegistry(now);
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
      kernels: parsed.kernels ?? {},
      active: {
        serverRuntimeKernelId:
          typeof parsed.active?.serverRuntimeKernelId === 'string' ? parsed.active.serverRuntimeKernelId : null,
      },
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyRegistry(now);
    }
    throw error;
  }
}

async function writeRegistry(rootDir: string, registry: IncrementalKernelRegistry): Promise<void> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const tmpPath = `${registryPath(rootDir)}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(registry, null, 2) + '\n');
  await fs.promises.rename(tmpPath, registryPath(rootDir));
}

export async function readIncrementalKernelRegistry(
  rootDir: string,
  now = new Date().toISOString(),
): Promise<IncrementalKernelRegistry> {
  return readRegistry(rootDir, now);
}

function parseKernelBundle(raw: string): KernelBundle | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'kernel bundle must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'kernel bundle must be an object';
  const candidate = parsed as { schemaVersion?: unknown; files?: unknown };
  if (candidate.schemaVersion !== 1) return 'kernel bundle schemaVersion must be 1';
  if (!Array.isArray(candidate.files)) return 'kernel bundle files must be an array';
  if (candidate.files.length === 0 || candidate.files.length > MAX_KERNEL_FILES) {
    return `kernel bundle files must contain 1-${MAX_KERNEL_FILES} entries`;
  }

  let totalBytes = 0;
  const files: KernelBundleFile[] = [];
  for (const item of candidate.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'kernel bundle file entry must be an object';
    const file = item as { path?: unknown; contentBase64?: unknown };
    if (typeof file.path !== 'string' || typeof file.contentBase64 !== 'string') {
      return 'kernel bundle file entry requires path and contentBase64 strings';
    }
    const safePath = safeBundleRelativePath(file.path);
    if (!safePath) return `kernel bundle contains unsafe path: ${file.path}`;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)) {
      return `kernel bundle file is not valid base64: ${safePath}`;
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_KERNEL_BYTES) return `kernel bundle exceeds ${MAX_KERNEL_BYTES} bytes after decode`;
    files.push({ path: safePath, contentBase64: file.contentBase64 });
  }
  if (!files.some((file) => file.path === SERVER_MODULE_ENTRY)) {
    return `server runtime kernel bundle must contain ${SERVER_MODULE_ENTRY}`;
  }
  if (!files.some((file) => file.path === SERVER_BIN_ENTRY)) {
    return `server runtime kernel bundle must contain ${SERVER_BIN_ENTRY}`;
  }
  return { schemaVersion: 1, files };
}

async function unpackBundle(bundle: KernelBundle, destination: string): Promise<void> {
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.rm(temp, { recursive: true, force: true });
  await fs.promises.mkdir(temp, { recursive: true });
  for (const file of bundle.files) {
    const outputPath = path.join(temp, ...file.path.split('/'));
    const relative = path.relative(temp, outputPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`kernel bundle path escapes destination: ${file.path}`);
    }
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from(file.contentBase64, 'base64'));
  }
  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.rename(temp, destination);
}

export async function installKernelUpdate(params: {
  artifact: IncrementalUpdateArtifact;
  downloadedFilePath: string;
  rootDir: string;
  now?: string;
}): Promise<InstallKernelUpdateResult> {
  const { artifact, downloadedFilePath, rootDir } = params;
  const now = params.now ?? new Date().toISOString();
  if (artifact.kind !== 'kernel') {
    return { ok: false, error: 'only kernel artifacts can be installed by the kernel updater' };
  }
  const kernelAbi = artifact.compat.kernelAbi;
  if (!kernelAbi) {
    return { ok: false, error: 'kernel artifact must declare compat.kernelAbi' };
  }
  if (artifact.target !== SERVER_RUNTIME_TARGET) {
    return { ok: false, error: `unsupported kernel target: ${artifact.target}` };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'kernel id and version must be safe path segments' };
  }

  let actualSha256: string;
  try {
    actualSha256 = await computeFileSha256(downloadedFilePath);
  } catch (error) {
    return {
      ok: false,
      error: `failed to read downloaded kernel artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (actualSha256 !== artifact.sha256.toLowerCase()) {
    return {
      ok: false,
      error: `kernel artifact sha256 mismatch: expected ${artifact.sha256.slice(0, 12)}, got ${actualSha256.slice(0, 12)}`,
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(downloadedFilePath, 'utf8');
  } catch (error) {
    return { ok: false, error: `failed to read kernel bundle: ${error instanceof Error ? error.message : String(error)}` };
  }
  const bundle = parseKernelBundle(raw);
  if (typeof bundle === 'string') return { ok: false, error: bundle };

  const registry = await readRegistry(rootDir, now);
  const previousId = registry.active.serverRuntimeKernelId;
  const previous = previousId ? registry.kernels[previousId] ?? null : null;
  const kernelDir = path.join(rootDir, 'store', safeId, safeVersion);
  const finalPath = path.join(kernelDir, 'artifact.bundle.json');
  const extractedPath = path.join(kernelDir, 'extracted');
  const modulePath = path.join(extractedPath, ...SERVER_MODULE_ENTRY.split('/'));
  const binPath = path.join(extractedPath, ...SERVER_BIN_ENTRY.split('/'));

  try {
    await fs.promises.mkdir(kernelDir, { recursive: true });
    await fs.promises.copyFile(downloadedFilePath, finalPath);
    await unpackBundle(bundle, extractedPath);
    await fs.promises.access(modulePath, fs.constants.R_OK);
    await fs.promises.access(binPath, fs.constants.R_OK);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const record: InstalledKernelRecord = {
    id: artifact.id,
    version: artifact.version,
    target: artifact.target,
    kernelAbi,
    artifactPath: finalPath,
    extractedPath,
    modulePath,
    binPath,
    sha256: actualSha256,
    signature: artifact.signature,
    size: artifact.size,
    installedAt: now,
  };
  const receipt: KernelRollbackReceipt = {
    id: artifact.id,
    target: artifact.target,
    fromVersion: previous?.version ?? null,
    toVersion: artifact.version,
    previousArtifactPath: previous?.artifactPath ?? null,
    previousModulePath: previous?.modulePath ?? null,
    previousBinPath: previous?.binPath ?? null,
    installedArtifactPath: finalPath,
    installedModulePath: modulePath,
    installedBinPath: binPath,
    createdAt: now,
  };

  registry.updatedAt = now;
  registry.kernels[artifact.id] = record;
  registry.active.serverRuntimeKernelId = artifact.id;
  registry.receipts.push(receipt);
  await writeRegistry(rootDir, registry);
  return { ok: true, record, receipt };
}

export async function readActiveKernelRecord(rootDir: string): Promise<InstalledKernelRecord | null> {
  const registry = await readRegistry(rootDir, new Date().toISOString());
  const activeId = registry.active.serverRuntimeKernelId;
  if (!activeId) return null;
  const active = registry.kernels[activeId];
  if (!active) return null;
  try {
    await fs.promises.access(active.modulePath, fs.constants.R_OK);
    await fs.promises.access(active.binPath, fs.constants.R_OK);
  } catch {
    return null;
  }
  return active;
}

export async function readActiveKernelModulePath(rootDir: string): Promise<string | null> {
  const active = await readActiveKernelRecord(rootDir);
  return active?.modulePath ?? null;
}

export async function readActiveKernelBinPath(rootDir: string): Promise<string | null> {
  const active = await readActiveKernelRecord(rootDir);
  return active?.binPath ?? null;
}
