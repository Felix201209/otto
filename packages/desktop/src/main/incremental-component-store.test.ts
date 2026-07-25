/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import {
  installComponentUpdate,
  readIncrementalComponentRegistry,
  resolveComponentUpdateRoot,
} from './incremental-component-store.js';

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

async function tempRoot(): Promise<{ root: string; userDir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-update-'));
  const userDir = path.join(dir, 'otto-user');
  vi.stubEnv('OTTO_USER_DIR', userDir);
  return { root: resolveComponentUpdateRoot(dir), userDir };
}

function artifact(body: string, overrides: Partial<IncrementalUpdateArtifact> = {}): IncrementalUpdateArtifact {
  return {
    id: 'component-skills-ppt-v2',
    kind: 'component',
    version: '2026.07.25',
    target: 'skills/presentations',
    compat: { appVersion: '1.9.5', componentApi: 'skills.v1' },
    url: 'https://updates.example.com/otto/component-skills-ppt-v2.bundle.json',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: 'ed25519:example',
    restart: 'none',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental component store', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('installs, unpacks and exposes a skills component bundle', async () => {
    const { root, userDir } = await tempRoot();
    const body = bundle({
      'SKILL.md': '---\nname: presentations\ndescription: Better PPT skill\n---\n# PPT',
      'scripts/create.py': 'print("ppt")\n',
    });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    const result = await installComponentUpdate({
      artifact: artifact(body),
      downloadedFilePath: source,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.componentApi).toBe('skills.v1');
    expect(result.record.extractedPath).toBeTruthy();
    expect(result.record.exposedPath).toBe(path.join(userDir, 'skills', 'presentations'));
    expect(await fs.readFile(path.join(result.record.exposedPath!, 'SKILL.md'), 'utf8')).toContain('Better PPT skill');
    expect(await fs.readFile(path.join(result.record.exposedPath!, 'scripts', 'create.py'), 'utf8')).toBe('print("ppt")\n');
    expect(result.receipt).toMatchObject({
      fromVersion: null,
      toVersion: '2026.07.25',
      previousArtifactPath: null,
      previousExposedPath: null,
      installedArtifactPath: result.record.artifactPath,
      installedExposedPath: result.record.exposedPath,
    });

    const registry = await readIncrementalComponentRegistry(root);
    expect(registry.components['component-skills-ppt-v2'].version).toBe('2026.07.25');
    expect(registry.components['component-skills-ppt-v2'].exposedPath).toBe(result.record.exposedPath);
    expect(registry.receipts).toHaveLength(1);
  });

  it('keeps previous component metadata in the next receipt for rollback', async () => {
    const { root } = await tempRoot();
    await fs.mkdir(root, { recursive: true });
    const firstBody = bundle({ 'SKILL.md': '---\nname: presentations\ndescription: v1\n---\n# v1' });
    const secondBody = bundle({ 'SKILL.md': '---\nname: presentations\ndescription: v2\n---\n# v2' });
    const first = path.join(root, 'first.bundle.json');
    const second = path.join(root, 'second.bundle.json');
    await fs.writeFile(first, firstBody);
    await fs.writeFile(second, secondBody);

    const firstInstall = await installComponentUpdate({
      artifact: artifact(firstBody),
      downloadedFilePath: first,
      rootDir: root,
      now: '2026-07-25T00:00:00.000Z',
    });
    expect(firstInstall.ok).toBe(true);
    const secondArtifact = artifact(secondBody, { version: '2026.07.26' });
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
    expect(secondInstall.receipt.previousExposedPath).toBe(firstInstall.record.exposedPath);
    expect(await fs.readFile(path.join(secondInstall.record.exposedPath!, 'SKILL.md'), 'utf8')).toContain('v2');
    const registry = await readIncrementalComponentRegistry(root);
    expect(registry.components['component-skills-ppt-v2'].version).toBe('2026.07.26');
    expect(registry.receipts).toHaveLength(2);
  });

  it('rejects path traversal ids, unsafe bundle paths and sha256 mismatches', async () => {
    const { root } = await tempRoot();
    const body = bundle({ 'SKILL.md': '---\nname: ok\ndescription: ok\n---\n# ok' });
    const source = path.join(root, 'download.bundle.json');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(source, body);

    await expect(installComponentUpdate({
      artifact: artifact(body, { id: '../bad' }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toEqual({ ok: false, error: 'component id and version must be safe path segments' });

    const unsafe = JSON.stringify({
      schemaVersion: 1,
      files: [{ path: '../SKILL.md', contentBase64: Buffer.from('bad').toString('base64') }],
    });
    const unsafePath = path.join(root, 'unsafe.bundle.json');
    await fs.writeFile(unsafePath, unsafe);
    await expect(installComponentUpdate({
      artifact: artifact(unsafe, { sha256: sha256(unsafe), size: Buffer.byteLength(unsafe) }),
      downloadedFilePath: unsafePath,
      rootDir: root,
    })).resolves.toMatchObject({ ok: false, error: 'component bundle contains unsafe path: ../SKILL.md' });

    await expect(installComponentUpdate({
      artifact: artifact(body, { sha256: '0'.repeat(64) }),
      downloadedFilePath: source,
      rootDir: root,
    })).resolves.toMatchObject({ ok: false });
  });
});
