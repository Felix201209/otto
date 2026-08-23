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
    keyRegistrationEndpoint:
      'https://control.example/v1/billing/execution-receipt-keys/bootstrap',
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
      const unavailable = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: false }, { status: 201 });
        }
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
      const available = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: true });
        }
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

  it('renews an expired missing receipt without changing economic identity', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 1_250,
        model: 'deepseek-v3',
        referenceId: 'task_expired_missing',
        idempotencyKey: 'usage:expired-missing',
      }, now)).toBe(true);
      const original = database.prepare(
        `SELECT receipt_id, task_id, issued_at_ms, expires_at_ms, sequence,
                policy_version, signing_key_id, receipt_signature
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_missing') as {
        receipt_id: string;
        task_id: string;
        issued_at_ms: number;
        expires_at_ms: number;
        sequence: number;
        policy_version: string;
        signing_key_id: string;
        receipt_signature: string;
      };
      const uploaded: Array<{
        receipt: Record<string, unknown>;
        signingKeyId: string;
        signature: string;
      }> = [];
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: false }, { status: 201 });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (target.includes('execution-receipts/status')) {
          expect(body).toMatchObject({
            deploymentId: DEPLOYMENT_ID,
            organizationId: ORGANIZATION_ID,
            receiptId: original.receipt_id,
          });
          return Response.json({
            result: { status: 'missing', receiptId: original.receipt_id },
          });
        }
        uploaded.push(body.envelope as {
          receipt: Record<string, unknown>;
          signingKeyId: string;
          signature: string;
        });
        return Response.json({ replayed: false }, { status: 201 });
      }) as unknown as typeof fetch;
      const renewedAt = now + 8 * 24 * 60 * 60 * 1_000;

      await expect(flushBillingUsageQueue(store, fetchImpl, renewedAt)).resolves
        .toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0]?.receipt).toMatchObject({
        version: 2,
        receiptId: original.receipt_id,
        deploymentId: DEPLOYMENT_ID,
        organizationId: ORGANIZATION_ID,
        taskId: original.task_id,
        moduleId: 'model_gateway',
        units: 1_250,
        model: 'deepseek-v3',
        sequence: original.sequence,
        policyVersion: original.policy_version,
        issuedAtMs: renewedAt,
      });
      expect(uploaded[0]?.receipt.expiresAtMs).toBeGreaterThan(renewedAt);
      expect(uploaded[0]?.signature).not.toBe(original.receipt_signature);
      expect(database.prepare(
        `SELECT status, issued_at_ms, receipt_id, sequence
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_missing')).toEqual({
        status: 'sent',
        issued_at_ms: renewedAt,
        receipt_id: original.receipt_id,
        sequence: original.sequence,
      });
    } finally {
      database.close();
    }
  });

  it('reconciles an expired receipt already consumed by Control without resending', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'meeting_agent',
        units: 900,
        model: 'local-whisper',
        referenceId: 'task_expired_consumed',
        idempotencyKey: 'usage:expired-consumed',
      }, now)).toBe(true);
      const original = database.prepare(
        `SELECT receipt_id, deployment_id, organization_id, task_id, module,
                units, model, issued_at_ms, expires_at_ms, sequence,
                policy_version, signing_key_id, receipt_signature
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_consumed') as Record<string, unknown>;
      const consumedReceipt = {
        version: 2,
        receiptId: original.receipt_id,
        deploymentId: original.deployment_id,
        organizationId: original.organization_id,
        taskId: original.task_id,
        moduleId: original.module,
        units: original.units,
        model: original.model,
        issuedAtMs: original.issued_at_ms,
        expiresAtMs: original.expires_at_ms,
        sequence: original.sequence,
        policyVersion: original.policy_version,
        signingKeyId: original.signing_key_id,
        signature: original.receipt_signature,
      };
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: true });
        }
        if (target.includes('execution-receipts/status')) {
          return Response.json({
            result: { status: 'consumed', receipt: consumedReceipt },
          });
        }
        throw new Error('consumed receipt must not be delivered again');
      }) as unknown as typeof fetch;

      await expect(flushBillingUsageQueue(
        store,
        fetchImpl,
        now + 8 * 24 * 60 * 60 * 1_000,
      )).resolves.toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(database.prepare(
        `SELECT status, issued_at_ms, receipt_signature
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_consumed')).toEqual({
        status: 'sent',
        issued_at_ms: original.issued_at_ms,
        receipt_signature: original.receipt_signature,
      });
    } finally {
      database.close();
    }
  });

  it('reconciles a receipt consumed between status lookup and renewed upload', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 640,
        model: 'deepseek-v3',
        referenceId: 'task_expired_race',
        idempotencyKey: 'usage:expired-race',
      }, now)).toBe(true);
      const original = database.prepare(
        `SELECT receipt_id, deployment_id, organization_id, task_id, module,
                units, model, issued_at_ms, expires_at_ms, sequence,
                policy_version, signing_key_id, receipt_signature
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_race') as Record<string, unknown>;
      const consumedReceipt = {
        version: 2,
        receiptId: original.receipt_id,
        deploymentId: original.deployment_id,
        organizationId: original.organization_id,
        taskId: original.task_id,
        moduleId: original.module,
        units: original.units,
        model: original.model,
        issuedAtMs: original.issued_at_ms,
        expiresAtMs: original.expires_at_ms,
        sequence: original.sequence,
        policyVersion: original.policy_version,
        signingKeyId: original.signing_key_id,
        signature: original.receipt_signature,
      };
      let statusChecks = 0;
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: true });
        }
        if (target.includes('execution-receipts/status')) {
          statusChecks += 1;
          return statusChecks === 1
            ? Response.json({
              result: { status: 'missing', receiptId: original.receipt_id },
            })
            : Response.json({
              result: { status: 'consumed', receipt: consumedReceipt },
            });
        }
        return new Response('{}', { status: 409 });
      }) as unknown as typeof fetch;
      const renewedAt = now + 8 * 24 * 60 * 60 * 1_000;

      await expect(flushBillingUsageQueue(store, fetchImpl, renewedAt)).resolves
        .toMatchObject({ attempted: 1, sent: 1, failed: 0 });
      expect(statusChecks).toBe(2);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(database.prepare(
        `SELECT status, attempts, issued_at_ms, receipt_id, sequence, last_error
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_race')).toEqual({
        status: 'sent',
        attempts: 0,
        issued_at_ms: renewedAt,
        receipt_id: original.receipt_id,
        sequence: original.sequence,
        last_error: null,
      });
    } finally {
      database.close();
    }
  });

  it('fails closed when expired receipt status cannot be verified', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: ORGANIZATION_ID,
        module: 'model_gateway',
        units: 700,
        model: 'deepseek-v3',
        referenceId: 'task_expired_unavailable',
        idempotencyKey: 'usage:expired-unavailable',
      }, now)).toBe(true);
      const original = database.prepare(
        `SELECT issued_at_ms, receipt_signature
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_unavailable') as {
        issued_at_ms: number;
        receipt_signature: string;
      };
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: false }, { status: 201 });
        }
        if (target.includes('execution-receipts/status')) {
          return new Response('{}', { status: 503 });
        }
        throw new Error('receipt upload must not run after uncertain status');
      }) as unknown as typeof fetch;

      await expect(flushBillingUsageQueue(
        store,
        fetchImpl,
        now + 8 * 24 * 60 * 60 * 1_000,
      )).resolves.toMatchObject({ attempted: 1, sent: 0, failed: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(database.prepare(
        `SELECT status, attempts, issued_at_ms, receipt_signature, last_error
         FROM billing_usage_outbox WHERE reference_id = ?`,
      ).get('task_expired_unavailable')).toEqual({
        status: 'failed',
        attempts: 1,
        issued_at_ms: original.issued_at_ms,
        receipt_signature: original.receipt_signature,
        last_error: 'execution receipt status endpoint returned 503',
      });
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

      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('execution-receipt-keys/bootstrap')) {
          return Response.json({ replayed: false }, { status: 201 });
        }
        throw new Error('receipt delivery must not run');
      }) as unknown as typeof fetch;
      await expect(flushBillingUsageQueue(store, fetchImpl, 3_000)).resolves
        .toMatchObject({ attempted: 1, sent: 0, failed: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0]?.[0]))
        .toContain('/execution-receipt-keys/bootstrap');
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

  it('attributes usage to each enterprise sharing the same deployment', async () => {
    const { database, store } = setup();
    try {
      const now = Date.parse('2026-08-03T08:00:00.000Z');
      expect(queueBillingUsage(store, {
        organizationId: 'org_tenant_alpha',
        module: 'model_gateway',
        units: 1_200,
        model: 'deepseek-v3',
        referenceId: 'task_tenant_alpha',
        idempotencyKey: 'usage:tenant-alpha',
      }, now)).toBe(true);
      expect(queueBillingUsage(store, {
        organizationId: 'org_tenant_beta',
        module: 'meeting_agent',
        units: 800,
        model: 'local-whisper',
        referenceId: 'task_tenant_beta',
        idempotencyKey: 'usage:tenant-beta',
      }, now + 1)).toBe(true);

      const uploadedOrganizations: string[] = [];
      let bootstrapBody: Record<string, unknown> | null = null;
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (String(url).includes('execution-receipt-keys/bootstrap')) {
          bootstrapBody = body;
          return Response.json({ replayed: false }, { status: 201 });
        }
        const envelope = body.envelope as {
          receipt: { organizationId: string };
        };
        uploadedOrganizations.push(envelope.receipt.organizationId);
        return Response.json({ replayed: false }, { status: 201 });
      }) as unknown as typeof fetch;

      await expect(flushBillingUsageQueue(store, fetchImpl, now + 2)).resolves
        .toMatchObject({ attempted: 2, sent: 2, failed: 0 });
      expect(uploadedOrganizations).toEqual(['org_tenant_alpha', 'org_tenant_beta']);
      expect(bootstrapBody).toMatchObject({
        deploymentId: DEPLOYMENT_ID,
        organizationId: ORGANIZATION_ID,
        machineFingerprint: 'a'.repeat(64),
        signature: expect.stringMatching(/^ed25519:/u),
      });
      const serialized = JSON.stringify(fetchImpl.mock.calls);
      expect(serialized).not.toContain('prompt');
      expect(serialized).not.toContain('message');
      expect(serialized).not.toContain('filename');
      expect(serialized).not.toContain('reply');
    } finally {
      database.close();
    }
  });
});
