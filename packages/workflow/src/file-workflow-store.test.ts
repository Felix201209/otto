/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowConflictError, type WorkflowDefinition } from './contracts.js';
import { FileWorkflowStore } from './file-workflow-store.js';

const definition: WorkflowDefinition = {
  id: 'monthly-report',
  version: 1,
  steps: [
    { id: 'read', kind: 'tool', input: { tool: 'read_file' }, sideEffect: 'none' },
    { id: 'send', kind: 'tool', input: { tool: 'send_message' }, sideEffect: 'external' },
  ],
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore(): Promise<FileWorkflowStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'otto-workflow-'));
  roots.push(root);
  return new FileWorkflowStore(root);
}

describe('FileWorkflowStore', () => {
  it('creates and atomically advances a run one step at a time', async () => {
    const store = await createStore();
    const run = await store.createRun(definition);

    const claimed = await store.claimNextStep(run.id, run.revision);
    expect(claimed?.step).toMatchObject({ stepId: 'read', attempt: 1, status: 'running' });
    expect(claimed?.step.idempotencyKey).toBe(`${run.id}:read:1`);

    const completed = await store.completeStep({
      runId: run.id,
      stepId: 'read',
      expectedRevision: claimed!.run.revision,
      output: { contents: 'ok' },
    });
    expect(completed.status).toBe('queued');
    expect(completed.steps[0]).toMatchObject({ stepId: 'read', status: 'succeeded' });
  });

  it('rejects stale writers instead of losing a completed step', async () => {
    const store = await createStore();
    const run = await store.createRun(definition);
    const claimed = await store.claimNextStep(run.id, run.revision);

    await expect(store.completeStep({
      runId: run.id,
      stepId: 'read',
      expectedRevision: run.revision,
    })).rejects.toBeInstanceOf(WorkflowConflictError);
    await store.completeStep({ runId: run.id, stepId: 'read', expectedRevision: claimed!.run.revision });
  });

  it('turns an interrupted external side effect into unknown_outcome instead of replaying it', async () => {
    const store = await createStore();
    const run = await store.createRun(definition);
    const first = await store.claimNextStep(run.id, run.revision);
    const afterFirst = await store.completeStep({
      runId: run.id,
      stepId: 'read',
      expectedRevision: first!.run.revision,
    });
    const second = await store.claimNextStep(run.id, afterFirst.revision);

    const recovered = await store.recoverInterruptedRun(run.id, second!.run.revision);
    expect(recovered.status).toBe('unknown_outcome');
    expect(recovered.steps[1]).toMatchObject({ stepId: 'send', status: 'unknown_outcome' });
  });
});
