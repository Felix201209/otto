/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, signEd25519Envelope } from './signedEnvelope.js';
import { resolveDeploymentUpdatePolicy } from './updatePolicyClient.js';

const NOW = Date.parse('2026-07-31T08:00:00.000Z');
const CREDENTIALS = {
  licenseId: 'lic_1',
  deploymentId: 'dep_1',
  machineFingerprint: 'machine_1',
  leaseEndpoint: 'https://control.example.test/v1/licenses/lease',
  leaseToken: 'lease-secret',
};

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    deploymentId: CREDENTIALS.deploymentId,
    distributionId: 'otto-green',
    currentVersion: '1.9.10',
    decision: 'update',
    reason: 'update_available',
    release: {
      id: 'rel_1',
      version: '1.9.11',
      sourceCommit: 'abcdef1',
      channel: 'stable',
      mandatory: false,
      rolloutPercent: 100,
      notes: 'Green release',
      fullManifest: {
        url: 'https://updates.example.test/otto-green/latest.json',
        sha256: 'a'.repeat(64),
      },
      incrementalManifest: null,
      publishedAt: '2026-07-31T07:00:00.000Z',
    },
    issuedAtMs: NOW - 1_000,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

describe('deployment update policy client', () => {
  it('authenticates the request and accepts a correctly bound Ed25519 policy', async () => {
    const keys = keyPair();
    const signedPolicy = policy();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://control.example.test/v1/update-policy/resolve');
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const timestamp = headers.get('x-otto-timestamp');
      const nonce = headers.get('x-otto-nonce');
      expect(headers.get('authorization')).toBe(`Bearer ${CREDENTIALS.leaseToken}`);
      expect(body).toMatchObject({
        deploymentId: CREDENTIALS.deploymentId,
        distributionId: 'otto-green',
        currentVersion: '1.9.10',
      });
      expect(headers.get('x-otto-signature')).toBe(
        'hmac-sha256:' + createHmac('sha256', CREDENTIALS.leaseToken)
          .update(`${timestamp}\n${nonce}\n${canonicalJson(body)}`, 'utf8')
          .digest('base64url'),
      );
      return Response.json({
        policy: signedPolicy,
        signature: signEd25519Envelope(signedPolicy, keys.privateKey),
      });
    }) as typeof fetch;

    await expect(resolveDeploymentUpdatePolicy({
      credentials: CREDENTIALS,
      verificationPublicKeys: [keys.publicKey],
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
      fetchImpl,
      now: () => NOW,
    })).resolves.toMatchObject({
      status: 'resolved',
      policy: {
        distributionId: 'otto-green',
        decision: 'update',
        release: { version: '1.9.11' },
      },
    });
  });

  it('fails closed for tampered, expired, or cross-distribution policies', async () => {
    const keys = keyPair();
    for (const signedPolicy of [
      policy({ distributionId: 'otto' }),
      policy({ expiresAtMs: NOW - 1 }),
    ]) {
      const fetchImpl = vi.fn(async () => Response.json({
        policy: signedPolicy,
        signature: signEd25519Envelope(signedPolicy, keys.privateKey),
      })) as typeof fetch;
      await expect(resolveDeploymentUpdatePolicy({
        credentials: CREDENTIALS,
        verificationPublicKeys: [keys.publicKey],
        distributionId: 'otto-green',
        currentVersion: '1.9.10',
        fetchImpl,
        now: () => NOW,
      })).resolves.toMatchObject({ status: 'unavailable' });
    }

    const validPolicy = policy();
    const wrongKeys = keyPair();
    const fetchImpl = vi.fn(async () => Response.json({
      policy: validPolicy,
      signature: signEd25519Envelope(validPolicy, wrongKeys.privateKey),
    })) as typeof fetch;
    await expect(resolveDeploymentUpdatePolicy({
      credentials: CREDENTIALS,
      verificationPublicKeys: [keys.publicKey],
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
      fetchImpl,
      now: () => NOW,
    })).resolves.toMatchObject({
      status: 'unavailable',
      error: expect.stringContaining('signature'),
    });
  });

  it('reports a compatible unconfigured state when no online lease exists', async () => {
    await expect(resolveDeploymentUpdatePolicy({
      credentials: null,
      verificationPublicKeys: [],
      distributionId: 'otto',
      currentVersion: '1.9.10',
    })).resolves.toEqual({
      status: 'not_configured',
      reason: 'online_license_required',
    });
  });
});
