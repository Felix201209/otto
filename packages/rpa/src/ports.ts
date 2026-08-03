/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RpaArtifact, RpaRun, RpaStepDefinition } from './contracts.js';

export interface RpaRunStore {
  create(workflow: { id: string; version: 1; steps: readonly RpaStepDefinition[] }): Promise<RpaRun>;
  get(runId: string): Promise<RpaRun | null>;
  save(run: RpaRun, expectedRevision: number): Promise<RpaRun>;
}

export type RpaAuthorization =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'awaiting_approval'; approvalId: string };

export interface RpaPolicyPort {
  authorize(input: { run: RpaRun; step: RpaStepDefinition }): Promise<RpaAuthorization>;
}

export interface RpaDriver {
  execute(input: { run: RpaRun; step: RpaStepDefinition; idempotencyKey: string }): Promise<{
    output?: unknown;
    artifacts?: ReadonlyArray<{ mediaType: string; bytes: Uint8Array; redactedSummary: string }>;
  }>;
}

export interface RpaArtifactStore {
  put(input: { mediaType: string; bytes: Uint8Array; redactedSummary: string }): Promise<RpaArtifact>;
}
