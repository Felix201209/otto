/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Runs bounded MLS retention cleanup on one clustered replica at a time.
 */

import { randomUUID } from 'node:crypto';

import type { EnterpriseSharedCache } from '../modules/data_platform/index.js';
import type { PostgresEnterpriseCoreRepository } from './postgresCoreRepository.js';

const MLS_MAINTENANCE_LEASE = 'jobs:mls-resource-maintenance:v1';

export function createClusteredMlsMaintenance(input: {
  cache: EnterpriseSharedCache;
  authority: Pick<PostgresEnterpriseCoreRepository, 'cleanupExpiredMlsResources'>;
  intervalMs?: number;
  owner?: string;
  onError?: (error: unknown) => void;
}) {
  const intervalMs = input.intervalMs ?? 15 * 60 * 1_000;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 24 * 60 * 60 * 1_000
  ) {
    throw new Error('MLS maintenance interval is invalid');
  }
  const owner = input.owner?.trim() || randomUUID();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let closed = false;

  async function runOnce(): Promise<boolean> {
    if (closed || running) return false;
    running = true;
    let leased = false;
    try {
      leased = await input.cache.acquireLease(
        MLS_MAINTENANCE_LEASE,
        owner,
        Math.min(24 * 60 * 60 * 1_000, intervalMs * 2),
      );
      if (!leased) return false;
      await input.authority.cleanupExpiredMlsResources({
        before: new Date().toISOString(),
        limit: 500,
      });
      return true;
    } finally {
      if (leased) {
        await input.cache.releaseLease(MLS_MAINTENANCE_LEASE, owner);
      }
      running = false;
    }
  }

  function start(): void {
    if (closed || timer) return;
    timer = setInterval(() => {
      void runOnce().catch((error: unknown) => input.onError?.(error));
    }, intervalMs);
    timer.unref();
  }

  function close(): void {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, close };
}
