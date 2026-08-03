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
    holdEndpoint: 'https://control.example/v1/billing/holds',
    enforcement,
    leaseToken: 'lease-token',
  } as const;
  const store: BillingUsageRepositoryStore = {
    db: () => database,
    deploymentId: () => credentials.deploymentId,
    credentials: () => credentials,
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

  it('releases an interrupted operation after its admission window', async () => {
    const { database, store } = setup();
    try {
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/holds')) {
          return Response.json({ hold: { id: 'hold_interrupted' } }, { status: 201 });
        }
        expect(String(url)).toContain('/hold_interrupted/release');
        return Response.json({ replayed: false }, { status: 200 });
      }) as unknown as typeof fetch;
      await authorizeBillingOperation(store, operation, fetchImpl, 1_000);
      await expect(flushBillingAdmissionQueue(
        store,
        fetchImpl,
        1_000 + 15 * 60 * 1000 + 1,
      )).resolves.toMatchObject({ attempted: 1, released: 1 });
      expect(database.prepare(
        `SELECT status, desired_outcome FROM billing_admission_outbox
         WHERE idempotency_key = ?`,
      ).get(operation.idempotencyKey)).toEqual({
        status: 'finalized',
        desired_outcome: 'release',
      });
    } finally {
      database.close();
    }
  });
});
