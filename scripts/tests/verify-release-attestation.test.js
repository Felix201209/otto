/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const commit = '0123456789abcdef0123456789abcdef01234567';

function verify(attestation) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'otto-release-attestation-'));
  const file = path.join(directory, 'attestation.json');
  writeFileSync(file, JSON.stringify(attestation));
  try {
    return spawnSync(process.execPath, [
      'scripts/verify-release-attestation.mjs', '--file', file,
      '--version', '1.9.10', '--commit', commit,
    ], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validAttestation() {
  return {
    schemaVersion: 1, version: '1.9.10', sourceCommit: commit,
    preparedBy: 'release-owner', preparedAt: '2026-08-02T00:00:00.000Z',
    riskAssessment: { summary: 'No unresolved release risks.', highRiskChanges: [] },
    automatedEvidence: { ciRunUrl: 'https://github.com/Felix201209/otto/actions/runs/1', artifactVerification: 'Checksums verified.' },
    humanChecks: ['desktop-smoke', 'enterprise-canary', 'rollback-readiness', 'security-release-review']
      .map((id) => ({ id, status: 'passed', evidence: `${id} evidence` })),
  };
}

describe('release attestation gate', () => {
  it('accepts a complete attestation for the exact version and commit', () => {
    const result = verify(validAttestation());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release attestation verified.');
  });

  it('rejects incomplete human review evidence', () => {
    const attestation = validAttestation();
    attestation.humanChecks[1].status = 'pending';
    const result = verify(attestation);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('enterprise-canary must be passed with evidence');
  });
});
