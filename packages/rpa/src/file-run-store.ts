/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RpaConflictError, type RpaRun, type RpaStepDefinition } from './contracts.js';
import type { RpaRunStore } from './ports.js';

function createReceipt(runId: string, step: RpaStepDefinition): RpaRun['receipts'][number] {
  return {
    stepId: step.id,
    attempt: 0,
    state: 'pending',
    idempotencyKey: `${runId}:${step.id}:0`,
    artifactIds: [],
  };
}

/** Local persistent RPA state with revision checks and atomic file replacement. */
export class FileRpaRunStore implements RpaRunStore {
  constructor(private readonly rootDir: string) {}

  async create(workflow: { id: string; version: 1; steps: readonly RpaStepDefinition[] }): Promise<RpaRun> {
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(workflow.id) || workflow.steps.length === 0) {
      throw new Error('RPA workflow is invalid.');
    }
    const id = `rpa-${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const run: RpaRun = {
      id,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      workflow: structuredClone(workflow),
      state: 'pending',
      revision: 1,
      currentStepId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      receipts: workflow.steps.map((step) => createReceipt(id, step)),
    };
    await this.write(run);
    return structuredClone(run);
  }

  async get(runId: string): Promise<RpaRun | null> {
    this.assertRunId(runId);
    try {
      return structuredClone(JSON.parse(await readFile(this.pathFor(runId), 'utf8')) as RpaRun);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(run: RpaRun, expectedRevision: number): Promise<RpaRun> {
    this.assertRunId(run.id);
    const existing = await this.get(run.id);
    if (!existing || existing.revision !== expectedRevision) {
      throw new RpaConflictError(`RPA run revision conflict: ${run.id}`);
    }
    const saved = structuredClone(run);
    saved.revision = expectedRevision + 1;
    saved.updatedAt = new Date().toISOString();
    await this.write(saved);
    return structuredClone(saved);
  }

  private async write(run: RpaRun): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const target = this.pathFor(run.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private pathFor(runId: string): string {
    this.assertRunId(runId);
    return path.join(this.rootDir, `${runId}.json`);
  }

  private assertRunId(runId: string): void {
    if (!/^rpa-[0-9a-f-]{36}$/u.test(runId)) throw new Error('RPA run id is invalid.');
  }
}
