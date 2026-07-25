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
  installComponentUpdate,
  readIncrementalComponentRegistry,
  resolveComponentUpdateRoot,
} from './incremental-component-store.js';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-update-'));
  return resolveComponentUpdateRoot(dir);
}

function artifact(overrides: Partial<IncrementalUpdateArtifact> = {}): IncrementalUpdateArtifact {
  const body = 'component payload v1';
  return {
    id: 'component-skills-ppt-v2',
    kind: 'component',
    version: '2026.07.25',
    target: 'skills/presentations',
    compat: { appVersion: '1.9.5', componentApi: 'skills.v1' },
    url: 'https://updates.example.com/otto/component-skills-ppt-v2.bin',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: 'ed25519:example',
    restart: 'none',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental component store', () => {
  it('installs a verified component artifact and records a rollback receipt', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'download.bin');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, 'component payload v1');

    const result = await installComponentUpdate({
      artifact: artifact(),
      downloadedFilePath: source,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.componentApi).toBe('skills.v1');
    expect(await fs.readFile(result.record.artifactPath, 'utf8')).toBe('component payload v1');
    expect(result.receipt).toMatchObject({
      fromVersion: null,
      toVersion: '2026.07.25',
      previousArtifactPath: null,
      installedArtifactPath: result.record.artifactPath,
    });

    const registry = await readIncrementalComponentRegistry(root);
    expect(registry.components['component-skills-ppt-v2'].version).toBe('2026.07.25');
    expect(registry.receipts).toHaveLength(1);
  });

  it('keeps previous component metadata in the next receipt for rollback', async () => {
    const root = await tempRoot();
    await fs.mkdir(root, { recursive: true });
    const first = path.join(root, 'first.bin');
    const second = path.join(root, 'second.bin');
    await fs.writeFile(first, 'component payload v1');
    await fs.writeFile(second, 'component payload v2');

    const firstInstall = await installComponentUpdate({
      artifact: artifact(),
      downloadedFilePath: first,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });
    expect(firstInstall.ok).toBe(true);
    const secondArtifact = artifact({
      version: '2026.07.26',
      sha256: sha256('component payload v2'),
      size: Buffer.byteLength('component payload v2'),
    });
    const secondInstall = await installComponentUpdate({
      artifact: secondArtifact,
      downloadedFilePath: second,
      rootDir: root,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(secondInstall.ok).toBe(true);
    if (!firstInstall.ok || !secondInstall.ok) return;
    expect(secondInstall.receipt.fromVersion).toBe('2026.07.25');
    expect(secondInstall.receipt.previousArtifactPath).toBe(firstInstall.record.artifactPath);
    const registry = await readIncrementalComponentRegistry(root);
    expect(registry.components['component-skills-ppt-v2'].version).toBe('2026.07.26');
    expect(registry.receipts).toHaveLength(2);
  });

  it('rejects path traversal ids and sha256 mismatches', async () => {
    const root = await tempRoot();
    const source = path.join(root, 'download.bin');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, 'component payload v1');

    await expect(installComponentUpdate({
      artifact: artifact({ id: '../bad' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'component id and version must be safe path segments' });

    await expect(installComponentUpdate({
      artifact: artifact({ sha256: '0'.repeat(64) }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toMatchObject({ ok: false });
  });
});
