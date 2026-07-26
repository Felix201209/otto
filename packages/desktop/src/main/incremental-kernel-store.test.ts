/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import {
  installKernelUpdate,
  readActiveKernelBinPath,
  readActiveKernelModulePath,
  readIncrementalKernelRegistry,
  resolveKernelUpdateRoot,
} from './incremental-kernel-store.js';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function bundle(files: Record<string, string>): string {
  return JSON.stringify({
    schemaVersion: 1,
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      contentBase64: Buffer.from(content).toString('base64'),
    })),
  });
}

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kernel-update-'));
  return resolveKernelUpdateRoot(dir);
}

function artifact(body: string, overrides: Partial<IncrementalUpdateArtifact> = {}): IncrementalUpdateArtifact {
  return {
    id: 'kernel-server-runtime-2026-07',
    kind: 'kernel',
    version: '2026.07.25',
    target: 'server/runtime',
    compat: { appVersion: '1.9.5', kernelAbi: '2026.07' },
    url: 'https://updates.example.com/otto/kernel-server-runtime-2026-07.bundle.json',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: 'ed25519:example',
    restart: 'server',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental kernel store', () => {
  it('installs and activates a server runtime kernel bundle', async () => {
    const root = await tempRoot();
    const body = bundle({
      'dist/index.js': 'export const DEFAULT_PORT = 7637;\n',
      'dist/bin.js': 'import "./index.js";\n',
    });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    const result = await installKernelUpdate({
      artifact: artifact(body),
      downloadedFilePath: source,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.modulePath).toBe(path.join(result.record.extractedPath, 'dist', 'index.js'));
    expect(result.record.binPath).toBe(path.join(result.record.extractedPath, 'dist', 'bin.js'));
    expect(await readActiveKernelModulePath(root)).toBe(result.record.modulePath);
    expect(await readActiveKernelBinPath(root)).toBe(result.record.binPath);
    const registry = await readIncrementalKernelRegistry(root);
    expect(registry.active.serverRuntimeKernelId).toBe('kernel-server-runtime-2026-07');
    expect(registry.receipts[0]).toMatchObject({
      fromVersion: null,
      toVersion: '2026.07.25',
      installedModulePath: result.record.modulePath,
      installedBinPath: result.record.binPath,
    });
  });

  it('keeps previous active kernel metadata in rollback receipt', async () => {
    const root = await tempRoot();
    await fs.mkdir(root, { recursive: true });
    const firstBody = bundle({ 'dist/index.js': 'export const v = 1;\n', 'dist/bin.js': 'import "./index.js";\n' });
    const secondBody = bundle({ 'dist/index.js': 'export const v = 2;\n', 'dist/bin.js': 'import "./index.js";\n' });
    const first = path.join(root, 'first.bundle.json');
    const second = path.join(root, 'second.bundle.json');
    await fs.writeFile(first, firstBody);
    await fs.writeFile(second, secondBody);

    const firstInstall = await installKernelUpdate({ artifact: artifact(firstBody), downloadedFilePath: first, rootDir: root });
    const secondInstall = await installKernelUpdate({
      artifact: artifact(secondBody, { id: 'kernel-server-runtime-2026-07-v2', version: '2026.07.26' }),
      downloadedFilePath: second,
      rootDir: root,
    });

    expect(firstInstall.ok).toBe(true);
    expect(secondInstall.ok).toBe(true);
    if (!firstInstall.ok || !secondInstall.ok) return;
    expect(secondInstall.receipt.fromVersion).toBe('2026.07.25');
    expect(secondInstall.receipt.previousModulePath).toBe(firstInstall.record.modulePath);
    expect(secondInstall.receipt.previousBinPath).toBe(firstInstall.record.binPath);
  });

  it('rejects unsafe ids, unsafe paths, missing entries and unsupported targets', async () => {
    const root = await tempRoot();
    const body = bundle({ 'dist/index.js': 'export {};\n', 'dist/bin.js': 'import "./index.js";\n' });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    await expect(installKernelUpdate({
      artifact: artifact(body, { id: '../bad' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'kernel id and version must be safe path segments' });

    const unsafe = JSON.stringify({
      schemaVersion: 1,
      files: [{ path: '../dist/index.js', contentBase64: Buffer.from('bad').toString('base64') }],
    });
    const unsafePath = path.join(root, 'unsafe.bundle.json');
    await fs.writeFile(unsafePath, unsafe);
    await expect(installKernelUpdate({
      artifact: artifact(unsafe, { sha256: sha256(unsafe), size: Buffer.byteLength(unsafe) }),
      downloadedFilePath: unsafePath,
      rootDir: root,
    })).resolves.toMatchObject({ ok: false, error: 'kernel bundle contains unsafe path: ../dist/index.js' });

    const missingBin = bundle({ 'dist/index.js': 'export {};\n' });
    const missingPath = path.join(root, 'missing.bundle.json');
    await fs.writeFile(missingPath, missingBin);
    await expect(installKernelUpdate({
      artifact: artifact(missingBin, { sha256: sha256(missingBin), size: Buffer.byteLength(missingBin) }),
      downloadedFilePath: missingPath,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'server runtime kernel bundle must contain dist/bin.js' });

    await expect(installKernelUpdate({
      artifact: artifact(body, { target: 'native/runtime' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'unsupported kernel target: native/runtime' });
  });
});
