/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { computeFileSha256 } from './update-verify.js';

export interface InstalledPatchRecord {
  id: string;
  version: string;
  target: string;
  sourceCommit: string;
  artifactPath: string;
  extractedPath: string;
  activeCssPath: string | null;
  sha256: string;
  signature: string;
  size: number;
  installedAt: string;
}

export interface PatchRollbackReceipt {
  id: string;
  target: string;
  fromVersion: string | null;
  toVersion: string;
  previousArtifactPath: string | null;
  previousActiveCssPath: string | null;
  installedArtifactPath: string;
  installedActiveCssPath: string | null;
  createdAt: string;
}

export interface IncrementalPatchRegistry {
  schemaVersion: 1;
  updatedAt: string;
  patches: Record<string, InstalledPatchRecord>;
  active: {
    rendererCssPatchId: string | null;
  };
  receipts: PatchRollbackReceipt[];
}

export type InstallPatchUpdateResult =
  | { ok: true; record: InstalledPatchRecord; receipt: PatchRollbackReceipt }
  | { ok: false; error: string };

interface PatchBundleFile {
  path: string;
  contentBase64: string;
}

interface PatchBundle {
  schemaVersion: 1;
  files: PatchBundleFile[];
}

const MAX_PATCH_FILES = 25;
const MAX_PATCH_BYTES = 512 * 1024;
const RENDERER_CSS_TARGET = 'desktop/renderer-css';

export function resolvePatchUpdateRoot(userDataPath: string): string {
  return path.join(userDataPath, 'incremental-updates', 'patches');
}

function registryPath(rootDir: string): string {
  return path.join(rootDir, 'registry.json');
}

function emptyRegistry(now: string): IncrementalPatchRegistry {
  return {
    schemaVersion: 1,
    updatedAt: now,
    patches: {},
    active: { rendererCssPatchId: null },
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

async function readRegistry(rootDir: string, now: string): Promise<IncrementalPatchRegistry> {
  try {
    const raw = await fs.promises.readFile(registryPath(rootDir), 'utf8');
    const parsed = JSON.parse(raw) as IncrementalPatchRegistry;
    if (parsed.schemaVersion !== 1 || typeof parsed.patches !== 'object') {
      return emptyRegistry(now);
    }
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now,
      patches: parsed.patches ?? {},
      active: {
        rendererCssPatchId:
          typeof parsed.active?.rendererCssPatchId === 'string' ? parsed.active.rendererCssPatchId : null,
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

async function writeRegistry(rootDir: string, registry: IncrementalPatchRegistry): Promise<void> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const tmpPath = `${registryPath(rootDir)}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(registry, null, 2) + '\n');
  await fs.promises.rename(tmpPath, registryPath(rootDir));
}

export async function readIncrementalPatchRegistry(
  rootDir: string,
  now = new Date().toISOString(),
): Promise<IncrementalPatchRegistry> {
  return readRegistry(rootDir, now);
}

function parsePatchBundle(raw: string): PatchBundle | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'patch bundle must be valid JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'patch bundle must be an object';
  const candidate = parsed as { schemaVersion?: unknown; files?: unknown };
  if (candidate.schemaVersion !== 1) return 'patch bundle schemaVersion must be 1';
  if (!Array.isArray(candidate.files)) return 'patch bundle files must be an array';
  if (candidate.files.length === 0 || candidate.files.length > MAX_PATCH_FILES) {
    return `patch bundle files must contain 1-${MAX_PATCH_FILES} entries`;
  }

  let totalBytes = 0;
  const files: PatchBundleFile[] = [];
  for (const item of candidate.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'patch bundle file entry must be an object';
    const file = item as { path?: unknown; contentBase64?: unknown };
    if (typeof file.path !== 'string' || typeof file.contentBase64 !== 'string') {
      return 'patch bundle file entry requires path and contentBase64 strings';
    }
    const safePath = safeBundleRelativePath(file.path);
    if (!safePath) return `patch bundle contains unsafe path: ${file.path}`;
    if (!safePath.endsWith('.css')) return `patch bundle only supports css files: ${safePath}`;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)) {
      return `patch bundle file is not valid base64: ${safePath}`;
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PATCH_BYTES) return `patch bundle exceeds ${MAX_PATCH_BYTES} bytes after decode`;
    files.push({ path: safePath, contentBase64: file.contentBase64 });
  }
  if (!files.some((file) => file.path === 'patch.css')) {
    return 'renderer css patch bundle must contain patch.css at bundle root';
  }
  return { schemaVersion: 1, files };
}

async function unpackBundle(bundle: PatchBundle, destination: string): Promise<void> {
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.rm(temp, { recursive: true, force: true });
  await fs.promises.mkdir(temp, { recursive: true });
  for (const file of bundle.files) {
    const outputPath = path.join(temp, ...file.path.split('/'));
    const relative = path.relative(temp, outputPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`patch bundle path escapes destination: ${file.path}`);
    }
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from(file.contentBase64, 'base64'));
  }
  await fs.promises.rm(destination, { recursive: true, force: true });
  await fs.promises.rename(temp, destination);
}

export async function installPatchUpdate(params: {
  artifact: IncrementalUpdateArtifact;
  downloadedFilePath: string;
  rootDir: string;
  now?: string;
}): Promise<InstallPatchUpdateResult> {
  const { artifact, downloadedFilePath, rootDir } = params;
  const now = params.now ?? new Date().toISOString();
  if (artifact.kind !== 'patch') {
    return { ok: false, error: 'only patch artifacts can be installed by the patch updater' };
  }
  const sourceCommit = artifact.compat.sourceCommit;
  if (!sourceCommit) {
    return { ok: false, error: 'patch artifact must declare compat.sourceCommit' };
  }
  if (artifact.target !== RENDERER_CSS_TARGET) {
    return { ok: false, error: `unsupported patch target: ${artifact.target}` };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'patch id and version must be safe path segments' };
  }

  let actualSha256: string;
  try {
    actualSha256 = await computeFileSha256(downloadedFilePath);
  } catch (error) {
    return {
      ok: false,
      error: `failed to read downloaded patch artifact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (actualSha256 !== artifact.sha256.toLowerCase()) {
    return {
      ok: false,
      error: `patch artifact sha256 mismatch: expected ${artifact.sha256.slice(0, 12)}, got ${actualSha256.slice(0, 12)}`,
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(downloadedFilePath, 'utf8');
  } catch (error) {
    return { ok: false, error: `failed to read patch bundle: ${error instanceof Error ? error.message : String(error)}` };
  }
  const bundle = parsePatchBundle(raw);
  if (typeof bundle === 'string') return { ok: false, error: bundle };

  const registry = await readRegistry(rootDir, now);
  const previousId = registry.active.rendererCssPatchId;
  const previous = previousId ? registry.patches[previousId] ?? null : null;
  const patchDir = path.join(rootDir, 'store', safeId, safeVersion);
  const finalPath = path.join(patchDir, 'artifact.bundle.json');
  const extractedPath = path.join(patchDir, 'extracted');
  const activeCssPath = path.join(extractedPath, 'patch.css');

  try {
    await fs.promises.mkdir(patchDir, { recursive: true });
    await fs.promises.copyFile(downloadedFilePath, finalPath);
    await unpackBundle(bundle, extractedPath);
    await fs.promises.access(activeCssPath, fs.constants.R_OK);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const record: InstalledPatchRecord = {
    id: artifact.id,
    version: artifact.version,
    target: artifact.target,
    sourceCommit,
    artifactPath: finalPath,
    extractedPath,
    activeCssPath,
    sha256: actualSha256,
    signature: artifact.signature,
    size: artifact.size,
    installedAt: now,
  };
  const receipt: PatchRollbackReceipt = {
    id: artifact.id,
    target: artifact.target,
    fromVersion: previous?.version ?? null,
    toVersion: artifact.version,
    previousArtifactPath: previous?.artifactPath ?? null,
    previousActiveCssPath: previous?.activeCssPath ?? null,
    installedArtifactPath: finalPath,
    installedActiveCssPath: activeCssPath,
    createdAt: now,
  };

  registry.updatedAt = now;
  registry.patches[artifact.id] = record;
  registry.active.rendererCssPatchId = artifact.id;
  registry.receipts.push(receipt);
  await writeRegistry(rootDir, registry);
  return { ok: true, record, receipt };
}

export async function readActiveRendererCssPatch(rootDir: string): Promise<string | null> {
  const registry = await readRegistry(rootDir, new Date().toISOString());
  const activeId = registry.active.rendererCssPatchId;
  if (!activeId) return null;
  const active = registry.patches[activeId];
  if (!active?.activeCssPath) return null;
  return fs.promises.readFile(active.activeCssPath, 'utf8');
}
