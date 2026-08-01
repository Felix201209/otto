#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED = {
  protocol: [
    ['externalAuditCompleted', 'external audit is not complete'],
    ['openMlsProductionIntegrated', 'OpenMLS is not integrated into production messaging'],
    ['threatModelReviewed', 'E2EE threat model has not been independently reviewed'],
    ['protocolReviewed', 'E2EE protocol document has not been independently reviewed'],
    ['multiDeviceSessions', 'MLS multi-device sessions are not implemented'],
    ['forwardSecrecy', 'forward secrecy is not established'],
    ['postCompromiseSecurity', 'post-compromise security is not established'],
  ],
  deviceTrust: [
    ['deviceCertificatesV2', 'v2 device certificates are not integrated'],
    ['signedApproval', 'device approval is not cryptographically signed'],
    ['recoveryV2', 'account-bound v2 recovery is not implemented'],
    ['safetyNumbers', 'safety-number verification is not implemented'],
    ['qrVerification', 'QR verification is not implemented'],
    ['merkleTransparency', 'Merkle key transparency is not implemented'],
    ['externalWitness', 'an independent transparency witness is not configured'],
  ],
  integrations: [
    ['directMessages', 'one-to-one messages are not using the reviewed protocol'],
    ['attachments', 'attachments are not using the reviewed protocol'],
    ['localSearch', 'local decrypted-message search is not integrated'],
    ['atoaOneTimeGrant', 'A2A one-time authorization is not integrated'],
  ],
  adversarialTests: [
    ['maliciousServer', 'malicious-server tests are incomplete'],
    ['databaseTampering', 'database-tampering tests are incomplete'],
    ['deviceLoss', 'lost-device and recovery tests are incomplete'],
    ['crossServer', 'cross-server adversarial tests are incomplete'],
  ],
  releaseGate: [
    ['requiresSignedEnablement', 'signed E2EE module enablement is not enforced'],
    ['defaultDisabled', 'unaudited E2EE must remain disabled by default'],
  ],
};

export function verifyE2eeReleaseReadiness(status, options = {}) {
  const blockers = [];
  const fileExists = options.fileExists ?? fs.existsSync;
  if (!status || typeof status !== 'object' || status.format !== 2) {
    return { ready: false, blockers: ['E2EE release status format is invalid'] };
  }
  if (
    !status.protocol ||
    typeof status.protocol.id !== 'string' ||
    !status.protocol.id.trim() ||
    typeof status.protocol.implementation !== 'string' ||
    !status.protocol.implementation.trim()
  ) {
    blockers.push('E2EE protocol provider identity is missing');
  }
  for (const [section, controls] of Object.entries(REQUIRED)) {
    if (!status[section] || typeof status[section] !== 'object') {
      blockers.push(`E2EE ${section} status is missing`);
      continue;
    }
    for (const [field, message] of controls) {
      if (status[section][field] !== true) blockers.push(message);
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
