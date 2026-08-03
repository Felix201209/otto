/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type {
  BillingUsageRepositoryStore,
  DeploymentBillingModule,
} from './billingUsageRepository.js';

const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u;
const UNKNOWN_OPERATION_RELEASE_MS = 15 * 60 * 1000;

export type BillingAdmissionErrorCode =
  | 'billing_idempotency_key_required'
  | 'insufficient_credits'
  | 'billing_policy_unavailable'
  | 'commercial_control_unavailable';

export class BillingAdmissionError extends Error {
  constructor(
    readonly code: BillingAdmissionErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'BillingAdmissionError';
  }
}

export interface BillingAdmission {
  required: boolean;
  outboxId: string | null;
  holdId: string | null;
  organizationId: string;
  module: DeploymentBillingModule;
  units: number;
  idempotencyKey: string;
  referenceId: string;
}

export interface BillingAdmissionFlushResult {
  attempted: number;
  captured: number;
  released: number;
  discarded: number;
  failed: number;
  skippedReason: string | null;
}

interface BillingAdmissionQueueRow {
  id: string;
  deployment_id: string;
  organization_id: string;
  hold_id: string;
  module: DeploymentBillingModule;
  units: number;
  reference_id: string;
  idempotency_key: string;
  desired_outcome: 'capture' | 'release';
  attempts: number;
}

export function getBillingAdmissionQueueSummary(
  store: BillingUsageRepositoryStore,
): {
  authorized: number;
  pending: number;
  failed: number;
  finalized: number;
  discarded: number;
  lastError: string | null;
} {
  const rows = store.db().prepare(
    `SELECT status, COUNT(*) AS count FROM billing_admission_outbox
     GROUP BY status`,
  ).all() as Array<{
    status: 'authorized' | 'pending' | 'failed' | 'finalized' | 'discarded';
    count: number;
  }>;
  const latestFailure = store.db().prepare(
    `SELECT last_error FROM billing_admission_outbox
     WHERE status IN ('failed', 'discarded') AND last_error IS NOT NULL
     ORDER BY created_at_ms DESC LIMIT 1`,
  ).get() as { last_error: string } | undefined;
  const summary = {
    authorized: 0,
    pending: 0,
    failed: 0,
    finalized: 0,
    discarded: 0,
    lastError: latestFailure?.last_error ?? null,
  };
  for (const row of rows) summary[row.status] = row.count;
  return summary;
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  return typeof body.error === 'string' ? body.error : '';
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 10));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function binding(store: BillingUsageRepositoryStore, organizationId?: string) {
  const credentials = store.credentials();
  if (!credentials) return null;
  const resolvedOrganizationId = organizationId ?? credentials.organizationId;
  if (!IDEMPOTENCY_KEY.test(resolvedOrganizationId)) return null;
  return {
    credentials,
    body: {
      licenseId: credentials.licenseId,
      deploymentId: credentials.deploymentId,
      organizationId: resolvedOrganizationId,
      machineFingerprint: credentials.machineFingerprint,
    },
  };
}

function persistAuthorizedAdmission(
  store: BillingUsageRepositoryStore,
  admission: Omit<BillingAdmission, 'required' | 'outboxId'> & { holdId: string },
  now: number,
): string {
  const bound = binding(store, admission.organizationId);
  if (!bound) throw new Error('billing admission credentials disappeared');
  const id = `badm_${createHash('sha256')
    .update(`${bound.credentials.deploymentId}\0${admission.idempotencyKey}`, 'utf8')
    .digest('hex')}`;
  store.db().prepare(
    `INSERT OR IGNORE INTO billing_admission_outbox
      (id, deployment_id, organization_id, hold_id, module, units, reference_id,
       idempotency_key, status, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`,
  ).run(
    id,
    bound.credentials.deploymentId,
    admission.organizationId,
    admission.holdId,
    admission.module,
    admission.units,
    admission.referenceId,
    admission.idempotencyKey,
    now,
  );
  const existing = store.db().prepare(
    `SELECT id, deployment_id, organization_id, hold_id, module, units,
            reference_id, idempotency_key
     FROM billing_admission_outbox WHERE idempotency_key = ?`,
  ).get(admission.idempotencyKey) as Omit<
    BillingAdmissionQueueRow,
    'desired_outcome' | 'attempts'
  > | undefined;
  if (
    !existing ||
    existing.deployment_id !== bound.credentials.deploymentId ||
    existing.organization_id !== admission.organizationId ||
    existing.hold_id !== admission.holdId ||
    existing.module !== admission.module ||
    existing.units !== admission.units ||
    existing.reference_id !== admission.referenceId
  ) {
    throw new BillingAdmissionError(
      'billing_policy_unavailable',
      409,
      'idempotency key is already bound to a different operation',
    );
  }
  return existing.id;
}

export async function authorizeBillingOperation(
  store: BillingUsageRepositoryStore,
  input: {
    organizationId?: string;
    module: DeploymentBillingModule;
    units: number;
    idempotencyKey: string;
    referenceId: string;
  },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<BillingAdmission> {
  const credentials = store.credentials();
  const organizationId = input.organizationId ?? credentials?.organizationId ?? '';
  const operation = { ...input, organizationId };
  const bound = binding(store, organizationId);
  if (!credentials || credentials.enforcement === 'disabled') {
    return { required: false, outboxId: null, holdId: null, ...operation };
  }
  if (!bound) {
    throw new BillingAdmissionError(
      'billing_policy_unavailable',
      503,
      'billing organization binding is invalid',
    );
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new BillingAdmissionError(
      'billing_idempotency_key_required',
      400,
      'a valid x-otto-idempotency-key header is required',
    );
  }
  try {
    const response = await fetchImpl(bound.credentials.holdEndpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bound.credentials.leaseToken}`,
        'content-type': 'application/json',
        'user-agent': 'Otto-Private-Deployment/1',
      },
      body: JSON.stringify({
        ...bound.body,
        module: input.module,
        units: input.units,
        idempotencyKey: `hold:${input.idempotencyKey}`,
        expiresInSeconds: 900,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = await responseError(response);
      if (response.status === 409 && error.includes('insufficient available credits')) {
        throw new BillingAdmissionError(
          'insufficient_credits',
          402,
          'insufficient credits for this operation',
        );
      }
      if (response.status === 409) {
        throw new BillingAdmissionError(
          'billing_policy_unavailable',
          503,
          'billing rate or policy is not ready',
        );
      }
      throw new BillingAdmissionError(
        'commercial_control_unavailable',
        response.status === 401 ? 402 : 503,
        'commercial control rejected the billing admission',
      );
    }
    const result = await response.json() as { hold?: { id?: unknown } };
    const holdId = typeof result.hold?.id === 'string' ? result.hold.id : '';
    if (!/^hold_[a-zA-Z0-9]+$/u.test(holdId)) {
      throw new BillingAdmissionError(
        'commercial_control_unavailable',
        503,
        'commercial control returned an invalid billing hold',
      );
    }
    const outboxId = persistAuthorizedAdmission(
      store,
      { holdId, ...operation },
      now,
    );
    return { required: true, outboxId, holdId, ...operation };
  } catch (error) {
    if (error instanceof BillingAdmissionError) throw error;
    throw new BillingAdmissionError(
      'commercial_control_unavailable',
      503,
      'commercial control is temporarily unavailable',
    );
  }
}

async function deliverBillingAdmission(
  store: BillingUsageRepositoryStore,
  row: BillingAdmissionQueueRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<'captured' | 'released' | 'discarded' | 'failed'> {
  const bound = binding(store, row.organization_id);
  if (!bound || bound.credentials.enforcement !== 'enforce') return 'failed';
  if (
    row.deployment_id !== bound.credentials.deploymentId ||
    row.organization_id !== bound.body.organizationId
  ) {
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'discarded', last_error = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run('billing admission binding is invalid', row.id);
    return 'discarded';
  }
  try {
    const endpoint = new URL(
      `${encodeURIComponent(row.hold_id)}/${row.desired_outcome}`,
      bound.credentials.holdEndpoint.endsWith('/')
        ? bound.credentials.holdEndpoint
        : `${bound.credentials.holdEndpoint}/`,
    );
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bound.credentials.leaseToken}`,
        'content-type': 'application/json',
        'user-agent': 'Otto-Private-Deployment/1',
      },
      body: JSON.stringify({
        ...bound.body,
        ...(row.desired_outcome === 'capture'
          ? { units: row.units, referenceId: row.reference_id }
          : {}),
        idempotencyKey: `${row.desired_outcome}:${row.idempotency_key}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      if ([400, 404, 409].includes(response.status)) {
        store.db().prepare(
          `UPDATE billing_admission_outbox
           SET status = 'discarded', attempts = attempts + 1, last_error = ?,
               updated_at = datetime('now') WHERE id = ?`,
        ).run(`billing ${row.desired_outcome} was rejected (${response.status})`, row.id);
        return 'discarded';
      }
      throw new Error(`billing ${row.desired_outcome} returned ${response.status}`);
    }
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'finalized', attempts = attempts + 1, finalized_at_ms = ?,
           next_attempt_at_ms = NULL, last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(now, row.id);
    return row.desired_outcome === 'capture' ? 'captured' : 'released';
  } catch (error) {
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'failed', attempts = attempts + 1, next_attempt_at_ms = ?,
           last_error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      now + retryDelayMs(row.attempts + 1),
      safeErrorMessage(error),
      row.id,
    );
    return 'failed';
  }
}

export async function flushBillingAdmissionQueue(
  store: BillingUsageRepositoryStore,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
  onlyId?: string,
): Promise<BillingAdmissionFlushResult> {
  const result: BillingAdmissionFlushResult = {
    attempted: 0,
    captured: 0,
    released: 0,
    discarded: 0,
    failed: 0,
    skippedReason: null,
  };
  store.db().prepare(
    `DELETE FROM billing_admission_outbox
     WHERE status IN ('finalized', 'discarded') AND created_at_ms < ?`,
  ).run(now - 90 * 24 * 60 * 60 * 1000);
  store.db().prepare(
    `UPDATE billing_admission_outbox
     SET desired_outcome = 'release', status = 'pending',
         last_error = 'recovered an interrupted operation; releasing hold',
         updated_at = datetime('now')
     WHERE status = 'authorized' AND created_at_ms <= ?`,
  ).run(now - UNKNOWN_OPERATION_RELEASE_MS);
  const bound = binding(store);
  if (!bound || bound.credentials.enforcement !== 'enforce') {
    return { ...result, skippedReason: 'billing_enforcement_disabled' };
  }
  const rows = store.db().prepare(
    `SELECT id, deployment_id, organization_id, hold_id, module, units,
            reference_id, idempotency_key, desired_outcome, attempts
     FROM billing_admission_outbox
     WHERE status IN ('pending', 'failed')
       AND desired_outcome IS NOT NULL
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
       AND (? IS NULL OR id = ?)
     ORDER BY created_at_ms ASC LIMIT 50`,
  ).all(now, onlyId ?? null, onlyId ?? null) as BillingAdmissionQueueRow[];
  result.attempted = rows.length;
  for (const row of rows) {
    const delivered = await deliverBillingAdmission(store, row, fetchImpl, now);
    result[delivered] += 1;
  }
  return result;
}

export async function finalizeBillingOperation(
  store: BillingUsageRepositoryStore,
  admission: BillingAdmission,
  outcome: 'capture' | 'release',
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  if (!admission.required || !admission.holdId || !admission.outboxId) return;
  const existing = store.db().prepare(
    `SELECT desired_outcome, status FROM billing_admission_outbox WHERE id = ?`,
  ).get(admission.outboxId) as {
    desired_outcome: 'capture' | 'release' | null;
    status: string;
  } | undefined;
  if (!existing) throw new Error('billing admission outbox record is missing');
  if (existing.desired_outcome && existing.desired_outcome !== outcome) {
    throw new Error('billing admission already has a conflicting outcome');
  }
  if (existing.status === 'finalized') return;
  store.db().prepare(
    `UPDATE billing_admission_outbox
     SET desired_outcome = ?, status = 'pending', next_attempt_at_ms = NULL,
         last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(outcome, admission.outboxId);
  const result = await flushBillingAdmissionQueue(
    store,
    fetchImpl,
    now,
    admission.outboxId,
  );
  if (result.failed > 0) {
    throw new Error(`billing ${outcome} is queued for retry`);
  }
}
