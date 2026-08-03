/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedFieldCipher, Database } from '../data_platform/index.js';
import { createAuditLogSchemaContributor } from './auditLogSchema.js';
import { createCommercialControlComposition } from './commercialControlComposition.js';
import { signTelemetryRequest } from './deploymentRepository.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';
import {
  canonicalJson,
  publicKeyId,
  signEd25519Envelope,
  verifyEd25519Envelope,
} from './signedEnvelope.js';

function setup() {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const publicKey = pair.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active'
    );
    INSERT INTO organizations (id) VALUES ('org-licensed');
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      deleted_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      account_type TEXT NOT NULL DEFAULT 'enterprise'
    );
  `);
  createAuditLogSchemaContributor({
    defaultOrganizationId: 'org-licensed',
  }).apply(database);
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.apply(database);
  const control = createCommercialControlComposition({
    db: () => database,
    defaultOrganizationId: 'org-licensed',
    creditTokenRate: () => undefined,
    licenseEnforcementEnabled: () => true,
    licenseVerificationPublicKeys: () => [publicKey],
    telemetryEndpoint: () => 'https://telemetry.otto.example/v1/events',
    telemetryIngestSecret: () =>
      'test-ingest-secret-at-least-32-characters',
    fieldCipher: createEncryptedFieldCipher({
      keyProvider: { getKey: () => Buffer.alloc(32, 17), clear() {} },
    }),
    databaseReadiness: () => ({ ready: true, schemaVersion: 1 }),
  });
  return { database, control, privateKey, publicKey };
}

describe('private deployment license repository', () => {
  it('treats an expired signed License as restricted at the execution layer', () => {
    const { database, control, privateKey } = setup();
    try {
      const now = Date.now();
      const payload = {
        id: 'lic-expired',
        deploymentId: control.getDeploymentId(),
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Expired customer',
        plan: 'enterprise',
        expiresAtMs: now - 60_000,
        seatLimit: 20,
        modules: ['enterprise_tree'],
        offline: true,
        telemetryAllowed: false,
        issuedAtMs: now - 24 * 60 * 60 * 1000,
      };
      expect(control.importDeploymentLicense({
        license: payload,
        signature: signEd25519Envelope(payload, privateKey),
      })).toMatchObject({ status: 'expired' });
      expect(control.isLicenseRestricted()).toBe(true);
      expect(control.isLicenseUsableForOrganizationFeature('enterprise_tree'))
        .toBe(false);
    } finally {
      database.close();
    }
  });

  it('queues content-free module usage and retries it with License-bound billing credentials', async () => {
    const { database, control, privateKey } = setup();
    try {
      const now = Date.now();
      const licensePayload = {
        id: 'lic-billing',
        deploymentId: control.getDeploymentId(),
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Billing customer',
        plan: 'enterprise',
        expiresAtMs: now + 90 * 24 * 60 * 60 * 1000,
        seatLimit: 20,
        modules: ['enterprise_tree'],
        offline: false,
        leaseEndpoint: 'https://control.otto.example/v1/licenses/lic-billing/lease',
        billingEndpoint: 'https://control.otto.example/v1/billing/usage/consume',
        billingEnforcement: 'enforce',
        leaseToken: 'test-license-lease-token-at-least-32-characters',
        telemetryAllowed: false,
        issuedAtMs: now,
      };
      control.importDeploymentLicense({
        license: licensePayload,
        signature: signEd25519Envelope(licensePayload, privateKey),
      });
      const leasePayload = {
        id: 'lease-billing',
        licenseId: licensePayload.id,
        deploymentId: licensePayload.deploymentId,
        machineFingerprint: licensePayload.machineFingerprint,
        issuedAtMs: now,
        expiresAtMs: now + 10 * 60 * 1000,
      };
      control.importDeploymentLicenseLease({
        lease: leasePayload,
        signature: signEd25519Envelope(leasePayload, privateKey),
      });

      expect(control.queueBillingUsage({
        organizationId: 'org-licensed',
        module: 'model_gateway',
        units: 1_250,
        referenceId: 'usage_abcdef',
        idempotencyKey: 'usage:abcdef',
      })).toBe(true);
      expect(control.queueBillingUsage({
        organizationId: 'org-licensed',
        module: 'model_gateway',
        units: 1_250,
        referenceId: 'usage_abcdef',
        idempotencyKey: 'usage:abcdef',
      })).toBe(false);

      let uploaded: Record<string, unknown> = {};
      let attempt = 0;
      const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('/execution-receipt-keys/bootstrap')) {
          const bootstrap = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(bootstrap).toMatchObject({
            licenseId: licensePayload.id,
            deploymentId: licensePayload.deploymentId,
            organizationId: licensePayload.organizationId,
            machineFingerprint: licensePayload.machineFingerprint,
            signature: expect.stringMatching(/^ed25519:/u),
          });
          return Response.json({ replayed: attempt > 0 }, { status: attempt > 0 ? 200 : 201 });
        }
        expect(String(url)).toBe(
          'https://control.otto.example/v1/billing/execution-receipts',
        );
        expect((init?.headers as Record<string, string>).authorization)
          .toBe(`Bearer ${licensePayload.leaseToken}`);
        uploaded = JSON.parse(String(init?.body));
        attempt += 1;
        if (attempt === 1) return new Response('{}', { status: 503 });
        return Response.json({ replayed: false }, { status: 201 });
      }) as unknown as typeof fetch;
      await expect(control.flushBillingUsageQueue(fetchImpl)).resolves.toMatchObject({
        attempted: 1,
        sent: 0,
        failed: 1,
      });
      expect(database.prepare(
        'SELECT status, COUNT(*) AS count FROM billing_usage_outbox GROUP BY status',
      ).all()).toEqual([{ status: 'failed', count: 1 }]);
      database.prepare(
        'UPDATE billing_usage_outbox SET next_attempt_at_ms = NULL WHERE idempotency_key = ?',
      ).run('usage:abcdef');
      await expect(control.flushBillingUsageQueue(fetchImpl)).resolves.toMatchObject({
        attempted: 1,
        sent: 1,
        failed: 0,
      });
      expect(uploaded).toMatchObject({
        licenseId: 'lic-billing',
        machineFingerprint: licensePayload.machineFingerprint,
        envelope: {
          receipt: {
            version: 2,
            deploymentId: licensePayload.deploymentId,
            organizationId: 'org-licensed',
            taskId: 'usage_abcdef',
            moduleId: 'model_gateway',
            units: 1_250,
            sequence: 1,
            policyVersion: 'commercial-v2',
          },
        },
      });
      const envelope = uploaded.envelope as {
        receipt: Record<string, unknown>;
        signingKeyId: string;
        signature: string;
      };
      const receiptKey = control.getBillingExecutionReceiptKey();
      expect(receiptKey.keyId).toBe(envelope.signingKeyId);
      expect(verifyEd25519Envelope(
        envelope.receipt,
        envelope.signature,
        [receiptKey.publicKeyPem],
        envelope.signingKeyId,
      )).toEqual({ valid: true, keyId: receiptKey.keyId });
      expect(JSON.stringify(uploaded)).not.toContain('prompt');
      const storedKey = database.prepare(
        `SELECT private_key_ciphertext, private_key_iv, private_key_auth_tag
         FROM billing_execution_receipt_keys`,
      ).get();
      expect(JSON.stringify(storedKey)).not.toContain('BEGIN PRIVATE KEY');
      expect(database.prepare(
        'SELECT status FROM billing_usage_outbox WHERE idempotency_key = ?',
      ).get('usage:abcdef')).toEqual({ status: 'sent' });
    } finally {
      database.close();
    }
  });

  it('requires an Ed25519 license bound to this deployment, organization, and machine', () => {
    const { database, control, privateKey, publicKey } = setup();
    try {
      const now = Date.now();
      const payload = {
        id: 'lic-bound',
        deploymentId: control.getDeploymentId(),
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Bound customer',
        plan: 'enterprise',
        expiresAtMs: now + 90 * 24 * 60 * 60 * 1000,
        seatLimit: 20,
        modules: ['enterprise_tree'],
        offline: true,
        telemetryAllowed: false,
        issuedAtMs: now,
      };
      const license = control.importDeploymentLicense({
        license: payload,
        signature: signEd25519Envelope(payload, privateKey),
      });
      expect(license).toMatchObject({
        id: 'lic-bound',
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        signatureAlgorithm: 'ed25519',
        status: 'active',
      });
      expect(() => control.importDeploymentLicense({
        license: { ...payload, id: 'lic-wrong-key-id' },
        signingKeyId: '0000000000000000',
        signature: signEd25519Envelope(
          { ...payload, id: 'lic-wrong-key-id' },
          privateKey,
        ),
      })).toThrow('signature invalid');
      expect(publicKeyId(publicKey)).toBe(license.signingKeyId);

      const copied = { ...payload, id: 'lic-copied', machineFingerprint: 'other' };
      expect(() =>
        control.importDeploymentLicense({
          license: copied,
          signature: signEd25519Envelope(copied, privateKey),
        }),
      ).toThrow('machineFingerprint mismatch');
      expect(() =>
        control.importDeploymentLicense({
          license: payload,
          signature: 'legacy-hmac-value',
        }),
      ).toThrow('signature invalid');
    } finally {
      database.close();
    }
  });

  it('locks an online license until a valid short lease is installed', () => {
    const { database, control, privateKey } = setup();
    try {
      const now = Date.now();
      const licensePayload = {
        id: 'lic-online',
        deploymentId: control.getDeploymentId(),
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Online customer',
        plan: 'enterprise',
        expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
        seatLimit: 20,
        modules: ['enterprise_tree'],
        offline: false,
        leaseEndpoint: 'https://license.otto.example/v1/lease',
        leaseToken: 'test-license-lease-token-at-least-32-characters',
        telemetryAllowed: true,
        telemetryToken: 'test-telemetry-token-at-least-32-characters',
        issuedAtMs: now,
      };
      expect(
        control.importDeploymentLicense({
          license: licensePayload,
          signature: signEd25519Envelope(licensePayload, privateKey),
        }).status,
      ).toBe('lease_missing');
      const storedLicense = database
        .prepare('SELECT raw_json FROM deployment_license WHERE id = ?')
        .get('lic-online') as { raw_json: string };
      expect(storedLicense.raw_json).not.toContain(licensePayload.leaseToken);
      expect(storedLicense.raw_json).not.toContain(licensePayload.telemetryToken);
      expect(storedLicense.raw_json).toContain('_ottoEncryptedSecretsV1');

      database
        .prepare('UPDATE deployment_license SET raw_json = ? WHERE id = ?')
        .run(JSON.stringify(licensePayload), 'lic-online');
      expect(control.ensureDeploymentLicenseSecretsEncrypted()).toBe(1);
      expect(control.ensureDeploymentLicenseSecretsEncrypted()).toBe(0);
      const migratedLicense = database
        .prepare('SELECT raw_json FROM deployment_license WHERE id = ?')
        .get('lic-online') as { raw_json: string };
      expect(migratedLicense.raw_json).not.toContain(licensePayload.leaseToken);
      expect(migratedLicense.raw_json).not.toContain(
        licensePayload.telemetryToken,
      );
      expect(control.getDeploymentLicense().status).toBe('lease_missing');

      const leasePayload = {
        id: 'lease-1',
        licenseId: 'lic-online',
        deploymentId: control.getDeploymentId(),
        machineFingerprint: control.getMachineFingerprint(),
        issuedAtMs: now,
        expiresAtMs: now + 10 * 60 * 1000,
      };
      expect(
        control.importDeploymentLicenseLease({
          lease: leasePayload,
          signature: signEd25519Envelope(leasePayload, privateKey),
        }),
      ).toMatchObject({
        status: 'active',
        lease: { required: true, status: 'active' },
      });
    } finally {
      database.close();
    }
  });

  it('reports active seats and installs renewed License terms during lease refresh', async () => {
    const { database, control, privateKey } = setup();
    try {
      database.exec(`
        INSERT INTO accounts (id, organization_id) VALUES
          ('account-1', 'org-licensed'),
          ('account-2', 'org-licensed'),
          ('account-3', 'org-tenant-beta');
        INSERT INTO accounts (id, organization_id, account_type) VALUES
          ('personal-account', 'personal-space', 'personal');
        INSERT INTO accounts (id, organization_id, status) VALUES
          ('disabled-account', 'org-tenant-beta', 'disabled');
      `);
      const now = Date.now();
      const licensePayload = {
        id: 'lic-lifecycle',
        revision: 1,
        deploymentId: control.getDeploymentId(),
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Lifecycle customer',
        plan: 'enterprise',
        expiresAtMs: now + 30 * 24 * 60 * 60 * 1000,
        seatLimit: 20,
        gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
        seatEnforcement: 'monitor',
        modules: ['enterprise_tree'],
        offline: false,
        leaseEndpoint: 'https://license.otto.example/v1/licenses/lic-lifecycle/lease',
        leaseToken: 'test-license-lease-token-at-least-32-characters',
        telemetryAllowed: true,
        telemetryToken: 'test-telemetry-token-at-least-32-characters',
        issuedAtMs: now,
      };
      control.importDeploymentLicense({
        license: licensePayload,
        signature: signEd25519Envelope(licensePayload, privateKey),
      });
      const renewedPayload = {
        ...licensePayload,
        revision: 2,
        expiresAtMs: now + 365 * 24 * 60 * 60 * 1000,
        seatLimit: 2,
        seatEnforcement: 'enforce',
      };
      const leasePayload = {
        id: 'lease-lifecycle',
        licenseId: licensePayload.id,
        deploymentId: licensePayload.deploymentId,
        machineFingerprint: licensePayload.machineFingerprint,
        licenseRevision: 2,
        issuedAtMs: now,
        expiresAtMs: now + 10 * 60 * 1000,
        seatLimit: 2,
        activeSeatCount: 3,
        seatStatus: 'overage_grace',
        graceReasons: ['seat_overage'],
        graceExpiresAtMs: now + 7 * 24 * 60 * 60 * 1000,
      };
      let requestBody: Record<string, unknown> = {};
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          lease: leasePayload,
          signature: signEd25519Envelope(leasePayload, privateKey),
          licenseEnvelope: {
            license: renewedPayload,
            signature: signEd25519Envelope(renewedPayload, privateKey),
          },
        });
      }) as unknown as typeof fetch;

      await expect(control.refreshDeploymentLicenseLease(fetchImpl)).resolves.toMatchObject({
        refreshed: true,
      });
      expect(requestBody).toMatchObject({ activeSeatCount: 3 });
      expect(control.getDeploymentLicense()).toMatchObject({
        revision: 2,
        seatLimit: 2,
        gracePeriodMs: 7 * 24 * 60 * 60 * 1000,
        seatEnforcement: 'enforce',
        activeSeatCount: 3,
        seatLimitExceeded: true,
        status: 'active',
        lease: {
          status: 'active',
          activeSeatCount: 3,
          seatStatus: 'overage_grace',
          graceReasons: ['seat_overage'],
        },
      });
      expect(control.isLicenseUsableForOrganizationFeature('enterprise_tree')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('uploads queued operational telemetry and the collector rejects content fields', async () => {
    const { database, control, privateKey } = setup();
    try {
      const deploymentId = control.getDeploymentId();
      const telemetryToken = createHmac(
        'sha256',
        'test-ingest-secret-at-least-32-characters',
      )
        .update(deploymentId)
        .digest('base64url');
      const now = Date.now();
      const licensePayload = {
        id: 'lic-telemetry',
        deploymentId,
        organizationId: 'org-licensed',
        machineFingerprint: control.getMachineFingerprint(),
        customerName: 'Telemetry customer',
        plan: 'enterprise',
        expiresAtMs: now + 90 * 24 * 60 * 60 * 1000,
        seatLimit: 20,
        modules: ['enterprise_tree'],
        offline: true,
        telemetryAllowed: true,
        telemetryToken,
        issuedAtMs: now,
      };
      control.importDeploymentLicense({
        license: licensePayload,
        signature: signEd25519Envelope(licensePayload, privateKey),
      });
      control.recordTelemetryEvent({
        eventType: 'agent_runtime',
        payload: { calls: 3, latencyMs: 120, errorCode: null },
      });
      control.recordTelemetryEvent({
        eventType: 'agent_runtime',
        payload: { calls: 1, prompt: 'must not be queued' },
      });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM telemetry_events WHERE status = 'queued'")
          .get(),
      ).toEqual({ count: 1 });
      const preexistingSensitivePayload = {
        deploymentId,
        organizationId: null,
        eventType: 'agent_runtime',
        createdAtMs: now,
        payload: { calls: 1, response: 'must not be transmitted' },
      };
      database.prepare(
        `INSERT INTO telemetry_events
           (id, deployment_id, organization_id, event_type, payload_json,
            signature, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      ).run(
        'tel_preexisting_sensitive',
        deploymentId,
        null,
        'agent_runtime',
        JSON.stringify(preexistingSensitivePayload),
        `sha256:${createHash('sha256')
          .update(canonicalJson(preexistingSensitivePayload))
          .digest('base64url')}`,
        now,
      );
      database.prepare(
        `INSERT INTO telemetry_events
           (id, deployment_id, organization_id, event_type, payload_json,
            signature, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`,
      ).run(
        'tel_expired_retention',
        deploymentId,
        'org-licensed',
        'runtime_health',
        '{}',
        'expired',
        now - 91 * 24 * 60 * 60 * 1000,
      );
      let uploadedBody: Record<string, unknown> | null = null;
      let uploadedHeaders: Record<string, string> = {};
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        uploadedBody = JSON.parse(String(init?.body));
        uploadedHeaders = Object.fromEntries(
          Object.entries(init?.headers as Record<string, string>),
        );
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;
      await expect(control.flushTelemetryQueue(fetchImpl)).resolves.toMatchObject({
        attempted: 2,
        sent: 1,
        discarded: 1,
        failed: 0,
      });
      expect(
        database.prepare('SELECT status FROM telemetry_events WHERE id = ?')
          .get('tel_preexisting_sensitive'),
      ).toEqual({ status: 'discarded' });
      expect(control.getTelemetryQueueSummary()).toMatchObject({ sent: 1 });
      expect(
        database.prepare('SELECT 1 FROM telemetry_events WHERE id = ?')
          .get('tel_expired_retention'),
      ).toBeUndefined();
      expect(
        control.ingestTelemetryBatch(
          uploadedBody,
          `Bearer ${telemetryToken}`,
          {
            timestamp: uploadedHeaders['x-otto-timestamp'],
            nonce: uploadedHeaders['x-otto-nonce'],
            signature: uploadedHeaders['x-otto-signature'],
          },
          now,
        ),
      ).toEqual({ accepted: 1, duplicates: 0 });
      expect(() =>
        control.ingestTelemetryBatch(
          uploadedBody,
          `Bearer ${telemetryToken}`,
          {
            timestamp: uploadedHeaders['x-otto-timestamp'],
            nonce: uploadedHeaders['x-otto-nonce'],
            signature: uploadedHeaders['x-otto-signature'],
          },
          now,
        ),
      ).toThrow('replay detected');
      const duplicateNonce = 'telemetry-duplicate-nonce-0001';
      expect(control.ingestTelemetryBatch(
        uploadedBody,
        `Bearer ${telemetryToken}`,
        {
          timestamp: String(now),
          nonce: duplicateNonce,
          signature: signTelemetryRequest({
            token: telemetryToken,
            timestamp: now,
            nonce: duplicateNonce,
            body: uploadedBody,
          }),
        },
        now,
      )).toEqual({ accepted: 0, duplicates: 1 });

      const forbiddenPayload = {
        deploymentId,
        eventType: 'agent_runtime',
        createdAtMs: now,
        payload: { message: 'must never leave customer server' },
      };
      const integrity = `sha256:${createHash('sha256')
        .update(canonicalJson(forbiddenPayload))
        .digest('base64url')}`;
      const forbiddenBatch = {
        deploymentId,
        events: [
          {
            id: 'tel_1234567890abcdef',
            eventType: 'agent_runtime',
            createdAtMs: now,
            payload: forbiddenPayload,
            integrity,
          },
        ],
      };
      const forbiddenNonce = 'telemetry-forbidden-nonce-0001';
      expect(() =>
        control.ingestTelemetryBatch(
          forbiddenBatch,
          `Bearer ${telemetryToken}`,
          {
            timestamp: String(now),
            nonce: forbiddenNonce,
            signature: signTelemetryRequest({
              token: telemetryToken,
              timestamp: now,
              nonce: forbiddenNonce,
              body: forbiddenBatch,
            }),
          },
          now,
        ),
      ).toThrow('content payload forbidden');

      database.exec(`
        CREATE TRIGGER telemetry_nonce_storage_failure
        BEFORE INSERT ON telemetry_ingest_nonces
        BEGIN
          SELECT RAISE(ABORT, 'nonce storage unavailable');
        END;
      `);
      const storageFailureNonce = 'telemetry-storage-failure-0001';
      expect(() =>
        control.ingestTelemetryBatch(
          uploadedBody,
          `Bearer ${telemetryToken}`,
          {
            timestamp: String(now),
            nonce: storageFailureNonce,
            signature: signTelemetryRequest({
              token: telemetryToken,
              timestamp: now,
              nonce: storageFailureNonce,
              body: uploadedBody,
            }),
          },
          now,
        ),
      ).toThrow('nonce storage unavailable');
    } finally {
      database.close();
    }
  });
});
