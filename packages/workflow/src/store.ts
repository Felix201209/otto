/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { ClaimedWorkflowStep, WorkflowDefinition, WorkflowRun, WorkflowStepRun } from './contracts.js';

export interface WorkflowStore {
  createRun(definition: WorkflowDefinition): Promise<WorkflowRun>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  claimNextStep(runId: string, expectedRevision: number): Promise<ClaimedWorkflowStep | null>;
  completeStep(input: {
    runId: string;
    stepId: string;
    expectedRevision: number;
    output?: unknown;
    error?: string;
  }): Promise<WorkflowRun>;
  approveStep(input: { runId: string; stepId: string; approvalId: string; expectedRevision: number }): Promise<WorkflowRun>;
  recoverInterruptedRun(runId: string, expectedRevision: number): Promise<WorkflowRun>;
  takeOverUnknownRun(input: { runId: string; note: string; expectedRevision: number }): Promise<WorkflowRun>;
}

export function cloneRun(run: WorkflowRun): WorkflowRun {
  return structuredClone(run);
}

export function nextQueuedStep(run: WorkflowRun): WorkflowStepRun | undefined {
  return run.steps.find((step) => step.status === 'queued');
}
