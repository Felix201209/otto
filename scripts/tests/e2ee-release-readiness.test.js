/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { verifyE2eeReleaseReadiness } from '../verify-e2ee-release-readiness.mjs';

function readyStatus() {
  return {
    format: 1,
    protocol: {
      id: 'audited-ratchet-v1',
      implementation: 'approved-provider',
      externalAuditCompleted: true,
      prekeyHandshake: true,
      doubleRatchet: true,
      multiDeviceSessions: true,
      safetyStateReset: true,
      forwardSecrecy: true,
      postCompromiseSecurity: true,
    },
    deviceTrust: {
      safetyNumbers: true,
      qrVerification: true,
      outOfBandDeviceApproval: true,
      keyTransparency: true,
    },
    auditReports: ['security/audits/e2ee-protocol-audit.pdf'],
    releaseApproved: true,
    prohibitedClaims: [],
  };
}

describe('E2EE production release readiness gate', () => {
  it('rejects the current envelope protocol without Signal-level claims', () => {
    const result = verifyE2eeReleaseReadiness({
      ...readyStatus(),
      protocol: {
        ...readyStatus().protocol,
        id: 'device-envelope-v1',
        implementation: 'otto-legacy-envelope',
        externalAuditCompleted: false,
        prekeyHandshake: false,
        doubleRatchet: false,
        forwardSecrecy: false,
        postCompromiseSecurity: false,
      },
      auditReports: [],
      releaseApproved: false,
      prohibitedClaims: [
        'Signal-grade security',
        'complete forward secrecy',
        'post-compromise security',
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers.join('\n')).toMatch(
      /external audit|prekey|Double Ratchet|forward secrecy|post-compromise|release approval/i,
    );
  });

  it('requires an existing external audit artifact and every declared control', () => {
    const result = verifyE2eeReleaseReadiness(readyStatus(), {
      fileExists: () => false,
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'external audit artifact is missing: security/audits/e2ee-protocol-audit.pdf',
    );
  });

  it('accepts only a fully reviewed ratcheting protocol manifest', () => {
    expect(
      verifyE2eeReleaseReadiness(readyStatus(), { fileExists: () => true }),
    ).toEqual({ ready: true, blockers: [] });
  });
});
