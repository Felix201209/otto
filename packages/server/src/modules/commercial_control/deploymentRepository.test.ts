/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createAuditLogSchemaContributor } from './auditLogSchema.js';
import { createCommercialControlComposition } from './commercialControlComposition.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';
import { canonicalJson, signEd25519Envelope } from './signedEnvelope.js';

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
    databaseReadiness: () => ({ ready: true, schemaVersion: 1 }),
  });
  return { database, control, privateKey };
}

describe('private deployment license repository', () => {
  it('requires an Ed25519 license bound to this deployment, organization, and machine', () => {
    const { database, control, privateKey } = setup();
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
      let uploadedBody: Record<string, unknown> | null = null;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        uploadedBody = JSON.parse(String(init?.body));
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;
      await expect(control.flushTelemetryQueue(fetchImpl)).resolves.toMatchObject({
        attempted: 1,
        sent: 1,
        failed: 0,
      });
      expect(control.getTelemetryQueueSummary()).toMatchObject({ sent: 1 });
      expect(
        control.ingestTelemetryBatch(
          uploadedBody,
          `Bearer ${telemetryToken}`,
        ),
      ).toEqual({ accepted: 1, duplicates: 0 });
      expect(
        control.ingestTelemetryBatch(
          uploadedBody,
          `Bearer ${telemetryToken}`,
        ),
      ).toEqual({ accepted: 0, duplicates: 1 });

      const forbiddenPayload = {
        deploymentId,
        eventType: 'agent_runtime',
        createdAtMs: now,
        payload: { message: 'must never leave customer server' },
      };
      const integrity = `sha256:${createHash('sha256')
        .update(canonicalJson(forbiddenPayload))
        .digest('base64url')}`;
      expect(() =>
        control.ingestTelemetryBatch(
          {
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
          },
          `Bearer ${telemetryToken}`,
        ),
      ).toThrow('content payload forbidden');
    } finally {
      database.close();
    }
  });
});
