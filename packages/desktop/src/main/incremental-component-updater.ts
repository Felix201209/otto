/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { downloadToFile, type FetchLike } from './update-download.js';
import {
  installComponentUpdate,
  resolveComponentUpdateRoot,
  type ComponentRollbackReceipt,
  type InstalledComponentRecord,
} from './incremental-component-store.js';

export interface ApplyComponentUpdateOptions {
  artifact: IncrementalUpdateArtifact;
  userDataPath: string;
  allowedAssetOrigins?: readonly string[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: string;
  onProgress?: (transferred: number, total: number) => void;
}

export type ApplyComponentUpdateResult =
  | { ok: true; record: InstalledComponentRecord; receipt: ComponentRollbackReceipt }
  | { ok: false; cancelled?: boolean; error: string };

function safePathSegment(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

export async function applyComponentUpdate(
  options: ApplyComponentUpdateOptions,
): Promise<ApplyComponentUpdateResult> {
  const { artifact } = options;
  if (artifact.kind !== 'component') {
    return { ok: false, error: 'only component artifacts can be applied by the component updater' };
  }
  if (!artifact.compat.componentApi) {
    return { ok: false, error: 'component artifact must declare compat.componentApi' };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'component id and version must be safe path segments' };
  }

  const rootDir = resolveComponentUpdateRoot(options.userDataPath);
  const downloadDir = path.join(rootDir, 'downloads', safeId, safeVersion);
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const finalPath = path.join(downloadDir, 'artifact.bin');
  const partPath = `${finalPath}.part`;
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal ?? controller?.signal;
  if (!signal) return { ok: false, error: 'missing abort signal' };

  const downloaded = await downloadToFile({
    url: artifact.url,
    allowedAssetOrigins: options.allowedAssetOrigins,
    expectedSha256: artifact.sha256,
    expectedSize: artifact.size,
    partPath,
    finalPath,
    signal,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress ?? (() => undefined),
  });
  if (!downloaded.ok) return downloaded;

  const installed = await installComponentUpdate({
    artifact,
    downloadedFilePath: downloaded.filePath,
    rootDir,
    now: options.now,
  });
  await fs.promises.rm(downloaded.filePath, { force: true }).catch(() => undefined);
  return installed;
}
