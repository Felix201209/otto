/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyIncrementalArtifactSignature } from './incremental-signature.js';
import {
  installKernelUpdate,
  resolveKernelUpdateRoot,
  type InstalledKernelRecord,
  type KernelRollbackReceipt,
} from './incremental-kernel-store.js';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import { downloadToFile, type FetchLike } from './update-download.js';

export interface ApplyKernelUpdateOptions {
  artifact: IncrementalUpdateArtifact;
  userDataPath: string;
  allowedAssetOrigins?: readonly string[];
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: string;
  onProgress?: (transferred: number, total: number) => void;
  publicKey?: string;
}

export type ApplyKernelUpdateResult =
  | { ok: true; record: InstalledKernelRecord; receipt: KernelRollbackReceipt }
  | { ok: false; cancelled?: boolean; error: string };

function safePathSegment(value: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  if (value === '.' || value === '..') return null;
  return value;
}

export async function applyKernelUpdate(options: ApplyKernelUpdateOptions): Promise<ApplyKernelUpdateResult> {
  const { artifact } = options;
  if (artifact.kind !== 'kernel') {
    return { ok: false, error: 'only kernel artifacts can be applied by the kernel updater' };
  }
  if (!artifact.compat.kernelAbi) {
    return { ok: false, error: 'kernel artifact must declare compat.kernelAbi' };
  }
  const safeId = safePathSegment(artifact.id);
  const safeVersion = safePathSegment(artifact.version);
  if (!safeId || !safeVersion) {
    return { ok: false, error: 'kernel id and version must be safe path segments' };
  }

  const rootDir = resolveKernelUpdateRoot(options.userDataPath);
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

  const installed = await installKernelUpdate({
    artifact,
    downloadedFilePath: downloaded.filePath,
    rootDir,
    now: options.now,
  });
  await fs.promises.rm(downloaded.filePath, { force: true }).catch(() => undefined);
  return installed;
}
