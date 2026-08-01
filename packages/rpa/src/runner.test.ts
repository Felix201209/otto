/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import type { RpaRun, RpaWorkflowV1 } from './contracts.js';
import { RpaRunner } from './runner.js';
import type { RpaRunStore } from './ports.js';

function memoryStore(): RpaRunStore {
  const runs = new Map<string, RpaRun>();
  return {
    async create(workflow) {
      const id = 'rpa-run-1';
      const timestamp = new Date().toISOString();
      const run: RpaRun = {
        id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        state: 'pending',
        revision: 1,
        currentStepId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        receipts: workflow.steps.map((step) => ({
          stepId: step.id, attempt: 0, state: 'pending', idempotencyKey: `${id}:${step.id}:0`, artifactIds: [],
        })),
      };
      runs.set(id, run);
      return structuredClone(run);
    },
    async get(id) {
      const run = runs.get(id);
      return run ? structuredClone(run) : null;
    },
    async save(run, expectedRevision) {
      const current = runs.get(run.id);
      if (!current || current.revision !== expectedRevision) throw new Error('revision conflict');
      const next = structuredClone(run);
      next.revision += 1;
      next.updatedAt = new Date().toISOString();
      runs.set(next.id, next);
      return structuredClone(next);
    },
  };
}

const workflow: RpaWorkflowV1 = {
  id: 'download-report',
  version: 1,
  steps: [{ id: 'download', action: 'web.click', args: { selector: '#download' }, sideEffect: 'external' }],
};

describe('RpaRunner', () => {
  it('does not invoke the driver when policy denies an action', async () => {
    const execute = vi.fn();
    const runner = new RpaRunner([workflow], memoryStore(), {
      authorize: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'approval required' }),
    }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const result = await runner.runNext(run.id);

    expect(result).toMatchObject({ state: 'failed' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records evidence and never replays an interrupted external action', async () => {
    const store = memoryStore();
    const execute = vi.fn().mockResolvedValue({ output: { downloaded: true } });
    const runner = new RpaRunner([workflow], store, { authorize: vi.fn().mockResolvedValue({ decision: 'allow' }) }, { execute }, {
      put: vi.fn().mockResolvedValue({ id: 'artifact-1', sha256: 'a'.repeat(64), mediaType: 'image/png', redactedSummary: 'page screenshot' }),
    });
    const run = await runner.start(workflow.id);
    const claimed = await store.get(run.id);
    claimed!.state = 'running';
    claimed!.currentStepId = 'download';
    claimed!.receipts[0].state = 'started';
    claimed!.receipts[0].attempt = 1;
    await store.save(claimed!, claimed!.revision);

    const recovered = await runner.recover(run.id);
    const afterResume = await runner.runNext(run.id);

    expect(recovered).toMatchObject({ state: 'unknown_outcome' });
    expect(afterResume).toMatchObject({ state: 'unknown_outcome' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a matching human approval before resuming a paused step', async () => {
    const store = memoryStore();
    const authorize = vi.fn()
      .mockResolvedValueOnce({ decision: 'awaiting_approval', approvalId: 'approval-1' })
      .mockResolvedValueOnce({ decision: 'allow' });
    const execute = vi.fn().mockResolvedValue({ output: { downloaded: true } });
    const runner = new RpaRunner([workflow], store, { authorize }, { execute }, { put: vi.fn() });
    const run = await runner.start(workflow.id);

    const waiting = await runner.runNext(run.id);
    await expect(runner.approve(run.id, 'wrong')).rejects.toThrow('not waiting');
    const approved = await runner.approve(run.id, 'approval-1');
    const completed = await runner.runNext(run.id);

    expect(waiting).toMatchObject({ state: 'awaiting_approval' });
    expect(approved?.receipts[0]).toMatchObject({ approvalId: 'approval-1' });
    expect(completed).toMatchObject({ state: 'pending', receipts: [{ state: 'succeeded' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
