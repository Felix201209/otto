/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyIncrementalArtifactSignature } from './incremental-signature.js';
import {
  installPatchUpdate,
  resolvePatchUpdateRoot,
  type InstalledPatchRecord,
  type PatchRollbackReceipt,
} from './incremental-patch-store.js';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { downloadToFile, type FetchLike } from './update-download.js';

export interface ApplyPatchUpdateOptions {
  artifact: IncrementalUpdateArtifact;
  userDataPath: string;
  allowedAssetOrigins?: readonly string[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: string;
  onProgress?: (transferred: number, total: number) => void;
  publicKey?: string;
}

export type ApplyPatchUpdateResult =
  | { ok: true; record: InstalledPatchRecord; receipt: PatchRollbackReceipt }
  | { ok: false; cancelled?: boolean; error: string };

function safePathSegment(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

export async function applyPatchUpdate(options: ApplyPatchUpdateOptions): Promise<ApplyPatchUpdateResult> {
  const { artifact } = options;
  if (artifact.kind !== 'patch') {
    return { ok: false, error: 'only patch artifacts can be applied by the patch updater' };
  }
  if (!artifact.compat.sourceCommit) {
    return { ok: false, error: 'patch artifact must declare compat.sourceCommit' };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'patch id and version must be safe path segments' };
  }

  const rootDir = resolvePatchUpdateRoot(options.userDataPath);
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

  const signed = await verifyIncrementalArtifactSignature({
    filePath: downloaded.filePath,
    signature: artifact.signature,
    publicKey: options.publicKey,
  });
  if (!signed.ok) {
    await fs.promises.rm(downloaded.filePath, { force: true }).catch(() => undefined);
    return { ok: false, error: signed.error };
  }

  const installed = await installPatchUpdate({
    artifact,
    downloadedFilePath: downloaded.filePath,
    rootDir,
    now: options.now,
  });
  await fs.promises.rm(downloaded.filePath, { force: true }).catch(() => undefined);
  return installed;
}
