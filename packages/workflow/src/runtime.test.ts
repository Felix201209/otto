/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from './contracts.js';
import { FileWorkflowStore } from './file-workflow-store.js';
import { WorkflowRuntime } from './runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<FileWorkflowStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-runtime-'));
  roots.push(root);
  return new FileWorkflowStore(root);
}

describe('WorkflowRuntime', () => {
  it('persists the claimed step before passing it to the executor', async () => {
    const store = await createStore();
    const execute = vi.fn().mockResolvedValue({ value: 'done' });
    const runtime = new WorkflowRuntime(store, { execute });
    const definition: WorkflowDefinition = {
      id: 'safe-read',
      version: 1,
      steps: [{ id: 'read', kind: 'tool', input: {}, sideEffect: 'none' }],
    };
    const run = await runtime.start(definition);

    const finished = await runtime.runNext(run.id);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ status: 'running', idempotencyKey: `${run.id}:read:1` }),
    }));
    expect(finished).toMatchObject({ status: 'succeeded' });
  });

  it('does not rerun an interrupted external step during recovery', async () => {
    const store = await createStore();
    const execute = vi.fn();
    const runtime = new WorkflowRuntime(store, { execute });
    const run = await runtime.start({
      id: 'send-notification',
      version: 1,
      steps: [{ id: 'send', kind: 'tool', input: {}, sideEffect: 'external' }],
    });
    const claimed = await store.claimNextStep(run.id, run.revision);

    const recovered = await runtime.recover(run.id);
    const afterResume = await runtime.runNext(run.id);

    expect(claimed?.step.status).toBe('running');
    expect(recovered).toMatchObject({ status: 'unknown_outcome' });
    expect(afterResume).toMatchObject({ status: 'unknown_outcome' });
    expect(execute).not.toHaveBeenCalled();
  });
});
