/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type { Database } from '../data_platform/index.js';

export const DEPLOYMENT_BILLING_MODULES = [
  'model_gateway',
  'meeting_agent',
  'park_service',
  'atoa',
  'feishu',
  'enterprise_knowledge',
  'skill_market',
  'data_visualization',
  'document_generation',
] as const;

export type DeploymentBillingModule =
  (typeof DEPLOYMENT_BILLING_MODULES)[number];

export interface DeploymentBillingCredentials {
  licenseId: string;
  deploymentId: string;
  organizationId: string;
  machineFingerprint: string;
  endpoint: string;
  holdEndpoint: string;
  enforcement: 'disabled' | 'enforce';
  leaseToken: string;
}

export interface BillingUsageRepositoryStore {
  db(): Database;
  credentials(): DeploymentBillingCredentials | null;
}

export interface BillingUsageFlushResult {
  attempted: number;
  sent: number;
  discarded: number;
  failed: number;
  skippedReason: string | null;
}

interface BillingUsageQueueRow {
  id: string;
  deployment_id: string;
  organization_id: string;
  module: DeploymentBillingModule;
  units: number;
  reference_id: string;
  idempotency_key: string;
  attempts: number;
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 10));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function queueBillingUsage(
  store: BillingUsageRepositoryStore,
  input: {
    organizationId: string;
    module: DeploymentBillingModule;
    units: number;
    referenceId: string;
    idempotencyKey: string;
  },
  now = Date.now(),
): boolean {
  const credentials = store.credentials();
  if (!credentials || credentials.organizationId !== input.organizationId) {
    return false;
  }
  if (!DEPLOYMENT_BILLING_MODULES.includes(input.module)) {
    throw new Error('unsupported billing module');
  }
  if (!Number.isSafeInteger(input.units) || input.units < 1) {
    throw new Error('billing units must be a positive safe integer');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u.test(input.idempotencyKey)) {
    throw new Error('billing idempotency key is invalid');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u.test(input.referenceId)) {
    throw new Error('billing reference is invalid');
  }
  const id = `bil_${createHash('sha256')
    .update(`${credentials.deploymentId}\0${input.idempotencyKey}`, 'utf8')
    .digest('hex')}`;
  const result = store.db().prepare(
    `INSERT OR IGNORE INTO billing_usage_outbox
      (id, deployment_id, organization_id, module, units, reference_id,
       idempotency_key, status, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    id,
    credentials.deploymentId,
    input.organizationId,
    input.module,
    input.units,
    input.referenceId,
    input.idempotencyKey,
    now,
  );
  return Number(result.changes ?? 0) > 0;
}

export function getBillingUsageQueueSummary(
  store: BillingUsageRepositoryStore,
): {
  queued: number;
  failed: number;
  sent: number;
  discarded: number;
  lastQueuedAt: string | null;
  lastError: string | null;
} {
  const rows = store.db().prepare(
    `SELECT status, COUNT(*) AS count, MAX(created_at_ms) AS last_created_at_ms
     FROM billing_usage_outbox GROUP BY status`,
  ).all() as Array<{
    status: 'queued' | 'sent' | 'failed' | 'discarded';
    count: number;
    last_created_at_ms: number | null;
  }>;
  const latestFailure = store.db().prepare(
    `SELECT last_error FROM billing_usage_outbox
     WHERE status = 'failed' AND last_error IS NOT NULL
     ORDER BY created_at_ms DESC LIMIT 1`,
  ).get() as { last_error: string } | undefined;
  const summary = {
    queued: 0,
    failed: 0,
    sent: 0,
    discarded: 0,
    lastQueuedAt: null as string | null,
    lastError: latestFailure?.last_error ?? null,
  };
  for (const row of rows) {
    summary[row.status] = row.count;
    if (row.status === 'queued' && row.last_created_at_ms) {
      summary.lastQueuedAt = dateFromMs(row.last_created_at_ms);
    }
  }
  return summary;
}

export async function flushBillingUsageQueue(
  store: BillingUsageRepositoryStore,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<BillingUsageFlushResult> {
  const result: BillingUsageFlushResult = {
    attempted: 0,
    sent: 0,
    discarded: 0,
    failed: 0,
    skippedReason: null,
  };
  store.db().prepare(
    `DELETE FROM billing_usage_outbox
     WHERE status IN ('sent', 'discarded') AND created_at_ms < ?`,
  ).run(now - 90 * 24 * 60 * 60 * 1000);
  const credentials = store.credentials();
  if (!credentials) return { ...result, skippedReason: 'billing_credentials_missing' };
  const rows = store.db().prepare(
    `SELECT id, deployment_id, organization_id, module, units, reference_id,
            idempotency_key, attempts
     FROM billing_usage_outbox
     WHERE status IN ('queued', 'failed')
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
     ORDER BY created_at_ms ASC LIMIT 50`,
  ).all(now) as BillingUsageQueueRow[];
  result.attempted = rows.length;
  for (const row of rows) {
    if (
      row.deployment_id !== credentials.deploymentId ||
      row.organization_id !== credentials.organizationId ||
      !DEPLOYMENT_BILLING_MODULES.includes(row.module) ||
      !Number.isSafeInteger(row.units) || row.units < 1
    ) {
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'discarded', last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run('billing outbox binding is invalid', row.id);
      result.discarded += 1;
      continue;
    }
    try {
      const response = await fetchImpl(credentials.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.leaseToken}`,
          'content-type': 'application/json',
          'user-agent': 'Otto-Private-Deployment/1',
        },
        body: JSON.stringify({
          version: 1,
          licenseId: credentials.licenseId,
          deploymentId: credentials.deploymentId,
          organizationId: credentials.organizationId,
          machineFingerprint: credentials.machineFingerprint,
          module: row.module,
          units: row.units,
          referenceId: row.reference_id,
          idempotencyKey: row.idempotency_key,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        if (response.status === 400) {
          store.db().prepare(
            `UPDATE billing_usage_outbox
             SET status = 'discarded', attempts = attempts + 1, last_error = ?,
                 updated_at = datetime('now') WHERE id = ?`,
          ).run(`billing endpoint rejected event (${response.status})`, row.id);
          result.discarded += 1;
          continue;
        }
        throw new Error(`billing endpoint returned ${response.status}`);
      }
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'sent', sent_at_ms = ?, next_attempt_at_ms = NULL,
             last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(now, row.id);
      result.sent += 1;
    } catch (error) {
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'failed', attempts = attempts + 1,
             next_attempt_at_ms = ?, last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        now + retryDelayMs(row.attempts + 1),
        safeErrorMessage(error),
        row.id,
      );
      result.failed += 1;
    }
  }
  return result;
}
