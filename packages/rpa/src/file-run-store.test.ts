/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RpaConflictError, type RpaWorkflowV1 } from './contracts.js';
import { FileRpaRunStore } from './file-run-store.js';

const roots: string[] = [];
const workflow: RpaWorkflowV1 = {
  id: 'download-report',
  version: 1,
  steps: [{ id: 'download', action: 'web.click', args: { selector: '#download' }, sideEffect: 'external' }],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<FileRpaRunStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-rpa-'));
  roots.push(root);
  return new FileRpaRunStore(root);
}

describe('FileRpaRunStore', () => {
  it('persists run receipts and increments revisions atomically', async () => {
    const store = await createStore();
    const run = await store.create(workflow);
    run.state = 'running';
    run.receipts[0].state = 'started';
    const saved = await store.save(run, run.revision);
    const reloaded = await store.get(run.id);

    expect(saved.revision).toBe(2);
    expect(reloaded).toMatchObject({ state: 'running', receipts: [{ state: 'started' }] });
  });

  it('rejects a stale writer', async () => {
    const store = await createStore();
    const run = await store.create(workflow);
    const saved = await store.save(run, run.revision);

    await expect(store.save(run, run.revision)).rejects.toBeInstanceOf(RpaConflictError);
    expect(saved.revision).toBe(2);
  });
});
