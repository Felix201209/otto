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
      desktopCiphertextTransportClient: true,
      desktopTransportSessionOrchestration: true,
      externalAuditCompleted: true,
      prekeyHandshake: true,
      doubleRatchet: true,
      mls10SessionProtocol: false,
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
  it('keeps the checked-in MLS candidate blocked until external review and approval', () => {
    const current = JSON.parse(
      readFileSync(
        new URL('../../security/e2ee-release-status.json', import.meta.url),
        'utf8',
      ),
    );
    const result = verifyE2eeReleaseReadiness(current);

    expect(current.protocol).toMatchObject({
      id: 'mls10-openmls-0.8-candidate',
      serverCiphertextTransport: true,
      desktopCiphertextTransportClient: true,
      desktopTransportSessionOrchestration: true,
      transportSessionHistory: true,
      transportSessionReset: true,
      prekeyHandshake: true,
      mls10SessionProtocol: true,
      multiDeviceSessions: true,
      safetyStateReset: true,
      forwardSecrecy: true,
      postCompromiseSecurity: true,
      externalAuditCompleted: false,
      productionCapabilityAdvertised: false,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'external audit is not complete',
        'external audit report is not recorded',
        'explicit E2EE production release approval is missing',
      ]),
    );
    expect(result.blockers).toHaveLength(3);
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

  it('accepts an audited MLS 1.0 profile without requiring Double Ratchet', () => {
    const status = readyStatus();
    status.protocol.id = 'mls-1.0';
    status.protocol.implementation = 'openmls-reviewed-provider';
    status.protocol.doubleRatchet = false;
    status.protocol.mls10SessionProtocol = true;

    expect(
      verifyE2eeReleaseReadiness(status, { fileExists: () => true }),
    ).toEqual({ ready: true, blockers: [] });
  });
});
