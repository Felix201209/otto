/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { computeFileSha256 } from './update-verify.js';

export interface InstalledComponentRecord {
  id: string;
  version: string;
  target: string;
  componentApi: string;
  artifactPath: string;
  extractedPath: string | null;
  exposedPath: string | null;
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
  previousExposedPath: string | null;
  installedArtifactPath: string;
  installedExposedPath: string | null;
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

interface ComponentBundleFile {
  path: string;
  contentBase64: string;
}

interface ComponentBundle {
  schemaVersion: 1;
  files: ComponentBundleFile[];
}

const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

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

function resolveOttoUserDir(): string {
  const configured = process.env['OTTO_USER_DIR']?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.otto-user');
}

function skillTargetName(target: string): string | null {
  const match = target.match(/^skills\/([A-Za-z0-9._-]+)$/);
  if (!match) return null;
  return safePathSegment(match[1]);
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

function parseComponentBundle(raw: string): ComponentBundle | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'component bundle must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'component bundle must be an object';
  const candidate = parsed as { schemaVersion?: unknown; files?: unknown };
  if (candidate.schemaVersion !== 1) return 'component bundle schemaVersion must be 1';
  if (!Array.isArray(candidate.files)) return 'component bundle files must be an array';
  if (candidate.files.length === 0 || candidate.files.length > MAX_BUNDLE_FILES) {
    return `component bundle files must contain 1-${MAX_BUNDLE_FILES} entries`;
  }
  let totalBytes = 0;
  const files: ComponentBundleFile[] = [];
  for (const item of candidate.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'component bundle file entry must be an object';
    const file = item as { path?: unknown; contentBase64?: unknown };
    if (typeof file.path !== 'string' || typeof file.contentBase64 !== 'string') {
      return 'component bundle file entry requires path and contentBase64 strings';
    }
    const safePath = safeBundleRelativePath(file.path);
    if (!safePath) return `component bundle contains unsafe path: ${file.path}`;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)) {
      return `component bundle file is not valid base64: ${safePath}`;
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) return `component bundle exceeds ${MAX_BUNDLE_BYTES} bytes after decode`;
    files.push({ path: safePath, contentBase64: file.contentBase64 });
  }
  return { schemaVersion: 1, files };
}

async function unpackBundle(bundle: ComponentBundle, destination: string): Promise<void> {
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.rm(temp, { recursive: true, force: true });
  await fs.promises.mkdir(temp, { recursive: true });
  for (const file of bundle.files) {
    const outputPath = path.join(temp, ...file.path.split('/'));
    const relative = path.relative(temp, outputPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`component bundle path escapes destination: ${file.path}`);
    }
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from(file.contentBase64, 'base64'));
  }
  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.rename(temp, destination);
}

async function exposeSkillComponent(extractedPath: string, skillName: string): Promise<string> {
  const skillFile = path.join(extractedPath, 'SKILL.md');
  try {
    const stat = await fs.promises.stat(skillFile);
    if (!stat.isFile()) throw new Error('SKILL.md is not a file');
  } catch {
    throw new Error('skills component bundle must contain SKILL.md at bundle root');
  }
  const skillsRoot = path.join(resolveOttoUserDir(), 'skills');
  const destination = path.join(skillsRoot, skillName);
  const relative = path.relative(skillsRoot, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('skill component destination escapes skills root');
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const temp = `${destination}.tmp-${stamp}`;
  const backup = `${destination}.bak-${stamp}`;
  await fs.promises.rm(temp, { recursive: true, force: true });
  await fs.promises.rm(backup, { recursive: true, force: true });
  await fs.promises.mkdir(skillsRoot, { recursive: true });
  await fs.promises.cp(extractedPath, temp, { recursive: true });
  let hadPrevious = false;
  try {
    await fs.promises.rename(destination, backup);
    hadPrevious = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try {
    await fs.promises.rename(temp, destination);
    await fs.promises.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (hadPrevious) await fs.promises.rename(backup, destination).catch(() => undefined);
    throw error;
  } finally {
    await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
  return destination;
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
  const finalPath = path.join(componentDir, 'artifact.bundle.json');
  const extractedPath = path.join(componentDir, 'extracted');
  await fs.promises.mkdir(componentDir, { recursive: true });
  await fs.promises.copyFile(downloadedFilePath, finalPath);

  let installedExtractedPath: string | null = null;
  let exposedPath: string | null = null;
  const skillName = skillTargetName(artifact.target);
  if (skillName) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(downloadedFilePath, 'utf8');
    } catch (error) {
      return { ok: false, error: `failed to read component bundle: ${error instanceof Error ? error.message : String(error)}` };
    }
    const bundle = parseComponentBundle(raw);
    if (typeof bundle === 'string') return { ok: false, error: bundle };
    try {
      await unpackBundle(bundle, extractedPath);
      installedExtractedPath = extractedPath;
      exposedPath = await exposeSkillComponent(extractedPath, skillName);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const record: InstalledComponentRecord = {
    id: artifact.id,
    version: artifact.version,
    target: artifact.target,
    componentApi,
    artifactPath: finalPath,
    extractedPath: installedExtractedPath,
    exposedPath,
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
    previousExposedPath: previous?.exposedPath ?? null,
    installedArtifactPath: finalPath,
    installedExposedPath: exposedPath,
    createdAt: now,
  };

  registry.updatedAt = now;
  registry.components[artifact.id] = record;
  registry.receipts.push(receipt);
  await writeRegistry(rootDir, registry);
  return { ok: true, record, receipt };
}
