/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  evaluateClusteredLicense,
  type ClusteredStoredLicense,
} from './clusteredLicensePolicy.js';
import { publicKeyId, signEd25519Envelope } from './signedEnvelope.js';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey
  .export({
    format: 'pem',
    type: 'pkcs8',
  })
  .toString();
const publicKey = keys.publicKey
  .export({
    format: 'pem',
    type: 'spki',
  })
  .toString();

function storedLicense(
  overrides: Record<string, unknown> = {},
): ClusteredStoredLicense {
  const payload = {
    id: 'lic_clustered',
    deploymentId: 'deployment-1',
    organizationId: 'organization-1',
    plan: 'enterprise',
    expiresAt: '2027-08-13T00:00:00.000Z',
    seatLimit: 5,
    modules: [
      'enterprise_tree',
      'direct_messages',
      'atoa',
      'knowledge',
      'skill_market',
      'park_service',
    ],
    offline: true,
    ...overrides,
  };
  return {
    version: 1,
    payload: {
      signedEnvelope: {
        payload,
        signature: signEd25519Envelope(payload, privateKey),
        signingKeyId: publicKeyId(publicKey),
      },
    },
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}

const base = {
  organizationId: 'organization-1',
  deploymentId: 'deployment-1',
  activeSeatCount: 2,
  publicKeys: [publicKey],
  nowMs: Date.parse('2026-08-13T00:00:00.000Z'),
};

describe('clustered PostgreSQL license execution policy', () => {
  it('admits a signed active license with the requested module', () => {
    expect(
      evaluateClusteredLicense({
        ...base,
        stored: storedLicense(),
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({
      allowed: true,
      summary: {
        status: 'active',
        seatLimit: 5,
        activeSeatCount: 2,
      },
    });
  });

  it.each([
    ['missing', null, 'deployment_license_inactive'],
    [
      'expired',
      storedLicense({ expiresAt: '2026-08-12T00:00:00.000Z' }),
      'deployment_license_inactive',
    ],
  ] as const)('fails closed for a %s license', (_name, stored, code) => {
    expect(
      evaluateClusteredLicense({
        ...base,
        stored,
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({ allowed: false, statusCode: 402, code });
  });

  it('rejects a valid license that does not include the requested module', () => {
    expect(
      evaluateClusteredLicense({
        ...base,
        stored: storedLicense({ modules: ['direct_messages'] }),
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({
      allowed: false,
      code: 'commercial_module_not_entitled',
      feature: 'knowledge',
    });
  });

  it('requires an explicit knowledge entitlement instead of inheriting it from enterprise tree', () => {
    expect(
      evaluateClusteredLicense({
        ...base,
        stored: storedLicense({ modules: ['enterprise_tree'] }),
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({
      allowed: false,
      code: 'commercial_module_not_entitled',
      feature: 'knowledge',
    });
  });

  it('blocks every business module when active seats exceed the signed limit', () => {
    expect(
      evaluateClusteredLicense({
        ...base,
        activeSeatCount: 6,
        stored: storedLicense({ seatLimit: 5 }),
        requiredFeature: 'direct_messages',
      }),
    ).toMatchObject({
      allowed: false,
      code: 'deployment_seat_limit_exceeded',
      summary: { seatLimitExceeded: true },
    });
  });

  it('rejects database claim tampering and unavailable verification keys', () => {
    const stored = storedLicense();
    const signedEnvelope = stored.payload.signedEnvelope as {
      payload: Record<string, unknown>;
    };
    signedEnvelope.payload.modules = ['knowledge'];
    expect(
      evaluateClusteredLicense({
        ...base,
        stored,
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({ allowed: false, code: 'deployment_license_inactive' });
    expect(
      evaluateClusteredLicense({
        ...base,
        stored: storedLicense(),
        publicKeys: [],
        requiredFeature: 'knowledge',
      }),
    ).toMatchObject({
      allowed: false,
      code: 'license_verification_unavailable',
    });
  });
});
