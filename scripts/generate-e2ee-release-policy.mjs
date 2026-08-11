#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fileDigestEnvelope,
  readJsonFile,
  resolveRepositoryPath,
} from './e2ee-release-evidence.mjs';
import {
  verifyE2eeCandidateSafety,
  verifyE2eeReleaseReadiness,
} from './verify-e2ee-release-readiness.mjs';

export function renderE2eeReleasePolicy(status, approvalDigest = null) {
  const enabled = status.protocol.productionCapabilityAdvertised === true;
  return `/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Generated from security/e2ee-release-status.json. Production MLS must stay
 * disabled until the external audit and two-role signed approval pass the
 * repository release gate.
 */

export const E2EE_PRODUCTION_RELEASE_POLICY = Object.freeze({
  enabled: ${enabled},
  protocolId: ${JSON.stringify(status.protocol.id)},
  approvalDigest: ${approvalDigest ? JSON.stringify(approvalDigest) : 'null'},
});

export function e2eeProductionCapabilities(): string[] {
  return E2EE_PRODUCTION_RELEASE_POLICY.enabled ? ['e2ee_mls_v1'] : [];
}
`;
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const rootDirectory = path.resolve(argumentValue('--root') ?? process.cwd());
  const status = readJsonFile(
    rootDirectory,
    argumentValue('--status') ?? 'security/e2ee-release-status.json',
  );
  const production = status.protocol?.productionCapabilityAdvertised === true;
  const result = production
    ? verifyE2eeReleaseReadiness(status, {
        rootDirectory,
        adversarialReportPath: argumentValue('--adversarial-report'),
        skipGeneratedPolicy: true,
      })
    : verifyE2eeCandidateSafety(status, {
        rootDirectory,
        skipGeneratedPolicy: true,
      });
  if (!result.ready) {
    throw new Error(
      `cannot generate E2EE release policy:\n${result.blockers
        .map((blocker) => `- ${blocker}`)
        .join('\n')}`,
    );
  }
  const approvalDigest = production
    ? fileDigestEnvelope(rootDirectory, status.assurance.releaseApprovalPath)
        .sha256
    : null;
  const outputPath = resolveRepositoryPath(
    rootDirectory,
    status.assurance.generatedPolicyPath,
  );
  const expected = renderE2eeReleasePolicy(status, approvalDigest);
  if (process.argv.includes('--check')) {
    const actual = fs.readFileSync(outputPath, 'utf8');
    if (actual !== expected) {
      throw new Error('generated E2EE release policy is stale');
    }
    process.stdout.write('[e2ee-release] generated server policy is current\n');
    return;
  }
  fs.writeFileSync(outputPath, expected, 'utf8');
  process.stdout.write(`[e2ee-release] wrote ${outputPath}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
