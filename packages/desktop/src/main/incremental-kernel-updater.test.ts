/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyKernelUpdate } from './incremental-kernel-updater.js';
import { readIncrementalKernelRegistry, resolveKernelUpdateRoot } from './incremental-kernel-store.js';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import type { FetchLike } from './update-download.js';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function signingFixture(body: string): { signature: string; publicKey: string } {
  const keys = generateKeyPairSync('ed25519');
  return {
    signature: `ed25519:${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`,
    publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function fetchBody(body: string, url = 'https://updates.example.com/otto/kernel.bin'): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(body));
        controller.close();
      },
    }),
  });
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

function artifact(body: string, overrides: Partial<IncrementalUpdateArtifact> = {}): IncrementalUpdateArtifact {
  return {
    id: 'kernel-server-runtime-2026-07',
    kind: 'kernel',
    version: '2026.07.25',
    target: 'server/runtime',
    compat: { appVersion: '1.9.5', kernelAbi: '2026.07' },
    url: 'https://updates.example.com/otto/kernel.bin',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: overrides.signature ?? signingFixture(body).signature,
    restart: 'server',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental kernel updater', () => {
  it('downloads, verifies and registers a server runtime kernel', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kernel-apply-'));
    const body = bundle({ 'dist/index.js': 'export const DEFAULT_PORT = 7637;\n', 'dist/bin.js': 'import "./index.js";\n' });
    const signed = signingFixture(body);
    const result = await applyKernelUpdate({
      artifact: artifact(body, { signature: signed.signature }),
      userDataPath,
      allowedAssetOrigins: ['https://updates.example.com'],
      fetchImpl: fetchBody(body),
      now: '2026-07-25T00:00:00.000Z',
      publicKey: signed.publicKey,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await fs.readFile(result.record.modulePath, 'utf8')).toContain('DEFAULT_PORT');
    const registry = await readIncrementalKernelRegistry(resolveKernelUpdateRoot(userDataPath));
    expect(registry.active.serverRuntimeKernelId).toBe('kernel-server-runtime-2026-07');
    await expect(fs.access(path.join(resolveKernelUpdateRoot(userDataPath), 'downloads', 'kernel-server-runtime-2026-07', '2026.07.25', 'artifact.bin'))).rejects.toThrow();
  });

  it('rejects unapproved artifact origins before writing registry state', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kernel-apply-'));
    const body = bundle({ 'dist/index.js': 'export {};\n', 'dist/bin.js': 'import "./index.js";\n' });
    const signed = signingFixture(body);
    const result = await applyKernelUpdate({
      artifact: artifact(body, { signature: signed.signature }),
      userDataPath,
      fetchImpl: fetchBody(body),
      publicKey: signed.publicKey,
    });

    expect(result.ok).toBe(false);
    const registry = await readIncrementalKernelRegistry(resolveKernelUpdateRoot(userDataPath));
    expect(Object.keys(registry.kernels)).toEqual([]);
  });

  it('rejects invalid Ed25519 signatures before registry install', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kernel-apply-'));
    const body = bundle({ 'dist/index.js': 'export {};\n', 'dist/bin.js': 'import "./index.js";\n' });
    const signedOtherBody = signingFixture('different body');
    const result = await applyKernelUpdate({
      artifact: artifact(body, { signature: signedOtherBody.signature }),
      userDataPath,
      allowedAssetOrigins: ['https://updates.example.com'],
      fetchImpl: fetchBody(body),
      publicKey: signedOtherBody.publicKey,
    });

    expect(result).toEqual({ ok: false, error: 'artifact Ed25519 signature verification failed' });
    const registry = await readIncrementalKernelRegistry(resolveKernelUpdateRoot(userDataPath));
    expect(Object.keys(registry.kernels)).toEqual([]);
  });
});
