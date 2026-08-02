/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { verifyE2eeReleaseReadiness } from '../verify-e2ee-release-readiness.mjs';

function readyStatus() {
  return {
    format: 1,
    protocol: {
      id: 'audited-ratchet-v1',
      implementation: 'approved-provider',
      serverCiphertextTransport: true,
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
  it('keeps the checked-in transport foundation blocked from production claims', () => {
    const current = JSON.parse(
      readFileSync(
        new URL('../../security/e2ee-release-status.json', import.meta.url),
        'utf8',
      ),
    );
    const result = verifyE2eeReleaseReadiness(current);

    expect(current.protocol).toMatchObject({
      serverCiphertextTransport: true,
      transportSessionHistory: true,
      transportSessionReset: true,
      safetyStateReset: false,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'external audit is not complete',
        'prekey handshake is not implemented',
        'Double Ratchet is not implemented',
        'multi-device sessions are not implemented',
        'safety state reset is not implemented',
        'forward secrecy is not established',
        'post-compromise security is not established',
        'external audit report is not recorded',
        'explicit E2EE production release approval is missing',
      ]),
    );
  });

  it('rejects the current envelope protocol without Signal-level claims', () => {
    const result = verifyE2eeReleaseReadiness({
      ...readyStatus(),
      protocol: {
        ...readyStatus().protocol,
        id: 'device-envelope-v1',
        implementation: 'otto-legacy-envelope',
        serverCiphertextTransport: false,
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
