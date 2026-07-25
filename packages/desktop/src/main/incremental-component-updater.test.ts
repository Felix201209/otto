/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IncrementalUpdateArtifact } from './incremental-update-manifest.js';
import type { FetchLike } from './update-download.js';
import { applyComponentUpdate } from './incremental-component-updater.js';
import { readIncrementalComponentRegistry, resolveComponentUpdateRoot } from './incremental-component-store.js';

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fetchBody(body: string, url = 'https://updates.example.com/otto/component.bin'): FetchLike {
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
    id: 'component-skills-ppt-v2',
    kind: 'component',
    version: '2026.07.25',
    target: 'skills/presentations',
    compat: { appVersion: '1.9.5', componentApi: 'skills.v1' },
    url: 'https://updates.example.com/otto/component.bin',
    size: Buffer.byteLength(body),
    sha256: sha256(body),
    signature: 'ed25519:example',
    restart: 'none',
    rollback: { supported: true, receipt: true },
    ...overrides,
  };
}

describe('incremental component updater', () => {
  it('downloads, verifies and registers a component update', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-apply-'));
    const body = bundle({ 'SKILL.md': '---\nname: presentations\ndescription: PPT skill\n---\n# PPT' });
    const result = await applyComponentUpdate({
      artifact: artifact(body),
      userDataPath,
      allowedAssetOrigins: ['https://updates.example.com'],
      fetchImpl: fetchBody(body),
      now: '2026-07-25T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await fs.readFile(result.record.artifactPath, 'utf8')).toBe(body);
    expect(result.record.exposedPath).toBeTruthy();
    expect(await fs.readFile(path.join(result.record.exposedPath!, 'SKILL.md'), 'utf8')).toContain('PPT skill');
    const registry = await readIncrementalComponentRegistry(resolveComponentUpdateRoot(userDataPath));
    expect(registry.components['component-skills-ppt-v2'].artifactPath).toBe(result.record.artifactPath);
    await expect(fs.access(path.join(resolveComponentUpdateRoot(userDataPath), 'downloads', 'component-skills-ppt-v2', '2026.07.25', 'artifact.bin'))).rejects.toThrow();
  });

  it('rejects unapproved artifact origins before writing registry state', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-apply-'));
    const body = bundle({ 'SKILL.md': '---\nname: presentations\ndescription: PPT skill\n---\n# PPT' });
    const result = await applyComponentUpdate({
      artifact: artifact(body),
      userDataPath,
      fetchImpl: fetchBody(body),
    });

    expect(result.ok).toBe(false);
    const registry = await readIncrementalComponentRegistry(resolveComponentUpdateRoot(userDataPath));
    expect(Object.keys(registry.components)).toEqual([]);
  });

  it('rejects sha256 mismatches before registry install', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-component-apply-'));
    const result = await applyComponentUpdate({
      artifact: artifact(bundle({ 'SKILL.md': '---\nname: presentations\ndescription: expected\n---\n# expected' })),
      userDataPath,
      allowedAssetOrigins: ['https://updates.example.com'],
      fetchImpl: fetchBody(bundle({ 'SKILL.md': '---\nname: presentations\ndescription: tampered\n---\n# tampered' })),
    });

    expect(result.ok).toBe(false);
    const registry = await readIncrementalComponentRegistry(resolveComponentUpdateRoot(userDataPath));
    expect(Object.keys(registry.components)).toEqual([]);
  });
});
