/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkflowConflictError,
  type ClaimedWorkflowStep,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepRun,
} from './contracts.js';
import { cloneRun, nextQueuedStep, type WorkflowStore } from './store.js';

function now(): string {
  return new Date().toISOString();
}

function createStepRun(runId: string, step: WorkflowDefinition['steps'][number]): WorkflowStepRun {
  return {
    stepId: step.id,
    kind: step.kind,
    attempt: 0,
    status: 'queued',
    idempotencyKey: `${runId}:${step.id}:0`,
    input: structuredClone(step.input),
    sideEffect: step.sideEffect,
    requiresApproval: step.requiresApproval === true || step.sideEffect === 'external',
  };
}

/**
 * File-backed workflow state for local execution. Every update is written to a
 * temporary file then atomically renamed; a per-run exclusive lease prevents
 * two local workers from claiming or completing the same step.
 */
export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly rootDir: string) {}

  async createRun(definition: WorkflowDefinition): Promise<WorkflowRun> {
    this.assertDefinition(definition);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const id = `wf-${randomUUID()}`;
    const timestamp = now();
    const run: WorkflowRun = {
      id,
      definitionId: definition.id,
      definitionVersion: definition.version,
      status: 'queued',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      steps: definition.steps.map((step) => createStepRun(id, step)),
    };
    await this.writeRun(run);
    return cloneRun(run);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    this.assertRunId(runId);
    try {
      return cloneRun(await this.readRun(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async claimNextStep(runId: string, expectedRevision: number): Promise<ClaimedWorkflowStep | null> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      if (run.status === 'unknown_outcome' || run.status === 'cancelled' || run.status === 'failed') return null;
      const step = nextQueuedStep(run);
      if (!step) return null;

      step.status = step.requiresApproval && !step.approvedAt ? 'waiting_approval' : 'running';
      step.attempt += 1;
      step.idempotencyKey = `${run.id}:${step.stepId}:${step.attempt}`;
      step.approvalId = step.status === 'waiting_approval' ? `approval-${run.id}-${step.stepId}-${step.attempt}` : undefined;
      step.startedAt = now();
      run.status = step.status === 'waiting_approval' ? 'waiting_approval' : 'running';
      const saved = await this.saveRevision(run);
      return { run: cloneRun(saved), step: structuredClone(step) };
    });
  }

  async completeStep(input: {
    runId: string;
    stepId: string;
    expectedRevision: number;
    output?: unknown;
    error?: string;
  }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      this.assertRevision(run, input.expectedRevision);
      const step = run.steps.find((candidate) => candidate.stepId === input.stepId);
      if (!step || step.status !== 'running') {
        throw new WorkflowConflictError(`Workflow step is not running: ${input.stepId}`);
      }
      step.status = input.error ? 'failed' : 'succeeded';
      step.output = input.output === undefined ? undefined : structuredClone(input.output);
      step.error = input.error;
      step.completedAt = now();
      run.status = input.error ? 'failed' : nextQueuedStep(run) ? 'queued' : 'succeeded';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async approveStep(input: { runId: string; stepId: string; approvalId: string; expectedRevision: number }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      this.assertRevision(run, input.expectedRevision);
      const step = run.steps.find((candidate) => candidate.stepId === input.stepId);
      if (!step || step.status !== 'waiting_approval' || step.approvalId !== input.approvalId) {
        throw new WorkflowConflictError(`Workflow step is not waiting for this approval: ${input.stepId}`);
      }
      step.status = 'queued';
      step.approvedAt = now();
      step.approvalId = undefined;
      run.status = 'queued';
      return cloneRun(await this.saveRevision(run));
    });
  }

  async recoverInterruptedRun(runId: string, expectedRevision: number): Promise<WorkflowRun> {
    return this.withLease(runId, async () => {
      const run = await this.readRun(runId);
      this.assertRevision(run, expectedRevision);
      const running = run.steps.find((step) => step.status === 'running');
      if (!running) return cloneRun(run);

      if (running.sideEffect === 'external') {
        running.status = 'unknown_outcome';
        running.error = 'Execution was interrupted after an external side effect began; reconciliation or human takeover is required.';
        run.status = 'unknown_outcome';
      } else {
        running.status = 'queued';
        running.error = undefined;
        running.startedAt = undefined;
        run.status = 'queued';
      }
      return cloneRun(await this.saveRevision(run));
    });
  }

  async takeOverUnknownRun(input: { runId: string; note: string; expectedRevision: number }): Promise<WorkflowRun> {
    return this.withLease(input.runId, async () => {
      const run = await this.readRun(input.runId);
      this.assertRevision(run, input.expectedRevision);
      if (run.status !== 'unknown_outcome') throw new WorkflowConflictError('Workflow run is not in unknown_outcome.');
      const active = run.steps.find((step) => step.status === 'unknown_outcome');
      if (!active) throw new WorkflowConflictError('Workflow run has no unknown step to take over.');
      active.status = 'cancelled';
      active.error = `Human takeover: ${input.note.trim().slice(0, 500) || 'reconciliation required'}`;
      active.completedAt = now();
      run.status = 'cancelled';
      return cloneRun(await this.saveRevision(run));
    });
  }

  private async withLease<T>(runId: string, action: () => Promise<T>): Promise<T> {
    this.assertRunId(runId);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.rootDir, `${runId}.lock`);
    let lease;
    try {
      lease = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WorkflowConflictError(`Workflow run is already leased: ${runId}`);
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await lease.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  private async readRun(runId: string): Promise<WorkflowRun> {
    const parsed = JSON.parse(await readFile(this.runPath(runId), 'utf8')) as WorkflowRun;
    this.assertRun(parsed);
    return parsed;
  }

  private async saveRevision(run: WorkflowRun): Promise<WorkflowRun> {
    run.revision += 1;
    run.updatedAt = now();
    await this.writeRun(run);
    return run;
  }

  private async writeRun(run: WorkflowRun): Promise<void> {
    const target = this.runPath(run.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private runPath(runId: string): string {
    this.assertRunId(runId);
    return path.join(this.rootDir, `${runId}.json`);
  }

  private assertDefinition(definition: WorkflowDefinition): void {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(definition.id) || definition.steps.length === 0) {
      throw new Error('Workflow definition is invalid.');
    }
    const ids = new Set<string>();
    for (const step of definition.steps) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(step.id) || ids.has(step.id)) {
        throw new Error('Workflow step ids must be unique and stable.');
      }
      ids.add(step.id);
    }
  }

  private assertRunId(runId: string): void {
    if (!/^wf-[0-9a-f-]{36}$/u.test(runId)) throw new Error('Workflow run id is invalid.');
  }

  private assertRevision(run: WorkflowRun, expectedRevision: number): void {
    if (run.revision !== expectedRevision) {
      throw new WorkflowConflictError(`Workflow revision conflict: expected ${expectedRevision}, found ${run.revision}.`);
    }
  }

  private assertRun(run: WorkflowRun): void {
    if (!run.id || !Number.isSafeInteger(run.revision) || !Array.isArray(run.steps)) {
      throw new Error('Workflow run record is invalid.');
    }
  }
}
