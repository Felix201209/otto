/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256File } from '../e2ee-release-evidence.mjs';
import {
  verifyE2eeCandidateSafety,
  verifyE2eeReleaseReadiness,
} from '../verify-e2ee-release-readiness.mjs';

const roots = [];
const NOW = Date.parse('2026-08-11T08:00:00.000Z');
const PROFILE = { algorithm: 'test', digest: 'a'.repeat(64), files: [] };
const SCENARIOS = [
  'directory-rollback-and-fork',
  'directory-key-substitution',
  'ciphertext-and-attachment-tampering',
  'revoked-device-exclusion',
  'transport-acknowledgement-substitution',
  'epoch-skip-and-commit-tampering',
  'cross-tenant-device-injection',
  'replay-and-idempotency',
  'plaintext-downgrade-refusal',
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function status(overrides = {}) {
  return {
    format: 2,
    protocol: {
      id: 'mls10-openmls-0.8-candidate',
      implementation: 'openmls-0.8.1',
      candidateOnly: false,
      productionCapabilityAdvertised: true,
      serverCiphertextTransport: true,
      desktopCiphertextTransportClient: true,
      desktopTransportSessionOrchestration: true,
      externalAuditCompleted: true,
      prekeyHandshake: true,
      doubleRatchet: false,
      mls10SessionProtocol: true,
      multiDeviceSessions: true,
      mlsAttachmentProfile: 'mls-attachment-v1-candidate',
      mlsAttachmentExternalAuditCompleted: true,
      safetyStateReset: true,
      forwardSecrecy: true,
      postCompromiseSecurity: true,
    },
    deviceTrust: {
      safetyNumbers: true,
      qrVerification: true,
      outOfBandDeviceApproval: true,
      keyTransparency: true,
      localCheckpointPinning: true,
      externalWitness: false,
    },
    assurance: {
      requiredMaliciousServerScenarios: SCENARIOS,
      adversarialReportPath: 'artifacts/adversarial.json',
      trustStorePath: 'security/trust.json',
      auditAttestationPath: 'security/audit.json',
      releaseApprovalPath: 'security/approval.json',
      generatedPolicyPath: 'policy.ts',
    },
    releaseApproved: true,
    prohibitedClaims: [
      'Signal-grade security',
      'protection from a malicious device-directory server without verification',
    ],
    ...overrides,
  };
}

function key(role, keyId) {
  const pair = generateKeyPairSync('ed25519');
  return {
    role,
    keyId,
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function signedEnvelope(type, statement, signer) {
  return {
    format: 1,
    type,
    statement,
    signatures: [
      {
        algorithm: 'Ed25519',
        keyId: signer.keyId,
        role: signer.role,
        signature: sign(
          null,
          Buffer.from(canonicalJson(statement), 'utf8'),
          signer.privateKey,
        ).toString('base64'),
      },
    ],
  };
}

function writeJson(root, relativePath, value) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return absolute;
}

function productionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-e2ee-gate-'));
  roots.push(root);
  const auditor = key('external-auditor', 'auditor-1');
  const security = key('security-approver', 'security-1');
  const release = key('release-approver', 'release-1');
  writeJson(root, 'artifacts/adversarial.json', {
    format: 1,
    type: 'otto-e2ee-adversarial-verification',
    protocolId: 'mls10-openmls-0.8-candidate',
    sourceCommit: 'b'.repeat(40),
    sourceDirty: false,
    securityProfileDigest: PROFILE.digest,
    generatedAt: '2026-08-11T07:30:00.000Z',
    passed: true,
    scenarios: SCENARIOS.map((id) => ({ id, status: 'passed' })),
  });
  const reportPath = 'security/audits/external-audit-report.txt';
  const reportAbsolutePath = path.join(root, reportPath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(reportAbsolutePath, 'Independent audit fixture\n', 'utf8');
  const auditStatement = {
    protocolId: 'mls10-openmls-0.8-candidate',
    implementation: 'openmls-0.8.1',
    securityProfileDigest: PROFILE.digest,
    threatModel: 'server-hostile',
    maliciousServerAssessmentCompleted: true,
    reportPath,
    reportSha256: sha256File(reportAbsolutePath),
    issuedAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2027-08-10T00:00:00.000Z',
    findings: { critical: 0, high: 0, medium: 2, low: 4 },
  };
  const auditPath = writeJson(
    root,
    'security/audit.json',
    signedEnvelope('otto-e2ee-external-audit', auditStatement, auditor),
  );
  const approvalStatement = {
    decision: 'approve-production-e2ee',
    protocolId: 'mls10-openmls-0.8-candidate',
    implementation: 'openmls-0.8.1',
    securityProfileDigest: PROFILE.digest,
    auditAttestationSha256: sha256File(auditPath),
    notBefore: '2026-08-11T00:00:00.000Z',
    expiresAt: '2026-11-11T00:00:00.000Z',
  };
  const approval = signedEnvelope(
    'otto-e2ee-production-approval',
    approvalStatement,
    security,
  );
  approval.signatures.push(
    signedEnvelope('otto-e2ee-production-approval', approvalStatement, release)
      .signatures[0],
  );
  writeJson(root, 'security/approval.json', approval);
  writeJson(root, 'security/trust.json', {
    format: 1,
    keys: [auditor, security, release].map((item) => ({
      keyId: item.keyId,
      role: item.role,
      publicKeyPem: item.publicKeyPem,
      activeFrom: '2026-01-01T00:00:00.000Z',
      activeUntil: null,
      revokedAt: null,
    })),
  });
  return { root, status: status(), auditStatement, approvalStatement };
}

describe('E2EE production release readiness gate', () => {
  it('allows ordinary Otto releases only while the checked-in candidate remains disabled', () => {
    const current = JSON.parse(
      fs.readFileSync(
        new URL('../../security/e2ee-release-status.json', import.meta.url),
        'utf8',
      ),
    );
    expect(verifyE2eeCandidateSafety(current)).toEqual({
      ready: true,
      blockers: [],
    });
    const production = verifyE2eeReleaseReadiness(current, {
      securityProfile: PROFILE,
      skipGeneratedPolicy: true,
      nowMs: NOW,
      sourceCommit: 'b'.repeat(40),
    });
    expect(production.ready).toBe(false);
    expect(production.blockers).toEqual(
      expect.arrayContaining([
        'external audit is not complete',
        'production MLS capability is not approved for advertisement',
        'explicit E2EE production release approval is missing',
        'independent E2EE audit attestation is not recorded',
      ]),
    );
  });

  it('requires a fresh clean-worktree report covering every malicious-server scenario', () => {
    const fixture = productionFixture();
    const reportPath = path.join(fixture.root, 'artifacts/adversarial.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    report.sourceDirty = true;
    report.scenarios.pop();
    writeJson(fixture.root, 'artifacts/adversarial.json', report);

    const result = verifyE2eeReleaseReadiness(fixture.status, {
      rootDirectory: fixture.root,
      securityProfile: PROFILE,
      skipGeneratedPolicy: true,
      nowMs: NOW,
      sourceCommit: 'b'.repeat(40),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'malicious-server verification report is stale or mismatched',
    );
  });

  it('rejects a forged external audit or an approval without both independent roles', () => {
    const fixture = productionFixture();
    const auditPath = path.join(fixture.root, 'security/audit.json');
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    audit.statement.reportSha256 = 'd'.repeat(64);
    writeJson(fixture.root, 'security/audit.json', audit);
    const approvalPath = path.join(fixture.root, 'security/approval.json');
    const approval = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    approval.signatures = approval.signatures.filter(
      (signature) => signature.role !== 'release-approver',
    );
    writeJson(fixture.root, 'security/approval.json', approval);

    const result = verifyE2eeReleaseReadiness(fixture.status, {
      rootDirectory: fixture.root,
      securityProfile: PROFILE,
      skipGeneratedPolicy: true,
      nowMs: NOW,
      sourceCommit: 'b'.repeat(40),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'otto-e2ee-external-audit signature is invalid',
        'otto-e2ee-production-approval is missing a valid release-approver signature',
      ]),
    );
  });

  it('rejects an audit when its signed report digest no longer matches the report file', () => {
    const fixture = productionFixture();
    fs.writeFileSync(
      path.join(fixture.root, fixture.auditStatement.reportPath),
      'Modified after audit\n',
      'utf8',
    );

    const result = verifyE2eeReleaseReadiness(fixture.status, {
      rootDirectory: fixture.root,
      securityProfile: PROFILE,
      skipGeneratedPolicy: true,
      nowMs: NOW,
      sourceCommit: 'b'.repeat(40),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'independent E2EE audit statement is incomplete or out of scope',
    );
  });

  it('rejects expired approvals and security-profile drift after audit', () => {
    const fixture = productionFixture();
    const result = verifyE2eeReleaseReadiness(fixture.status, {
      rootDirectory: fixture.root,
      securityProfile: { ...PROFILE, digest: 'f'.repeat(64) },
      skipGeneratedPolicy: true,
      nowMs: Date.parse('2028-01-01T00:00:00.000Z'),
      sourceCommit: 'b'.repeat(40),
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'malicious-server verification report is stale or mismatched',
        'independent E2EE audit statement is incomplete or out of scope',
        'E2EE production approval is incomplete, expired, or out of scope',
      ]),
    );
  });

  it('accepts only fresh attack evidence, an independent audit, and two-role approval for the same source profile', () => {
    const fixture = productionFixture();
    expect(
      verifyE2eeReleaseReadiness(fixture.status, {
        rootDirectory: fixture.root,
        securityProfile: PROFILE,
        skipGeneratedPolicy: true,
        nowMs: NOW,
        sourceCommit: 'b'.repeat(40),
      }),
    ).toMatchObject({ ready: true, blockers: [] });
  });
});
