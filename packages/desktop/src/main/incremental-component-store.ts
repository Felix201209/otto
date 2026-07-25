/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { computeFileSha256 } from './update-verify.js';

export interface InstalledComponentRecord {
  id: string;
  version: string;
  target: string;
  componentApi: string;
  artifactPath: string;
  sha256: string;
  signature: string;
  size: number;
  installedAt: string;
}

export interface ComponentRollbackReceipt {
  id: string;
  target: string;
  fromVersion: string | null;
  toVersion: string;
  previousArtifactPath: string | null;
  installedArtifactPath: string;
  createdAt: string;
}

export interface IncrementalComponentRegistry {
  schemaVersion: 1;
  updatedAt: string;
  components: Record<string, InstalledComponentRecord>;
  receipts: ComponentRollbackReceipt[];
}

export type InstallComponentUpdateResult =
  | { ok: true; record: InstalledComponentRecord; receipt: ComponentRollbackReceipt }
  | { ok: false; error: string };

export function resolveComponentUpdateRoot(userDataPath: string): string {
  return path.join(userDataPath, 'incremental-updates', 'components');
}

function registryPath(rootDir: string): string {
  return path.join(rootDir, 'registry.json');
}

function emptyRegistry(now: string): IncrementalComponentRegistry {
  return { schemaVersion: 1, updatedAt: now, components: {}, receipts: [] };
}

function safePathSegment(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

async function readRegistry(rootDir: string, now: string): Promise<IncrementalComponentRegistry> {
  try {
    const raw = await fs.promises.readFile(registryPath(rootDir), 'utf8');
    const parsed = JSON.parse(raw) as IncrementalComponentRegistry;
    if (parsed.schemaVersion !== 1 || typeof parsed.components !== 'object') {
      return emptyRegistry(now);
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
      components: parsed.components ?? {},
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyRegistry(now);
    }
    throw error;
  }
}

async function writeRegistry(rootDir: string, registry: IncrementalComponentRegistry): Promise<void> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const tmpPath = `${registryPath(rootDir)}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(registry, null, 2) + '\n');
  await fs.promises.rename(tmpPath, registryPath(rootDir));
}

export async function readIncrementalComponentRegistry(
  rootDir: string,
  now = new Date().toISOString(),
): Promise<IncrementalComponentRegistry> {
  return readRegistry(rootDir, now);
}

export async function installComponentUpdate(params: {
  artifact: IncrementalUpdateArtifact;
  downloadedFilePath: string;
  rootDir: string;
  now?: string;
}): Promise<InstallComponentUpdateResult> {
  const { artifact, downloadedFilePath, rootDir } = params;
  const now = params.now ?? new Date().toISOString();
  if (artifact.kind !== 'component') {
    return { ok: false, error: 'only component artifacts can be installed by the component updater' };
  }
  const componentApi = artifact.compat.componentApi;
  if (!componentApi) {
    return { ok: false, error: 'component artifact must declare compat.componentApi' };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'component id and version must be safe path segments' };
  }

  let actualSha256: string;
  try {
    actualSha256 = await computeFileSha256(downloadedFilePath);
  } catch (error) {
    return {
      ok: false,
      error: `failed to read downloaded component artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (actualSha256 !== artifact.sha256.toLowerCase()) {
    return {
      ok: false,
      error: `component artifact sha256 mismatch: expected ${artifact.sha256.slice(0, 12)}, got ${actualSha256.slice(0, 12)}`,
    };
  }

  const registry = await readRegistry(rootDir, now);
  const previous = registry.components[artifact.id] ?? null;
  const componentDir = path.join(rootDir, 'store', safeId, safeVersion);
  const finalPath = path.join(componentDir, 'artifact.bin');
  await fs.promises.mkdir(componentDir, { recursive: true });
  await fs.promises.copyFile(downloadedFilePath, finalPath);

  const record: InstalledComponentRecord = {
    id: artifact.id,
    version: artifact.version,
    target: artifact.target,
    componentApi,
    artifactPath: finalPath,
    sha256: actualSha256,
    signature: artifact.signature,
    size: artifact.size,
    installedAt: now,
  };
  const receipt: ComponentRollbackReceipt = {
    id: artifact.id,
    target: artifact.target,
    fromVersion: previous?.version ?? null,
    toVersion: artifact.version,
    previousArtifactPath: previous?.artifactPath ?? null,
    installedArtifactPath: finalPath,
    createdAt: now,
  };

  registry.updatedAt = now;
  registry.components[artifact.id] = record;
  registry.receipts.push(receipt);
  await writeRegistry(rootDir, registry);
  return { ok: true, record, receipt };
}
