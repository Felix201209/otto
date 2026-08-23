/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { Database } from '../data_platform/index.js';
import {
  authorizeBillingOperation,
  BillingAdmissionError,
  finalizeBillingOperation,
  flushBillingAdmissionQueue,
} from './billingAdmissionRepository.js';
import type { BillingUsageRepositoryStore } from './billingUsageRepository.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';

function setup(enforcement: 'disabled' | 'enforce' = 'enforce') {
  const database = new Database(':memory:');
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.apply(database);
  const credentials = {
    licenseId: 'lic-commercial',
    deploymentId: 'dep-commercial',
    organizationId: 'org-commercial',
    machineFingerprint: 'a'.repeat(64),
    endpoint: 'https://control.example/v1/billing/usage',
    keyRegistrationEndpoint:
      'https://control.example/v1/billing/execution-receipt-keys/bootstrap',
    holdEndpoint: 'https://control.example/v1/billing/holds',
    enforcement,
    leaseToken: 'lease-token',
  } as const;
  const store: BillingUsageRepositoryStore = {
    db: () => database,
    deploymentId: () => credentials.deploymentId,
    credentials: () => credentials,
    billingEnforcement: () => enforcement,
  };
  return { database, store };
}

const operation = {
  module: 'park_service' as const,
  units: 1,
  idempotencyKey: 'request:park:1',
  referenceId: 'op_park_1',
};

describe('billing admission repository', () => {
  it('keeps existing deployments open unless signed enforcement is enabled', async () => {
    const { database, store } = setup('disabled');
    try {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(authorizeBillingOperation(store, operation, fetchImpl)).resolves
        .toMatchObject({ required: false, holdId: null });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM billing_admission_outbox',
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('fails closed when enforced billing credentials are missing or malformed', async () => {
    const { database, store } = setup();
    try {
      store.credentials = () => null;
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      await expect(authorizeBillingOperation(store, operation, fetchImpl)).rejects
        .toMatchObject<BillingAdmissionError>({
          code: 'billing_policy_unavailable',
          statusCode: 503,
        });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM billing_admission_outbox',
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('fails closed when an enforced operation has no idempotency key', async () => {
    const { database, store } = setup();
    try {
      await expect(authorizeBillingOperation(store, {
        ...operation,
        idempotencyKey: '',
      })).rejects.toMatchObject<BillingAdmissionError>({
        code: 'billing_idempotency_key_required',
        statusCode: 400,
      });
    } finally {
      database.close();
    }
  });

  it('claims an idempotency key before contacting Control and rejects concurrent replay', async () => {
    const { database, store } = setup();
    try {
      let releaseHold!: (response: Response) => void;
      const holdResponse = new Promise<Response>((resolve) => {
        releaseHold = resolve;
      });
      const fetchImpl = vi.fn(async () => holdResponse) as unknown as typeof fetch;

      const first = authorizeBillingOperation(store, operation, fetchImpl, 1_000);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      await expect(
        authorizeBillingOperation(store, operation, fetchImpl, 1_001),
      ).rejects.toMatchObject<BillingAdmissionError>({
        code: 'billing_operation_replayed',
        statusCode: 409,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      releaseHold(Response.json(
        { hold: { id: 'hold_concurrent123' } },
        { status: 201 },
      ));
      await expect(first).resolves.toMatchObject({
        holdId: 'hold_concurrent123',
      });
    } finally {
      database.close();
    }
  });

  it('rejects a completed idempotency replay before contacting Control again', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async () => Response.json(
        { hold: { id: 'hold_replay123' } },
        { status: 201 },
      )) as unknown as typeof fetch;

      await authorizeBillingOperation(store, operation, fetchImpl, 1_000);
      await expect(
        authorizeBillingOperation(store, operation, fetchImpl, 2_000),
      ).rejects.toMatchObject<BillingAdmissionError>({
        code: 'billing_operation_replayed',
        statusCode: 409,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it('keeps an unknown hold outcome for reconciliation and blocks replay', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('socket closed after request write');
      }) as unknown as typeof fetch;

      await expect(authorizeBillingOperation(store, operation, fetchImpl, 1_000))
        .rejects.toMatchObject<BillingAdmissionError>({
          code: 'billing_operation_uncertain',
          statusCode: 503,
        });
      expect(database.prepare(
        `SELECT reconciliation_required, next_attempt_at_ms FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        reconciliation_required: 1,
        next_attempt_at_ms: null,
      });
      await expect(authorizeBillingOperation(store, operation, fetchImpl, 2_000))
        .rejects.toMatchObject<BillingAdmissionError>({
          code: 'billing_operation_replayed',
          statusCode: 409,
        });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });
  it('recovers an uncertain hold claim and releases it without executing the operation', async () => {
    const { database, store } = setup();
    try {
      let call = 0;
      const urls: string[] = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        urls.push(String(url));
        call += 1;
        if (call === 1) throw new TypeError('socket closed after request write');
        if (call === 2) {
          return Response.json(
            { replayed: true, hold: { id: 'hold_recovered123', status: 'active' } },
            { status: 200 },
          );
        }
        return Response.json({ replayed: false }, { status: 200 });
      }) as unknown as typeof fetch;

      await expect(authorizeBillingOperation(store, operation, fetchImpl, 1_000))
        .rejects.toMatchObject<BillingAdmissionError>({
          code: 'billing_operation_uncertain',
          statusCode: 503,
        });
      await expect(flushBillingAdmissionQueue(store, fetchImpl, 10_000)).resolves
        .toMatchObject({
          attempted: 1,
          released: 1,
          reconciliation: 0,
          failed: 0,
        });

      expect(database.prepare(
        `SELECT hold_id, status, desired_outcome, reconciliation_required
         FROM billing_admission_outbox WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        hold_id: 'hold_recovered123',
        status: 'finalized',
        desired_outcome: 'release',
        reconciliation_required: 0,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(urls.at(-1)).toContain('/hold_recovered123/release');
    } finally {
      database.close();
    }
  });

  it('discards an uncertain claim when Control reports that the hold already expired', async () => {
    const { database, store } = setup();
    try {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) throw new TypeError('socket closed after request write');
        return Response.json(
          { replayed: true, hold: { id: 'hold_expired123', status: 'expired' } },
          { status: 200 },
        );
      }) as unknown as typeof fetch;

      await expect(authorizeBillingOperation(store, operation, fetchImpl, 1_000))
        .rejects.toMatchObject<BillingAdmissionError>({
          code: 'billing_operation_uncertain',
        });
      await expect(flushBillingAdmissionQueue(store, fetchImpl, 10_000)).resolves
        .toMatchObject({
          attempted: 1,
          discarded: 1,
          reconciliation: 0,
          failed: 0,
        });

      expect(database.prepare(
        `SELECT hold_id, status, desired_outcome, reconciliation_required
         FROM billing_admission_outbox WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        hold_id: 'hold_expired123',
        status: 'discarded',
        desired_outcome: null,
        reconciliation_required: 0,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it('keeps an uncertain hold frozen when Control is still unreachable', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('control is unreachable');
      }) as unknown as typeof fetch;

      await expect(authorizeBillingOperation(store, operation, fetchImpl, 1_000))
        .rejects.toMatchObject<BillingAdmissionError>({
          code: 'billing_operation_uncertain',
        });
      await expect(flushBillingAdmissionQueue(store, fetchImpl, 10_000)).resolves
        .toMatchObject({
          attempted: 1,
          reconciliation: 0,
          failed: 1,
        });

      expect(database.prepare(
        `SELECT status, desired_outcome, reconciliation_required,
                next_attempt_at_ms
         FROM billing_admission_outbox WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        status: 'failed',
        desired_outcome: null,
        reconciliation_required: 1,
        next_attempt_at_ms: 20_000,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it('persists a hold before execution and retries capture idempotently', async () => {
    const { database, store } = setup();
    try {
      let captureAttempts = 0;
      const payloads: Array<Record<string, unknown>> = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (String(url).endsWith('/holds')) {
          return Response.json({ hold: { id: 'hold_abcdef123456' } }, { status: 201 });
        }
        captureAttempts += 1;
        if (captureAttempts === 1) return new Response('{}', { status: 503 });
        return Response.json({ replayed: false }, { status: 200 });
      }) as unknown as typeof fetch;

      const admission = await authorizeBillingOperation(store, operation, fetchImpl, 1_000);
      expect(admission).toMatchObject({
        required: true,
        holdId: 'hold_abcdef123456',
      });
      expect(database.prepare(
        `SELECT status, desired_outcome FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        status: 'authorized',
        desired_outcome: null,
      });

      await expect(finalizeBillingOperation(
        store,
        admission,
        'capture',
        fetchImpl,
        2_000,
      )).rejects.toThrow('queued for retry');
      expect(database.prepare(
        `SELECT status, desired_outcome FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        status: 'failed',
        desired_outcome: 'capture',
      });

      database.prepare(
        `UPDATE billing_admission_outbox SET next_attempt_at_ms = NULL
         WHERE idempotency_key = ?`,
      ).run(operation.idempotencyKey);
      await expect(flushBillingAdmissionQueue(store, fetchImpl, 10_000)).resolves
        .toMatchObject({ attempted: 1, captured: 1, failed: 0 });
      expect(database.prepare(
        `SELECT status, desired_outcome FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        status: 'finalized',
        desired_outcome: 'capture',
      });
      expect(payloads.at(-1)).toMatchObject({
        units: 1,
        referenceId: operation.referenceId,
        idempotencyKey: `capture:${operation.idempotencyKey}`,
      });
    } finally {
      database.close();
    }
  });

  it.each([
    ['capture', 400],
    ['capture', 404],
    ['capture', 409],
    ['release', 400],
    ['release', 404],
    ['release', 409],
  ] as const)(
    'keeps a rejected %s outcome with status %i in reconciliation',
    async (outcome, statusCode) => {
      const { database, store } = setup();
      try {
        const fetchImpl = vi.fn(async (url: string | URL | Request) => {
          if (String(url).endsWith('/holds')) {
            return Response.json({ hold: { id: 'hold_reconcile123' } }, { status: 201 });
          }
          return Response.json(
            { error: `control rejected ${outcome}` },
            { status: statusCode },
          );
        }) as unknown as typeof fetch;

        const admission = await authorizeBillingOperation(
          store,
          {
            ...operation,
            idempotencyKey: `request:park:${outcome}:${statusCode}`,
          },
          fetchImpl,
          1_000,
        );
        await expect(finalizeBillingOperation(
          store,
          admission,
          outcome,
          fetchImpl,
          2_000,
        )).rejects.toThrow(`billing ${outcome} requires reconciliation`);

        expect(database.prepare(
          `SELECT status, desired_outcome, reconciliation_required,
                  next_attempt_at_ms, last_error
           FROM billing_admission_outbox WHERE id = ?`,
        ).get(admission.outboxId)).toMatchObject({
          status: 'failed',
          desired_outcome: outcome,
          reconciliation_required: 1,
          next_attempt_at_ms: null,
          last_error: expect.stringContaining(`control returned ${statusCode}`),
        });
        await expect(flushBillingAdmissionQueue(store, fetchImpl, 10_000)).resolves
          .toMatchObject({ attempted: 0, reconciliation: 0 });
        await expect(finalizeBillingOperation(
          store,
          admission,
          outcome,
          fetchImpl,
          11_000,
        )).rejects.toThrow('billing admission requires reconciliation');
        expect(database.prepare(
          `SELECT reconciliation_required
           FROM billing_admission_outbox WHERE id = ?`,
        ).get(admission.outboxId)).toEqual({
          reconciliation_required: 1,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        database.close();
      }
    },
  );

  it('binds admission and finalization to the authenticated tenant organization', async () => {
    const { database, store } = setup();
    try {
      const payloads: Array<Record<string, unknown>> = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (String(url).endsWith('/holds')) {
          return Response.json({ hold: { id: 'hold_tenantbeta' } }, { status: 201 });
        }
        return Response.json({ replayed: false }, { status: 200 });
      }) as unknown as typeof fetch;
      const tenantOperation = {
        ...operation,
        organizationId: 'org_tenant_beta',
        idempotencyKey: 'request:park:tenant-beta',
        referenceId: 'op_park_tenant_beta',
      };

      const admission = await authorizeBillingOperation(
        store,
        tenantOperation,
        fetchImpl,
        1_000,
      );
      await expect(finalizeBillingOperation(
        store,
        admission,
        'capture',
        fetchImpl,
        2_000,
      )).resolves.toBeUndefined();

      expect(payloads).toHaveLength(2);
      expect(payloads[0]).toMatchObject({ organizationId: 'org_tenant_beta' });
      expect(payloads[1]).toMatchObject({ organizationId: 'org_tenant_beta' });
      expect(database.prepare(
        `SELECT organization_id, status FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(tenantOperation.idempotencyKey)).toEqual({
        organization_id: 'org_tenant_beta',
        status: 'finalized',
      });
    } finally {
      database.close();
    }
  });

  it('maps insufficient credit responses to a stable execution error', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async () => Response.json(
        { error: 'insufficient available credits' },
        { status: 409 },
      )) as unknown as typeof fetch;
      await expect(authorizeBillingOperation(store, operation, fetchImpl)).rejects
        .toMatchObject<BillingAdmissionError>({
          code: 'insufficient_credits',
          statusCode: 402,
        });
      expect(database.prepare(
        'SELECT COUNT(*) AS count FROM billing_admission_outbox',
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('moves an interrupted authorized operation to reconciliation without releasing it', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toMatch(/\/holds$/u);
        return Response.json({ hold: { id: 'hold_interrupted' } }, { status: 201 });
      }) as unknown as typeof fetch;
      await authorizeBillingOperation(store, operation, fetchImpl, 1_000);

      await expect(flushBillingAdmissionQueue(
        store,
        fetchImpl,
        1_000 + 15 * 60 * 1000 + 1,
      )).resolves.toMatchObject({
        attempted: 0,
        released: 0,
        captured: 0,
        reconciliation: 1,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(database.prepare(
        `SELECT status, desired_outcome, reconciliation_required,
                next_attempt_at_ms, last_error
         FROM billing_admission_outbox WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toMatchObject({
        status: 'failed',
        desired_outcome: null,
        reconciliation_required: 1,
        next_attempt_at_ms: null,
        last_error: expect.stringContaining('outcome is uncertain'),
      });
    } finally {
      database.close();
    }
  });
});
