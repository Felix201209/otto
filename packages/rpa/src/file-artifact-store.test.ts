/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRpaArtifactStore } from './file-artifact-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileRpaArtifactStore', () => {
  it('stores a content-hashed artifact and only returns a redacted summary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-artifact-'));
    roots.push(root);
    const store = new FileRpaArtifactStore(root);

    const artifact = await store.put({
      mediaType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      redactedSummary: 'screenshot\nwith sensitive page text removed',
    });

    expect(artifact).toMatchObject({ mediaType: 'image/png', redactedSummary: 'screenshot with sensitive page text removed' });
    expect(artifact.sha256).toHaveLength(64);
    expect(await readdir(root)).toEqual([`${artifact.id}.png`]);
  });
});
