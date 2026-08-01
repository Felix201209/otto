/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { WorkflowDefinition, WorkflowRun, WorkflowStepRun } from './contracts.js';
import type { WorkflowStore } from './store.js';

export interface WorkflowStepExecutor {
  execute(input: { run: WorkflowRun; step: WorkflowStepRun }): Promise<unknown>;
}

/**
 * Durable step driver. State is claimed and persisted before the executor is
 * invoked. If the process disappears after an external step began, recovery
 * marks it unknown rather than calling the executor a second time.
 */
export class WorkflowRuntime {
  constructor(
    private readonly store: WorkflowStore,
    private readonly executor: WorkflowStepExecutor,
  ) {}

  async start(definition: WorkflowDefinition): Promise<WorkflowRun> {
    return this.store.createRun(definition);
  }

  async runNext(runId: string): Promise<WorkflowRun | null> {
    const current = await this.store.getRun(runId);
    if (!current) return null;
    const claimed = await this.store.claimNextStep(runId, current.revision);
    if (!claimed) return this.store.getRun(runId);
    if (claimed.step.status === 'waiting_approval') return claimed.run;

    try {
      const output = await this.executor.execute(claimed);
      return this.store.completeStep({
        runId,
        stepId: claimed.step.stepId,
        expectedRevision: claimed.run.revision,
        output,
      });
    } catch (error) {
      return this.store.completeStep({
        runId,
        stepId: claimed.step.stepId,
        expectedRevision: claimed.run.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recover(runId: string): Promise<WorkflowRun | null> {
    const current = await this.store.getRun(runId);
    if (!current) return null;
    return this.store.recoverInterruptedRun(runId, current.revision);
  }
}
