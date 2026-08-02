#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PROTOCOL_CONTROLS = [
  [
    'serverCiphertextTransport',
    'server MLS ciphertext transport is not implemented',
  ],
  [
    'desktopCiphertextTransportClient',
    'desktop MLS ciphertext transport client is not implemented',
  ],
  [
    'desktopTransportSessionOrchestration',
    'desktop MLS session orchestration is not implemented',
  ],
  ['externalAuditCompleted', 'external audit is not complete'],
  ['prekeyHandshake', 'prekey handshake is not implemented'],
  ['doubleRatchet', 'Double Ratchet is not implemented'],
  ['multiDeviceSessions', 'multi-device sessions are not implemented'],
  ['safetyStateReset', 'safety state reset is not implemented'],
  ['forwardSecrecy', 'forward secrecy is not established'],
  ['postCompromiseSecurity', 'post-compromise security is not established'],
];

const REQUIRED_DEVICE_CONTROLS = [
  ['safetyNumbers', 'safety-number verification is not implemented'],
  ['qrVerification', 'QR verification is not implemented'],
  ['outOfBandDeviceApproval', 'out-of-band device approval is not implemented'],
  ['keyTransparency', 'auditable key transparency is not implemented'],
];

export function verifyE2eeReleaseReadiness(status, options = {}) {
  const blockers = [];
  const fileExists = options.fileExists ?? fs.existsSync;
  if (!status || typeof status !== 'object' || status.format !== 1) {
    return {
      ready: false,
      blockers: ['E2EE release status format is invalid'],
    };
  }
  if (!status.protocol || typeof status.protocol !== 'object') {
    blockers.push('E2EE protocol status is missing');
  } else {
    if (
      typeof status.protocol.id !== 'string' ||
      !status.protocol.id.trim() ||
      typeof status.protocol.implementation !== 'string' ||
      !status.protocol.implementation.trim()
    ) {
      blockers.push('E2EE protocol provider identity is missing');
    }
    for (const [field, message] of REQUIRED_PROTOCOL_CONTROLS) {
      if (status.protocol[field] !== true) blockers.push(message);
    }
  }
  if (!status.deviceTrust || typeof status.deviceTrust !== 'object') {
    blockers.push('E2EE device trust status is missing');
  } else {
    for (const [field, message] of REQUIRED_DEVICE_CONTROLS) {
      if (status.deviceTrust[field] !== true) blockers.push(message);
    }
  }
  if (!Array.isArray(status.auditReports) || status.auditReports.length === 0) {
    blockers.push('external audit report is not recorded');
  } else {
    for (const report of status.auditReports) {
      if (typeof report !== 'string' || !report.trim()) {
        blockers.push('external audit report path is invalid');
      } else if (!fileExists(report)) {
        blockers.push(`external audit artifact is missing: ${report}`);
      }
    }
  }
  if (status.releaseApproved !== true) {
    blockers.push('explicit E2EE production release approval is missing');
  }
  return { ready: blockers.length === 0, blockers };
}

function main() {
  const statusPath = path.resolve(
    process.argv[2] ?? path.join('security', 'e2ee-release-status.json'),
  );
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const result = verifyE2eeReleaseReadiness(status);
  if (!result.ready) {
    process.stderr.write(
      `[e2ee-release] blocked:\n${result.blockers.map((item) => `- ${item}`).join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[e2ee-release] ready: ${status.protocol.id} (${status.protocol.implementation})\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
