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
  installPatchUpdate,
  readActiveRendererCssPatch,
  readIncrementalPatchRegistry,
  resolvePatchUpdateRoot,
} from './incremental-patch-store.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-patch-update-'));
  return resolvePatchUpdateRoot(dir);
}

function artifact(body: string, overrides: Partial<IncrementalUpdateArtifact> = {}): IncrementalUpdateArtifact {
  return {
    id: 'patch-renderer-css-enterprise-login',
    kind: 'patch',
    version: '2026.07.25',
    target: 'desktop/renderer-css',
    compat: { appVersion: '1.9.5', sourceCommit: 'f09c18d' },
    url: 'https://updates.example.com/otto/patch-renderer-css-enterprise-login.bundle.json',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: 'ed25519:example',
    restart: 'renderer',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental patch store', () => {
  it('installs and activates a renderer css patch bundle', async () => {
    const root = await tempRoot();
    const body = bundle({ 'patch.css': '.enterprise-status{color:#0f766e}' });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    const result = await installPatchUpdate({
      artifact: artifact(body),
      downloadedFilePath: source,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.activeCssPath).toBe(path.join(result.record.extractedPath, 'patch.css'));
    expect(await readActiveRendererCssPatch(root)).toBe('.enterprise-status{color:#0f766e}');
    const registry = await readIncrementalPatchRegistry(root);
    expect(registry.active.rendererCssPatchId).toBe('patch-renderer-css-enterprise-login');
    expect(registry.receipts).toHaveLength(1);
    expect(registry.receipts[0]).toMatchObject({
      fromVersion: null,
      toVersion: '2026.07.25',
      previousArtifactPath: null,
      previousActiveCssPath: null,
      installedArtifactPath: result.record.artifactPath,
      installedActiveCssPath: result.record.activeCssPath,
    });
  });

  it('keeps previous active patch metadata in rollback receipt', async () => {
    const root = await tempRoot();
    await fs.mkdir(root, { recursive: true });
    const firstBody = bundle({ 'patch.css': '.a{color:red}' });
    const secondBody = bundle({ 'patch.css': '.a{color:blue}' });
    const first = path.join(root, 'first.bundle.json');
    const second = path.join(root, 'second.bundle.json');
    await fs.writeFile(first, firstBody);
    await fs.writeFile(second, secondBody);

    const firstInstall = await installPatchUpdate({
      artifact: artifact(firstBody),
      downloadedFilePath: first,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });
    const secondInstall = await installPatchUpdate({
      artifact: artifact(secondBody, { id: 'patch-renderer-css-enterprise-login-v2', version: '2026.07.26' }),
      downloadedFilePath: second,
      rootDir: root,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(firstInstall.ok).toBe(true);
    expect(secondInstall.ok).toBe(true);
    if (!firstInstall.ok || !secondInstall.ok) return;
    expect(secondInstall.receipt.fromVersion).toBe('2026.07.25');
    expect(secondInstall.receipt.previousArtifactPath).toBe(firstInstall.record.artifactPath);
    expect(secondInstall.receipt.previousActiveCssPath).toBe(firstInstall.record.activeCssPath);
    expect(await readActiveRendererCssPatch(root)).toBe('.a{color:blue}');
  });

  it('rejects unsafe ids, unsafe bundle paths and unsupported targets', async () => {
    const root = await tempRoot();
    const body = bundle({ 'patch.css': '.ok{display:block}' });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    await expect(installPatchUpdate({
      artifact: artifact(body, { id: '../bad' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'patch id and version must be safe path segments' });

    const unsafe = JSON.stringify({
      schemaVersion: 1,
      files: [{ path: '../patch.css', contentBase64: Buffer.from('bad').toString('base64') }],
    });
    const unsafePath = path.join(root, 'unsafe.bundle.json');
    await fs.writeFile(unsafePath, unsafe);
    await expect(installPatchUpdate({
      artifact: artifact(unsafe, { sha256: sha256(unsafe), size: Buffer.byteLength(unsafe) }),
      downloadedFilePath: unsafePath,
      rootDir: root,
    })).resolves.toMatchObject({ ok: false, error: 'patch bundle contains unsafe path: ../patch.css' });

    await expect(installPatchUpdate({
      artifact: artifact(body, { target: 'desktop/main-js' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'unsupported patch target: desktop/main-js' });
  });
});
