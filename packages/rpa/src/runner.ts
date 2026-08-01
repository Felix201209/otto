/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type {
  RpaRun,
  RpaStepDefinition,
  RpaStepReceipt,
  RpaWorkflowV1,
} from './contracts.js';
import type { RpaArtifactStore, RpaDriver, RpaPolicyPort, RpaRunStore } from './ports.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function receiptFor(run: RpaRun, stepId: string): RpaStepReceipt | undefined {
  return run.receipts.find((receipt) => receipt.stepId === stepId);
}

/** Durable, policy-gated RPA runner. It intentionally has no shell or raw coordinate action. */
export class RpaRunner {
  private readonly workflows = new Map<string, RpaWorkflowV1>();

  constructor(
    workflows: readonly RpaWorkflowV1[],
    private readonly store: RpaRunStore,
    private readonly policy: RpaPolicyPort,
    private readonly driver: RpaDriver,
    private readonly artifacts: RpaArtifactStore,
  ) {
    for (const workflow of workflows) this.workflows.set(`${workflow.id}@${workflow.version}`, workflow);
  }

  async start(workflowId: string, version = 1): Promise<RpaRun> {
    const workflow = this.workflow(workflowId, version);
    return this.store.create(workflow);
  }

  async runNext(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run || ['awaiting_approval', 'paused', 'unknown_outcome', 'failed', 'cancelled', 'succeeded'].includes(run.state)) {
      return run;
    }
    const workflow = this.workflowForRun(run);
    const step = workflow.steps.find((candidate) => receiptFor(run, candidate.id)?.state === 'pending');
    if (!step) return this.finish(run);

    const authorization = await this.policy.authorize({ run: clone(run), step });
    if (authorization.decision === 'deny') return this.fail(run, step, authorization.reason);
    if (authorization.decision === 'awaiting_approval') {
      run.state = 'awaiting_approval';
      run.currentStepId = step.id;
      run.approvalId = authorization.approvalId;
      return this.store.save(run, run.revision);
    }

    const receipt = receiptFor(run, step.id)!;
    receipt.state = 'started';
    receipt.attempt += 1;
    receipt.idempotencyKey = `${run.id}:${step.id}:${receipt.attempt}`;
    run.currentStepId = step.id;
    run.state = 'running';
    const claimed = await this.store.save(run, run.revision);

    try {
      const outcome = await this.driver.execute({
        run: clone(claimed),
        step,
        idempotencyKey: receiptFor(claimed, step.id)!.idempotencyKey,
      });
      const saved = await this.store.get(runId);
      if (!saved) return null;
      const completed = receiptFor(saved, step.id)!;
      completed.artifactIds = [];
      for (const artifact of outcome.artifacts ?? []) {
        completed.artifactIds.push((await this.artifacts.put(artifact)).id);
      }
      completed.output = outcome.output === undefined ? undefined : clone(outcome.output);
      completed.state = 'succeeded';
      saved.currentStepId = null;
      saved.state = 'pending';
      return this.store.save(saved, saved.revision);
    } catch (error) {
      const saved = await this.store.get(runId);
      if (!saved) return null;
      return this.fail(saved, step, error instanceof Error ? error.message : String(error));
    }
  }

  async recover(runId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    const workflow = this.workflowForRun(run);
    const active = run.currentStepId ? receiptFor(run, run.currentStepId) : undefined;
    if (!active || active.state !== 'started') return run;
    const step = workflow.steps.find((candidate) => candidate.id === active.stepId);
    if (!step) throw new Error(`Unknown RPA step: ${active.stepId}`);
    if (step.sideEffect === 'external') {
      active.state = 'unknown_outcome';
      active.error = 'Execution was interrupted after an external action began; human takeover or reconciliation is required.';
      run.state = 'unknown_outcome';
      return this.store.save(run, run.revision);
    }
    active.state = 'pending';
    active.error = undefined;
    run.currentStepId = null;
    run.state = 'pending';
    return this.store.save(run, run.revision);
  }

  /** Records an explicit human approval; policy is still checked again before execution. */
  async approve(runId: string, approvalId: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state !== 'awaiting_approval' || run.approvalId !== approvalId || !run.currentStepId) {
      throw new Error('RPA run is not waiting for this approval.');
    }
    const receipt = receiptFor(run, run.currentStepId);
    if (!receipt) throw new Error(`RPA receipt is missing for ${run.currentStepId}.`);
    receipt.approvalId = approvalId;
    receipt.approvedAt = new Date().toISOString();
    run.approvalId = undefined;
    run.currentStepId = null;
    run.state = 'pending';
    return this.store.save(run, run.revision);
  }

  /** Human takeover is explicit and auditable; it never silently retries an unknown external action. */
  async takeOver(runId: string, note: string): Promise<RpaRun | null> {
    const run = await this.store.get(runId);
    if (!run) return null;
    if (run.state !== 'unknown_outcome') {
      throw new Error('Only a run with unknown external outcome can be taken over.');
    }
    run.state = 'paused';
    run.takeoverNote = note.trim().slice(0, 500) || 'Human takeover requested.';
    return this.store.save(run, run.revision);
  }

  private async finish(run: RpaRun): Promise<RpaRun> {
    run.state = 'succeeded';
    run.currentStepId = null;
    return this.store.save(run, run.revision);
  }

  private async fail(run: RpaRun, step: RpaStepDefinition, error: string): Promise<RpaRun> {
    const receipt = receiptFor(run, step.id)!;
    receipt.state = 'failed';
    receipt.error = error;
    run.state = 'failed';
    run.currentStepId = step.id;
    return this.store.save(run, run.revision);
  }

  private workflow(id: string, version: number): RpaWorkflowV1 {
    const workflow = this.workflows.get(`${id}@${version}`);
    if (!workflow) throw new Error(`RPA workflow is not installed: ${id}@${version}`);
    return workflow;
  }

  private workflowForRun(run: RpaRun): RpaWorkflowV1 {
    if (run.workflow.id !== run.workflowId || run.workflow.version !== run.workflowVersion) {
      throw new Error(`Persisted RPA workflow binding is invalid for ${run.id}.`);
    }
    return run.workflow;
  }
}
