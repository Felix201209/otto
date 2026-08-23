/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type {
  BillingUsageRepositoryStore,
  DeploymentBillingModule,
} from './billingUsageRepository.js';

const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u;
const UNKNOWN_OPERATION_RECONCILIATION_MS = 15 * 60 * 1000;

export type BillingAdmissionErrorCode =
  | 'billing_idempotency_key_required'
  | 'billing_idempotency_conflict'
  | 'billing_operation_replayed'
  | 'billing_operation_uncertain'
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
  reconciliation: number;
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

interface BillingAdmissionRecoveryRow {
  id: string;
  deployment_id: string;
  organization_id: string;
  hold_id: string;
  module: DeploymentBillingModule;
  units: number;
  reference_id: string;
  idempotency_key: string;
  desired_outcome: null;
  attempts: number;
  created_at_ms: number;
  next_attempt_at_ms: number | null;
}

export function getBillingAdmissionQueueSummary(
  store: BillingUsageRepositoryStore,
): {
  authorized: number;
  pending: number;
  failed: number;
  finalized: number;
  reconciliation: number;
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
  const reconciliation = store.db().prepare(
    `SELECT COUNT(*) AS count FROM billing_admission_outbox
     WHERE reconciliation_required = 1`,
  ).get() as { count: number };
  const summary = {
    authorized: 0,
    pending: 0,
    failed: 0,
    finalized: 0,
    reconciliation: reconciliation.count,
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

interface BillingAdmissionClaim {
  id: string;
  provisionalHoldId: string;
}

function claimBillingAdmission(
  store: BillingUsageRepositoryStore,
  admission: Omit<BillingAdmission, 'required' | 'outboxId' | 'holdId'>,
  now: number,
): BillingAdmissionClaim {
  const bound = binding(store, admission.organizationId);
  if (!bound) throw new Error('billing admission credentials disappeared');
  const id = `badm_${createHash('sha256')
    .update(`${bound.credentials.deploymentId}\0${admission.idempotencyKey}`, 'utf8')
    .digest('hex')}`;
  const provisionalHoldId = `pending_${createHash('sha256')
    .update(id, 'utf8')
    .digest('hex')}`;
  const inserted = store.db().prepare(
    `INSERT OR IGNORE INTO billing_admission_outbox
      (id, deployment_id, organization_id, hold_id, module, units, reference_id,
       idempotency_key, status, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`,
  ).run(
    id,
    bound.credentials.deploymentId,
    admission.organizationId,
    provisionalHoldId,
    admission.module,
    admission.units,
    admission.referenceId,
    admission.idempotencyKey,
    now,
  );
  if (inserted.changes === 1) return { id, provisionalHoldId };

  const existing = store.db().prepare(
    `SELECT id, deployment_id, organization_id, module, units, reference_id
     FROM billing_admission_outbox WHERE idempotency_key = ?`,
  ).get(admission.idempotencyKey) as {
    id: string;
    deployment_id: string;
    organization_id: string;
    module: DeploymentBillingModule;
    units: number;
    reference_id: string;
  } | undefined;
  if (
    !existing ||
    existing.deployment_id !== bound.credentials.deploymentId ||
    existing.organization_id !== admission.organizationId ||
    existing.module !== admission.module ||
    existing.units !== admission.units ||
    existing.reference_id !== admission.referenceId
  ) {
    throw new BillingAdmissionError(
      'billing_idempotency_conflict',
      409,
      'idempotency key is already bound to a different operation',
    );
  }
  throw new BillingAdmissionError(
    'billing_operation_replayed',
    409,
    'this billing operation is already in progress or has been processed',
  );
}

function abandonBillingAdmissionClaim(
  store: BillingUsageRepositoryStore,
  claim: BillingAdmissionClaim,
): void {
  store.db().prepare(
    `DELETE FROM billing_admission_outbox WHERE id = ? AND hold_id = ?`,
  ).run(claim.id, claim.provisionalHoldId);
}

function markBillingAdmissionClaimUncertain(
  store: BillingUsageRepositoryStore,
  claim: BillingAdmissionClaim,
  message: string,
): void {
  store.db().prepare(
    `UPDATE billing_admission_outbox
     SET status = 'failed', reconciliation_required = 1,
         next_attempt_at_ms = NULL, last_error = ?, updated_at = datetime('now')
     WHERE id = ? AND hold_id = ?`,
  ).run(safeErrorMessage(message), claim.id, claim.provisionalHoldId);
}

function completeBillingAdmissionClaim(
  store: BillingUsageRepositoryStore,
  claim: BillingAdmissionClaim,
  holdId: string,
): void {
  const updated = store.db().prepare(
    `UPDATE billing_admission_outbox
     SET hold_id = ?, updated_at = datetime('now')
     WHERE id = ? AND hold_id = ? AND reconciliation_required = 0`,
  ).run(holdId, claim.id, claim.provisionalHoldId);
  if (updated.changes !== 1) {
    throw new BillingAdmissionError(
      'billing_operation_uncertain',
      503,
      'billing admission claim changed while Control was processing it',
    );
  }
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
  const enforcement =
    credentials?.enforcement ?? store.billingEnforcement?.() ?? 'disabled';
  const organizationId = input.organizationId ?? credentials?.organizationId ?? '';
  const operation = { ...input, organizationId };
  if (enforcement === 'disabled') {
    return { required: false, outboxId: null, holdId: null, ...operation };
  }
  if (!credentials) {
    throw new BillingAdmissionError(
      'billing_policy_unavailable',
      503,
      'billing enforcement is enabled but billing credentials are unavailable',
    );
  }
  const bound = binding(store, organizationId);
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
  const claim = claimBillingAdmission(store, operation, now);
  let response: Response;
  try {
    response = await fetchImpl(bound.credentials.holdEndpoint, {
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
  } catch (error) {
    markBillingAdmissionClaimUncertain(
      store,
      claim,
      error instanceof Error ? error.message : String(error),
    );
    throw new BillingAdmissionError(
      'billing_operation_uncertain',
      503,
      'billing admission outcome is unknown and requires reconciliation',
    );
  }
  if (!response.ok) {
    const error = await responseError(response);
    if (response.status === 409 && error.includes('insufficient available credits')) {
      abandonBillingAdmissionClaim(store, claim);
      throw new BillingAdmissionError(
        'insufficient_credits',
        402,
        'insufficient credits for this operation',
      );
    }
    if (response.status === 409) {
      abandonBillingAdmissionClaim(store, claim);
      throw new BillingAdmissionError(
        'billing_policy_unavailable',
        503,
        'billing rate or policy is not ready',
      );
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      abandonBillingAdmissionClaim(store, claim);
      throw new BillingAdmissionError(
        'commercial_control_unavailable',
        response.status === 401 ? 402 : 503,
        'commercial control rejected the billing admission',
      );
    }
    markBillingAdmissionClaimUncertain(
      store,
      claim,
      `Control returned ${response.status}: ${error}`,
    );
    throw new BillingAdmissionError(
      'billing_operation_uncertain',
      503,
      'billing admission outcome is unknown and requires reconciliation',
    );
  }
  const result = await response.json().catch(() => null) as {
    hold?: { id?: unknown };
  } | null;
  const holdId = typeof result?.hold?.id === 'string' ? result.hold.id : '';
  if (!/^hold_[a-zA-Z0-9]+$/u.test(holdId)) {
    markBillingAdmissionClaimUncertain(store, claim, 'Control returned an invalid hold');
    throw new BillingAdmissionError(
      'billing_operation_uncertain',
      503,
      'commercial control returned an invalid billing hold',
    );
  }
  try {
    completeBillingAdmissionClaim(store, claim, holdId);
  } catch (error) {
    markBillingAdmissionClaimUncertain(
      store,
      claim,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  return { required: true, outboxId: claim.id, holdId, ...operation };
}

async function deliverBillingAdmission(
  store: BillingUsageRepositoryStore,
  row: BillingAdmissionQueueRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<'captured' | 'released' | 'reconciliation' | 'discarded' | 'failed'> {
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
        const detail = await responseError(response);
        store.db().prepare(
          `UPDATE billing_admission_outbox
           SET status = 'failed', attempts = attempts + 1,
               next_attempt_at_ms = NULL, reconciliation_required = 1,
               last_error = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(
          [
            `billing ${row.desired_outcome} requires reconciliation`,
            `control returned ${response.status}`,
            detail,
          ].filter(Boolean).join(': '),
          row.id,
        );
        return 'reconciliation';
      }
      throw new Error(`billing ${row.desired_outcome} returned ${response.status}`);
    }
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'finalized', attempts = attempts + 1, finalized_at_ms = ?,
           next_attempt_at_ms = NULL, reconciliation_required = 0,
           last_error = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(now, row.id);
    return row.desired_outcome === 'capture' ? 'captured' : 'released';
  } catch (error) {
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'failed', attempts = attempts + 1, next_attempt_at_ms = ?,
           reconciliation_required = 0, last_error = ?,
           updated_at = datetime('now') WHERE id = ?`,
    ).run(
      now + retryDelayMs(row.attempts + 1),
      safeErrorMessage(error),
      row.id,
    );
    return 'failed';
  }
}

async function recoverUncertainBillingAdmissionClaim(
  store: BillingUsageRepositoryStore,
  row: BillingAdmissionRecoveryRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<'released' | 'reconciliation' | 'discarded' | 'failed'> {
  const bound = binding(store, row.organization_id);
  if (
    !bound ||
    bound.credentials.enforcement !== 'enforce' ||
    row.deployment_id !== bound.credentials.deploymentId ||
    row.organization_id !== bound.body.organizationId ||
    !row.hold_id.startsWith('pending_')
  ) {
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET next_attempt_at_ms = NULL, reconciliation_required = 1,
           last_error = 'billing admission recovery binding is invalid',
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(row.id);
    return 'reconciliation';
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
        module: row.module,
        units: row.units,
        idempotencyKey: `hold:${row.idempotency_key}`,
        expiresInSeconds: 900,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await responseError(response);
      if ([400, 404, 409].includes(response.status)) {
        store.db().prepare(
          `UPDATE billing_admission_outbox
           SET attempts = attempts + 1, next_attempt_at_ms = NULL,
               reconciliation_required = 1, last_error = ?,
               updated_at = datetime('now') WHERE id = ?`,
        ).run(
          [
            'billing admission claim requires reconciliation',
            `control returned ${response.status}`,
            detail,
          ].filter(Boolean).join(': '),
          row.id,
        );
        return 'reconciliation';
      }
      throw new Error(`billing admission recovery returned ${response.status}`);
    }

    const payload = await response.json().catch(() => null) as {
      hold?: { id?: unknown; status?: unknown };
    } | null;
    const holdId = typeof payload?.hold?.id === 'string' ? payload.hold.id : '';
    const holdStatus =
      typeof payload?.hold?.status === 'string' ? payload.hold.status : 'active';
    if (!/^hold_[a-zA-Z0-9]+$/u.test(holdId)) {
      throw new Error('commercial control returned an invalid recovered billing hold');
    }

    if (holdStatus === 'released' || holdStatus === 'expired') {
      const discarded = store.db().prepare(
        `UPDATE billing_admission_outbox
         SET hold_id = ?, status = 'discarded', attempts = attempts + 1,
             finalized_at_ms = ?, next_attempt_at_ms = NULL,
             reconciliation_required = 0, last_error = ?,
             updated_at = datetime('now')
         WHERE id = ? AND hold_id = ? AND desired_outcome IS NULL
           AND reconciliation_required = 1`,
      ).run(
        holdId,
        now,
        `billing hold was already ${holdStatus}; user operation was not executed`,
        row.id,
        row.hold_id,
      );
      return discarded.changes === 1 ? 'discarded' : 'reconciliation';
    }

    if (holdStatus !== 'active') {
      store.db().prepare(
        `UPDATE billing_admission_outbox
         SET attempts = attempts + 1, next_attempt_at_ms = NULL,
             reconciliation_required = 1, last_error = ?,
             updated_at = datetime('now') WHERE id = ?`,
      ).run(
        `recovered billing hold has unsafe status: ${holdStatus}`,
        row.id,
      );
      return 'reconciliation';
    }

    const recovered = store.db().prepare(
      `UPDATE billing_admission_outbox
       SET hold_id = ?, desired_outcome = 'release', status = 'pending',
           next_attempt_at_ms = NULL, reconciliation_required = 0,
           last_error = NULL, updated_at = datetime('now')
       WHERE id = ? AND hold_id = ? AND desired_outcome IS NULL
         AND reconciliation_required = 1`,
    ).run(holdId, row.id, row.hold_id);
    if (recovered.changes !== 1) return 'reconciliation';

    const delivered = await deliverBillingAdmission(
      store,
      {
        id: row.id,
        deployment_id: row.deployment_id,
        organization_id: row.organization_id,
        hold_id: holdId,
        module: row.module,
        units: row.units,
        reference_id: row.reference_id,
        idempotency_key: row.idempotency_key,
        desired_outcome: 'release',
        attempts: row.attempts,
      },
      fetchImpl,
      now,
    );
    if (delivered === 'captured') return 'reconciliation';
    return delivered;
  } catch (error) {
    store.db().prepare(
      `UPDATE billing_admission_outbox
       SET status = 'failed', attempts = attempts + 1, next_attempt_at_ms = ?,
           reconciliation_required = 1, last_error = ?,
           updated_at = datetime('now') WHERE id = ?`,
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
    reconciliation: 0,
    discarded: 0,
    failed: 0,
    skippedReason: null,
  };
  store.db().prepare(
    `DELETE FROM billing_admission_outbox
     WHERE status IN ('finalized', 'discarded') AND created_at_ms < ?`,
  ).run(now - 90 * 24 * 60 * 60 * 1000);
  const recovered = store.db().prepare(
    `UPDATE billing_admission_outbox
     SET status = 'failed', next_attempt_at_ms = NULL,
         reconciliation_required = 1,
         last_error = 'billing outcome is uncertain after interrupted execution; manual reconciliation required',
         updated_at = datetime('now')
     WHERE status = 'authorized' AND created_at_ms <= ?`,
  ).run(now - UNKNOWN_OPERATION_RECONCILIATION_MS);
  result.reconciliation += Number(recovered.changes);
  const bound = binding(store);
  const enforcement =
    bound?.credentials.enforcement ?? store.billingEnforcement?.() ?? 'disabled';
  if (enforcement !== 'enforce') {
    return { ...result, skippedReason: 'billing_enforcement_disabled' };
  }
  if (!bound) {
    return { ...result, skippedReason: 'billing_credentials_unavailable' };
  }
  const recoveryRows = store.db().prepare(
    `SELECT id, deployment_id, organization_id, hold_id, module, units,
            reference_id, idempotency_key, desired_outcome, attempts,
            created_at_ms, next_attempt_at_ms
     FROM billing_admission_outbox
     WHERE status = 'failed'
       AND desired_outcome IS NULL
       AND reconciliation_required = 1
       AND hold_id LIKE 'pending_%'
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
       AND (? IS NULL OR id = ?)
     ORDER BY created_at_ms ASC LIMIT 50`,
  ).all(now, onlyId ?? null, onlyId ?? null) as BillingAdmissionRecoveryRow[];
  result.attempted += recoveryRows.length;
  for (const row of recoveryRows) {
    const recoveredClaim = await recoverUncertainBillingAdmissionClaim(
      store, row, fetchImpl, now,
    );
    result[recoveredClaim] += 1;
  }

  const rows = store.db().prepare(
    `SELECT id, deployment_id, organization_id, hold_id, module, units,
            reference_id, idempotency_key, desired_outcome, attempts
     FROM billing_admission_outbox
     WHERE status IN ('pending', 'failed')
       AND desired_outcome IS NOT NULL
       AND reconciliation_required = 0
       AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
       AND (? IS NULL OR id = ?)
     ORDER BY created_at_ms ASC LIMIT 50`,
  ).all(now, onlyId ?? null, onlyId ?? null) as BillingAdmissionQueueRow[];
  result.attempted += rows.length;
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
    `SELECT desired_outcome, status, reconciliation_required
     FROM billing_admission_outbox WHERE id = ?`,
  ).get(admission.outboxId) as {
    desired_outcome: 'capture' | 'release' | null;
    status: string;
    reconciliation_required: number;
  } | undefined;
  if (!existing) throw new Error('billing admission outbox record is missing');
  if (existing.reconciliation_required === 1) {
    throw new Error('billing admission requires reconciliation');
  }
  if (existing.desired_outcome && existing.desired_outcome !== outcome) {
    throw new Error('billing admission already has a conflicting outcome');
  }
  if (existing.status === 'finalized') return;
  const updated = store.db().prepare(
    `UPDATE billing_admission_outbox
     SET desired_outcome = ?, status = 'pending', next_attempt_at_ms = NULL,
         reconciliation_required = 0, last_error = NULL,
         updated_at = datetime('now')
     WHERE id = ? AND reconciliation_required = 0`,
  ).run(outcome, admission.outboxId);
  if (updated.changes !== 1) {
    throw new Error('billing admission requires reconciliation');
  }
  const result = await flushBillingAdmissionQueue(
    store,
    fetchImpl,
    now,
    admission.outboxId,
  );
  if (result.reconciliation > 0) {
    throw new Error(`billing ${outcome} requires reconciliation`);
  }
  if (result.failed > 0) {
    throw new Error(`billing ${outcome} is queued for retry`);
  }
}
