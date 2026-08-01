/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { WorkflowDefinition, WorkflowRun, WorkflowStepRun } from './contracts.js';
import type { WorkflowStore } from './store.js';
import type { WorkflowTraceSink } from './trace.js';

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
    private readonly trace?: WorkflowTraceSink,
  ) {}

  async start(definition: WorkflowDefinition): Promise<WorkflowRun> {
    const run = await this.store.createRun(definition);
    await this.trace?.append({ runId: run.id, kind: 'run_started', status: run.status, summary: `Started ${run.definitionId}@${run.definitionVersion}` });
    return run;
  }

  async runNext(runId: string): Promise<WorkflowRun | null> {
    const current = await this.store.getRun(runId);
    if (!current) return null;
    const claimed = await this.store.claimNextStep(runId, current.revision);
    if (!claimed) return this.store.getRun(runId);
    if (claimed.step.status === 'waiting_approval') return claimed.run;
    await this.trace?.append({
      runId,
      stepId: claimed.step.stepId,
      attempt: claimed.step.attempt,
      idempotencyKey: claimed.step.idempotencyKey,
      kind: 'step_claimed',
      status: claimed.step.status,
      summary: `Claimed ${claimed.step.kind} step`,
    });

    try {
      const output = await this.executor.execute(claimed);
      const completed = await this.store.completeStep({
        runId,
        stepId: claimed.step.stepId,
        expectedRevision: claimed.run.revision,
        output,
      });
      await this.trace?.append({ runId, stepId: claimed.step.stepId, attempt: claimed.step.attempt, idempotencyKey: claimed.step.idempotencyKey, kind: 'step_succeeded', status: 'succeeded', summary: 'Step completed' });
      return completed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.store.completeStep({
        runId,
        stepId: claimed.step.stepId,
        expectedRevision: claimed.run.revision,
        error: message,
      });
      await this.trace?.append({ runId, stepId: claimed.step.stepId, attempt: claimed.step.attempt, idempotencyKey: claimed.step.idempotencyKey, kind: 'step_failed', status: 'failed', summary: message.slice(0, 300) });
      return failed;
    }
  }

  async recover(runId: string): Promise<WorkflowRun | null> {
    const current = await this.store.getRun(runId);
    if (!current) return null;
    const recovered = await this.store.recoverInterruptedRun(runId, current.revision);
    if (recovered.status === 'unknown_outcome') {
      const active = recovered.steps.find((step) => step.status === 'unknown_outcome');
      await this.trace?.append({ runId, stepId: active?.stepId, attempt: active?.attempt, idempotencyKey: active?.idempotencyKey, kind: 'recovery_unknown_outcome', status: recovered.status, summary: 'External side effect requires reconciliation or human takeover' });
    }
    return recovered;
  }
}
