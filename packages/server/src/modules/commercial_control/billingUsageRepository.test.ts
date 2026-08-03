/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { createEncryptedFieldCipher, Database } from '../data_platform/index.js';
import {
  flushBillingUsageQueue,
  queueBillingUsage,
  type BillingUsageRepositoryStore,
} from './billingUsageRepository.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';

const DEPLOYMENT_ID = 'dep_receipt_test';
const ORGANIZATION_ID = 'org_receipt_test';

function setup() {
  const database = new Database(':memory:');
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.apply(database);
  const credentials = {
    licenseId: 'lic_receipt_test',
    deploymentId: DEPLOYMENT_ID,
    organizationId: ORGANIZATION_ID,
    machineFingerprint: 'a'.repeat(64),
    endpoint: 'https://control.example/v1/billing/execution-receipts',
    holdEndpoint: 'https://control.example/v1/billing/holds',
    enforcement: 'enforce' as const,
    leaseToken: 'test-lease-token-long-enough-for-receipt-upload',
  };
  const store: BillingUsageRepositoryStore = {
    db: () => database,
    deploymentId: () => DEPLOYMENT_ID,
    credentials: () => credentials,
    fieldCipher: createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 29), clear() {} },
    }),
  };
  return { database, store };
}

describe('signed execution receipt outbox', () => {
  it('stops at a failed head receipt and resumes in contiguous order', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 1_000,
        model: 'deepseek-v3',
        referenceId: 'task_model_1',
        idempotencyKey: 'usage:model:1',
      }, now)).toBe(true);
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 2_000,
        model: 'deepseek-v3',
        referenceId: 'task_model_2',
        idempotencyKey: 'usage:model:2',
      }, now + 1)).toBe(true);

      const firstAttemptSequences: number[] = [];
      const unavailable = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          envelope: { receipt: { sequence: number } };
        };
        firstAttemptSequences.push(body.envelope.receipt.sequence);
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch;
      await expect(flushBillingUsageQueue(store, unavailable, now + 2)).resolves
        .toMatchObject({ attempted: 1, sent: 0, failed: 1 });
      expect(firstAttemptSequences).toEqual([1]);
      expect(database.prepare(
        `SELECT sequence, status FROM billing_usage_outbox ORDER BY sequence`,
      ).all()).toEqual([
        { sequence: 1, status: 'failed' },
        { sequence: 2, status: 'queued' },
      ]);

      database.prepare(
        'UPDATE billing_usage_outbox SET next_attempt_at_ms = NULL',
      ).run();
      const deliveredSequences: number[] = [];
      const available = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          envelope: { receipt: { sequence: number } };
        };
        deliveredSequences.push(body.envelope.receipt.sequence);
        return Response.json({ replayed: false }, { status: 201 });
      }) as unknown as typeof fetch;
      await expect(flushBillingUsageQueue(store, available, now + 3)).resolves
        .toMatchObject({ attempted: 2, sent: 2, failed: 0 });
      expect(deliveredSequences).toEqual([1, 2]);
    } finally {
      database.close();
    }
  });

  it('migrates pending legacy usage before assigning new receipt sequences', () => {
    const { database, store } = setup();
    try {
      database.prepare(
        `INSERT INTO billing_usage_outbox
          (id, deployment_id, organization_id, module, units, reference_id,
           idempotency_key, status, created_at_ms)
         VALUES (?, ?, ?, 'model_gateway', 500, ?, ?, 'queued', ?)`,
      ).run(
        'bil_legacy',
        DEPLOYMENT_ID,
        ORGANIZATION_ID,
        'task_legacy',
        'usage:legacy',
        1_000,
      );
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 750,
        referenceId: 'task_current',
        idempotencyKey: 'usage:current',
      }, 2_000)).toBe(true);
      expect(database.prepare(
        `SELECT reference_id, receipt_version, sequence, signing_key_id,
                receipt_signature
         FROM billing_usage_outbox ORDER BY sequence`,
      ).all()).toEqual([
        expect.objectContaining({
          reference_id: 'task_legacy',
          receipt_version: 2,
          sequence: 1,
          signing_key_id: expect.stringMatching(/^[a-f0-9]{16}$/u),
          receipt_signature: expect.stringMatching(/^ed25519:/u),
        }),
        expect.objectContaining({
          reference_id: 'task_current',
          receipt_version: 2,
          sequence: 2,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it('blocks attempted unsigned usage for operator reconciliation', async () => {
    const { database, store } = setup();
    try {
      database.prepare(
        `INSERT INTO billing_usage_outbox
          (id, deployment_id, organization_id, module, units, reference_id,
           idempotency_key, status, attempts, created_at_ms)
         VALUES (?, ?, ?, 'model_gateway', 500, ?, ?, 'failed', 1, ?)`,
      ).run(
        'bil_legacy_attempted',
        DEPLOYMENT_ID,
        ORGANIZATION_ID,
        'task_legacy_attempted',
        'usage:legacy-attempted',
        1_000,
      );
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 750,
        referenceId: 'task_current_after_legacy',
        idempotencyKey: 'usage:current-after-legacy',
      }, 2_000)).toBe(true);

      const fetchImpl = vi.fn() as unknown as typeof fetch;
      await expect(flushBillingUsageQueue(store, fetchImpl, 3_000)).resolves
        .toMatchObject({ attempted: 1, sent: 0, failed: 1 });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(database.prepare(
        `SELECT receipt_id, status, last_error
         FROM billing_usage_outbox WHERE id = 'bil_legacy_attempted'`,
      ).get()).toEqual({
        receipt_id: null,
        status: 'failed',
        last_error: 'legacy attempted usage requires operator reconciliation before v2 delivery',
      });
    } finally {
      database.close();
    }
  });

  it('never persists user content in billing evidence', () => {
    const { database, store } = setup();
    try {
      queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 321,
        model: 'custom-model',
        referenceId: 'task_private_content',
        idempotencyKey: 'usage:private-content',
      });
      const rows = database.prepare(
        'SELECT * FROM billing_usage_outbox',
      ).all();
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('prompt');
      expect(serialized).not.toContain('message');
      expect(serialized).not.toContain('filename');
      expect(serialized).not.toContain('reply');
    } finally {
      database.close();
    }
  });
});
