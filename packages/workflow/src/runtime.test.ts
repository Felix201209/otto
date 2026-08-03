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
    const trace = { append: vi.fn().mockResolvedValue(undefined) };
    const runtime = new WorkflowRuntime(store, { execute }, trace);
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
    expect(trace.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run_started' }));
    expect(trace.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step_claimed' }));
    expect(trace.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step_succeeded' }));
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
    const waiting = await store.claimNextStep(run.id, run.revision);
    const approved = await runtime.approve(run.id, 'send', waiting!.step.approvalId!);
    const claimed = await store.claimNextStep(run.id, approved!.revision);

    const recovered = await runtime.recover(run.id);
    const afterResume = await runtime.runNext(run.id);

    expect(waiting?.step.status).toBe('waiting_approval');
    expect(claimed?.step.status).toBe('running');
    expect(recovered).toMatchObject({ status: 'unknown_outcome' });
    expect(afterResume).toMatchObject({ status: 'unknown_outcome' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records approval before executing an external step', async () => {
    const store = await createStore();
    const trace = { append: vi.fn().mockResolvedValue(undefined) };
    const runtime = new WorkflowRuntime(store, { execute: vi.fn().mockResolvedValue({ ok: true }) }, trace);
    const run = await runtime.start({
      id: 'approved-send',
      version: 1,
      steps: [{ id: 'send', kind: 'tool', input: {}, sideEffect: 'external' }],
    });
    const waiting = await runtime.runNext(run.id);
    const approved = await runtime.approve(run.id, 'send', waiting!.steps[0].approvalId!);

    expect(waiting).toMatchObject({ status: 'waiting_approval' });
    expect(approved).toMatchObject({ status: 'queued', steps: [expect.objectContaining({ approvedAt: expect.any(String) })] });
    expect(trace.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step_claimed', status: 'waiting_approval' }));
    expect(trace.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval_recorded' }));
  });
});
