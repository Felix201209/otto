/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { verifyE2eeReleaseReadiness } from '../verify-e2ee-release-readiness.mjs';

function readyStatus() {
  return {
    format: 2,
    protocol: {
      id: 'otto-mls-v2',
      implementation: 'openmls-0.8.1',
      externalAuditCompleted: true,
      openMlsProductionIntegrated: true,
      threatModelReviewed: true,
      protocolReviewed: true,
      multiDeviceSessions: true,
      forwardSecrecy: true,
      postCompromiseSecurity: true,
    },
    deviceTrust: {
      deviceCertificatesV2: true,
      signedApproval: true,
      recoveryV2: true,
      safetyNumbers: true,
      qrVerification: true,
      merkleTransparency: true,
      externalWitness: true,
    },
    integrations: {
      directMessages: true,
      attachments: true,
      localSearch: true,
      atoaOneTimeGrant: true,
    },
    adversarialTests: {
      maliciousServer: true,
      databaseTampering: true,
      deviceLoss: true,
      crossServer: true,
    },
    releaseGate: {
      requiresSignedEnablement: true,
      defaultDisabled: true,
    },
    auditReports: ['security/audits/e2ee-protocol-audit.pdf'],
    releaseApproved: true,
    prohibitedClaims: [],
  };
}

describe('E2EE production release readiness gate', () => {
  it('keeps the checked-in prototype manifest blocked', () => {
    const status = JSON.parse(
      fs.readFileSync('security/e2ee-release-status.json', 'utf8'),
    );
    const result = verifyE2eeReleaseReadiness(status);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'external audit is not complete',
        'OpenMLS is not integrated into production messaging',
        'an independent transparency witness is not configured',
        'signed E2EE module enablement is not enforced',
      ]),
    );
  });

  it('rejects a prototype and lists concrete unfinished MLS controls', () => {
    const status = readyStatus();
    status.protocol.externalAuditCompleted = false;
    status.protocol.openMlsProductionIntegrated = false;
    status.deviceTrust.externalWitness = false;
    status.adversarialTests.crossServer = false;
    status.releaseGate.requiresSignedEnablement = false;
    status.auditReports = [];
    status.releaseApproved = false;

    const result = verifyE2eeReleaseReadiness(status);
    expect(result.ready).toBe(false);
    expect(result.blockers.join('\n')).toMatch(
      /external audit|OpenMLS|witness|cross-server|signed E2EE|release approval/i,
    );
  });

  it('requires an existing third-party audit artifact', () => {
    const result = verifyE2eeReleaseReadiness(readyStatus(), {
      fileExists: () => false,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'external audit artifact is missing: security/audits/e2ee-protocol-audit.pdf',
    );
  });

  it('accepts only a fully reviewed MLS manifest behind a signed gate', () => {
    expect(
      verifyE2eeReleaseReadiness(readyStatus(), { fileExists: () => true }),
    ).toEqual({ ready: true, blockers: [] });
  });
});
