/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  EnterpriseAtoaContextSource,
  EnterpriseAtoaResponseLedgerCommand,
  EnterpriseAtoaResponseLedgerKey,
  EnterpriseAtoaResponseLedgerRecord,
} from '../preload/index.js';

export interface EnterpriseAtoaResponseLedgerPort {
  execute(
    command: EnterpriseAtoaResponseLedgerCommand,
  ): Promise<EnterpriseAtoaResponseLedgerRecord | null>;
}

export interface GeneratedEnterpriseAtoaResponse {
  answer: string;
  grantedSources: EnterpriseAtoaContextSource[];
}

export interface DurableEnterpriseAtoaResponseResult {
  outcome: 'submitted' | 'already_submitted' | 'aborted';
  response: GeneratedEnterpriseAtoaResponse;
  reused: boolean;
}

/**
 * Generates an A2A answer at most once for one durable request key. The answer
 * is protected and persisted before the first network submission. A failed
 * submission leaves the original answer available for a later retry or app
 * restart; callers must never regenerate it for the same key.
 */
export async function submitDurableEnterpriseAtoaResponse(input: {
  key: EnterpriseAtoaResponseLedgerKey;
  ledger: EnterpriseAtoaResponseLedgerPort;
  generate(): Promise<GeneratedEnterpriseAtoaResponse>;
  submit(response: GeneratedEnterpriseAtoaResponse): Promise<unknown>;
  signal?: AbortSignal;
}): Promise<DurableEnterpriseAtoaResponseResult> {
  let record = await input.ledger.execute({
    action: 'load',
    key: input.key,
  });
  const reused = record !== null;

  if (!record) {
    const generated = await input.generate();
    // Generation has already incurred provider cost. Persist it even when the
    // window was hidden or cancellation arrived while the provider completed.
    record = await input.ledger.execute({
      action: 'stage_generated',
      key: input.key,
      answer: generated.answer,
      grantedSources: generated.grantedSources,
    });
    if (!record) {
      throw new Error(
        'A2A response ledger did not persist the generated result',
      );
    }
  }

  const response: GeneratedEnterpriseAtoaResponse = {
    answer: record.answer,
    grantedSources: record.grantedSources,
  };
  if (record.status === 'submitted') {
    return { outcome: 'already_submitted', response, reused: true };
  }
  if (input.signal?.aborted) {
    return { outcome: 'aborted', response, reused };
  }

  const submitting = await input.ledger.execute({
    action: 'mark_submitting',
    key: input.key,
  });
  if (!submitting) {
    throw new Error('A2A response ledger record disappeared before submission');
  }
  if (submitting.status === 'submitted') {
    return { outcome: 'already_submitted', response, reused: true };
  }

  try {
    await input.submit(response);
  } catch (error) {
    await input.ledger.execute({
      action: 'mark_submission_failed',
      key: input.key,
      error:
        error instanceof Error
          ? error.message
          : 'A2A response submission failed',
    });
    throw error;
  }

  const submitted = await input.ledger.execute({
    action: 'mark_submitted',
    key: input.key,
  });
  if (!submitted || submitted.status !== 'submitted') {
    throw new Error('A2A response ledger could not confirm submission');
  }
  return { outcome: 'submitted', response, reused };
}
