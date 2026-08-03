/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { FederationGatewayError } from './federationClient.js';
import type {
  ClaimedFederationEnvelope,
  SignedFederationEnvelope,
} from './federationContracts.js';

export interface FederationRuntimeServices {
  listDueOutbox(limit?: number): Array<{
    signed: SignedFederationEnvelope;
    attempts: number;
  }>;
  sendSignedEnvelope(signed: SignedFederationEnvelope): Promise<unknown>;
  markOutboxSent(messageId: string): void;
  markOutboxFailed(input: {
    messageId: string;
    error: string;
    retryable: boolean;
    attempts: number;
  }): void;
  listAcknowledgements(limit?: number): Array<{
    messageId: string;
    claimToken: string;
  }>;
  acknowledge(messageId: string, claimToken: string): Promise<void>;
  markAcknowledged(messageId: string): void;
  clearClaim(messageId: string): void;
  claim(limit?: number): Promise<ClaimedFederationEnvelope[]>;
  storeClaimed(claimed: ClaimedFederationEnvelope): {
    duplicate: boolean;
    discarded: boolean;
  };
  setRuntimeState(key: string, value: unknown): void;
}

export interface FederationCycleResult {
  sent: number;
  sendFailed: number;
  received: number;
  duplicates: number;
  discarded: number;
  acknowledged: number;
  acknowledgementFailed: number;
}

function errorDetail(error: unknown): {
  message: string;
  retryable: boolean;
  status: number | null;
} {
  if (error instanceof FederationGatewayError) {
    return {
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    status: null,
  };
}

export async function runFederationCycle(
  services: FederationRuntimeServices,
): Promise<FederationCycleResult> {
  const result: FederationCycleResult = {
    sent: 0,
    sendFailed: 0,
    received: 0,
    duplicates: 0,
    discarded: 0,
    acknowledged: 0,
    acknowledgementFailed: 0,
  };
  for (const item of services.listDueOutbox(50)) {
    try {
      await services.sendSignedEnvelope(item.signed);
      services.markOutboxSent(item.signed.envelope.messageId);
      result.sent += 1;
    } catch (error) {
      const detail = errorDetail(error);
      services.markOutboxFailed({
        messageId: item.signed.envelope.messageId,
        error: detail.message,
        retryable: detail.retryable,
        attempts: item.attempts,
      });
      result.sendFailed += 1;
    }
  }

  const acknowledge = async (messageId: string, claimToken: string) => {
    try {
      await services.acknowledge(messageId, claimToken);
      services.markAcknowledged(messageId);
      result.acknowledged += 1;
    } catch (error) {
      const detail = errorDetail(error);
      if (detail.status === 409) services.clearClaim(messageId);
      result.acknowledgementFailed += 1;
    }
  };

  for (const pending of services.listAcknowledgements(50)) {
    await acknowledge(pending.messageId, pending.claimToken);
  }

  let claimed: ClaimedFederationEnvelope[] = [];
  try {
    claimed = await services.claim(50);
  } catch (error) {
    const detail = errorDetail(error);
    services.setRuntimeState('last_error', {
      operation: 'claim',
      message: detail.message,
      status: detail.status,
      occurredAt: new Date().toISOString(),
    });
  }
  for (const item of claimed) {
    const stored = services.storeClaimed(item);
    result.received += stored.duplicate ? 0 : 1;
    result.duplicates += stored.duplicate ? 1 : 0;
    result.discarded += stored.discarded ? 1 : 0;
    await acknowledge(item.signed.envelope.messageId, item.claimToken);
  }

  services.setRuntimeState('last_cycle', {
    ...result,
    completedAt: new Date().toISOString(),
  });
  return result;
}

export function startFederationRuntime(
  services: FederationRuntimeServices,
  options: {
    intervalMs?: number;
    initialDelayMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const configuredInterval = Number(options.intervalMs);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(2_000, configuredInterval)
    : 10_000;
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runFederationCycle(services);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), options.initialDelayMs ?? 1_000);
  initial.unref();
  const interval = setInterval(() => void tick(), intervalMs);
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
