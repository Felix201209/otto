#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeE2eeSecurityProfile,
  currentGitCommit,
  fileDigestEnvelope,
  readJsonFile,
  resolveRepositoryFile,
  resolveRepositoryPath,
  sha256File,
  verifySignedStatement,
} from './e2ee-release-evidence.mjs';

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
  ['prekeyHandshake', 'prekey handshake is not implemented'],
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
  [
    'localCheckpointPinning',
    'local transparency checkpoint pinning is not implemented',
  ],
];

const REQUIRED_PROHIBITED_CLAIMS = [
  'Signal-grade security',
  'protection from a malicious device-directory server without verification',
];

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validFindingCounts(findings) {
  return ['critical', 'high', 'medium', 'low'].every(
    (severity) =>
      Number.isSafeInteger(findings?.[severity]) && findings[severity] >= 0,
  );
}

function baseStatusBlockers(status) {
  const blockers = [];
  if (!status || typeof status !== 'object' || status.format !== 2) {
    return ['E2EE release status format is invalid'];
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
    if (
      status.protocol.doubleRatchet !== true &&
      status.protocol.mls10SessionProtocol !== true
    ) {
      blockers.push(
        'Double Ratchet or an audited MLS 1.0 session protocol is not implemented',
      );
    }
  }
  if (!status.deviceTrust || typeof status.deviceTrust !== 'object') {
    blockers.push('E2EE device trust status is missing');
  } else {
    for (const [field, message] of REQUIRED_DEVICE_CONTROLS) {
      if (status.deviceTrust[field] !== true) blockers.push(message);
    }
  }
  if (
    !status.assurance ||
    typeof status.assurance !== 'object' ||
    !Array.isArray(status.assurance.requiredMaliciousServerScenarios) ||
    status.assurance.requiredMaliciousServerScenarios.length < 8 ||
    new Set(status.assurance.requiredMaliciousServerScenarios).size !==
      status.assurance.requiredMaliciousServerScenarios.length
  ) {
    blockers.push(
      'malicious-server verification scenario inventory is incomplete',
    );
  }
  return blockers;
}

function generatedPolicyBlockers(status, options) {
  const blockers = [];
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const policyPath =
    status.assurance?.generatedPolicyPath ??
    'packages/server/src/enterprise/e2eeProductionReleasePolicy.ts';
  let source;
  try {
    source = fs.readFileSync(
      resolveRepositoryPath(rootDirectory, policyPath),
      'utf8',
    );
  } catch {
    return ['generated E2EE server release policy is missing'];
  }
  const enabled = /enabled:\s*true\b/u.test(source);
  if (enabled !== (status.protocol?.productionCapabilityAdvertised === true)) {
    blockers.push(
      'generated server capability policy disagrees with release status',
    );
  }
  const escapedProtocol = JSON.stringify(status.protocol?.id ?? '');
  if (!source.includes(`protocolId: ${escapedProtocol}`)) {
    blockers.push(
      'generated server capability policy has the wrong protocol identity',
    );
  }
  if (enabled) {
    try {
      const approvalDigest = fileDigestEnvelope(
        rootDirectory,
        status.assurance.releaseApprovalPath,
      ).sha256;
      if (
        !source.includes(`approvalDigest: ${JSON.stringify(approvalDigest)}`)
      ) {
        blockers.push(
          'generated server capability policy has the wrong approval digest',
        );
      }
    } catch {
      blockers.push(
        'generated server capability policy approval is unavailable',
      );
    }
  } else if (!/approvalDigest:\s*null\b/u.test(source)) {
    blockers.push(
      'disabled server capability policy must not carry an approval digest',
    );
  }
  return blockers;
}

export function verifyE2eeCandidateSafety(status, options = {}) {
  const blockers = baseStatusBlockers(status);
  if (status?.protocol?.productionCapabilityAdvertised !== false) {
    blockers.push('candidate build must not advertise production MLS E2EE');
  }
  if (status?.releaseApproved !== false) {
    blockers.push('candidate build must not claim production release approval');
  }
  if (status?.protocol?.candidateOnly !== true) {
    blockers.push('candidate protocol must remain explicitly candidate-only');
  }
  for (const claim of REQUIRED_PROHIBITED_CLAIMS) {
    if (!status?.prohibitedClaims?.includes(claim)) {
      blockers.push(`candidate status must prohibit claim: ${claim}`);
    }
  }
  if (!options.skipGeneratedPolicy) {
    blockers.push(...generatedPolicyBlockers(status, options));
  }
  return { ready: blockers.length === 0, blockers };
}

function adversarialReportBlockers(status, options, securityProfile, nowMs) {
  const blockers = [];
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const reportPath =
    options.adversarialReportPath ?? status.assurance?.adversarialReportPath;
  if (!reportPath)
    return ['malicious-server verification report is not configured'];
  let report;
  try {
    report = readJsonFile(rootDirectory, reportPath);
  } catch {
    return [`malicious-server verification report is missing: ${reportPath}`];
  }
  let expectedSourceCommit;
  try {
    expectedSourceCommit =
      options.sourceCommit ?? currentGitCommit(rootDirectory);
  } catch {
    return ['current source commit cannot be resolved for attack evidence'];
  }
  if (
    report.format !== 1 ||
    report.type !== 'otto-e2ee-adversarial-verification' ||
    report.passed !== true ||
    report.sourceDirty !== false ||
    report.protocolId !== status.protocol.id ||
    report.securityProfileDigest !== securityProfile.digest ||
    report.sourceCommit !== expectedSourceCommit ||
    !validTime(report.generatedAt) ||
    nowMs - Date.parse(report.generatedAt) > 24 * 60 * 60 * 1000 ||
    Date.parse(report.generatedAt) > nowMs + 5 * 60 * 1000
  ) {
    blockers.push(
      'malicious-server verification report is stale or mismatched',
    );
    return blockers;
  }
  const passedScenarios = new Set(
    Array.isArray(report.scenarios)
      ? report.scenarios
          .filter((scenario) => scenario?.status === 'passed')
          .map((scenario) => scenario.id)
      : [],
  );
  for (const scenario of status.assurance.requiredMaliciousServerScenarios) {
    if (!passedScenarios.has(scenario)) {
      blockers.push(`malicious-server scenario did not pass: ${scenario}`);
    }
  }
  return blockers;
}

function externalAuditBlockers(status, options, securityProfile, nowMs) {
  const blockers = [];
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const pathValue = status.assurance?.auditAttestationPath;
  if (!pathValue) return ['independent E2EE audit attestation is not recorded'];
  let digestEnvelope;
  let trustStore;
  try {
    digestEnvelope = fileDigestEnvelope(rootDirectory, pathValue);
    trustStore = readJsonFile(rootDirectory, status.assurance.trustStorePath);
  } catch {
    return ['independent E2EE audit evidence or trust store is missing'];
  }
  const attestation = digestEnvelope.value;
  const signatureResult = verifySignedStatement({
    envelope: attestation,
    expectedType: 'otto-e2ee-external-audit',
    requiredRoles: ['external-auditor'],
    trustStore,
    nowMs,
  });
  blockers.push(...signatureResult.errors);
  const statement = attestation.statement ?? {};
  let auditReportMatches = false;
  if (
    typeof statement.reportPath === 'string' &&
    isSha256(statement.reportSha256)
  ) {
    try {
      auditReportMatches =
        sha256File(
          resolveRepositoryFile(rootDirectory, statement.reportPath),
        ) === statement.reportSha256;
    } catch {
      auditReportMatches = false;
    }
  }
  if (
    statement.protocolId !== status.protocol.id ||
    statement.implementation !== status.protocol.implementation ||
    statement.securityProfileDigest !== securityProfile.digest ||
    statement.threatModel !== 'server-hostile' ||
    statement.maliciousServerAssessmentCompleted !== true ||
    !auditReportMatches ||
    !validTime(statement.issuedAt) ||
    !validTime(statement.expiresAt) ||
    Date.parse(statement.issuedAt) > nowMs ||
    Date.parse(statement.expiresAt) <= nowMs ||
    !validFindingCounts(statement.findings) ||
    statement.findings.critical !== 0 ||
    statement.findings?.high !== 0
  ) {
    blockers.push(
      'independent E2EE audit statement is incomplete or out of scope',
    );
  }
  return { blockers, digest: digestEnvelope.sha256, trustStore };
}

function approvalBlockers(
  status,
  options,
  securityProfile,
  auditAttestationDigest,
  trustStore,
  nowMs,
) {
  const blockers = [];
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const pathValue = status.assurance?.releaseApprovalPath;
  if (!pathValue)
    return ['signed E2EE production release approval is not recorded'];
  let approval;
  try {
    approval = readJsonFile(rootDirectory, pathValue);
  } catch {
    return [`signed E2EE production release approval is missing: ${pathValue}`];
  }
  const signatureResult = verifySignedStatement({
    envelope: approval,
    expectedType: 'otto-e2ee-production-approval',
    requiredRoles: ['security-approver', 'release-approver'],
    trustStore,
    nowMs,
  });
  blockers.push(...signatureResult.errors);
  const statement = approval.statement ?? {};
  if (
    statement.decision !== 'approve-production-e2ee' ||
    statement.protocolId !== status.protocol.id ||
    statement.implementation !== status.protocol.implementation ||
    statement.securityProfileDigest !== securityProfile.digest ||
    statement.auditAttestationSha256 !== auditAttestationDigest ||
    !validTime(statement.notBefore) ||
    !validTime(statement.expiresAt) ||
    Date.parse(statement.notBefore) > nowMs ||
    Date.parse(statement.expiresAt) <= nowMs
  ) {
    blockers.push(
      'E2EE production approval is incomplete, expired, or out of scope',
    );
  }
  return blockers;
}

export function verifyE2eeReleaseReadiness(status, options = {}) {
  const blockers = baseStatusBlockers(status);
  const rootDirectory = options.rootDirectory ?? process.cwd();
  const nowMs = options.nowMs ?? Date.now();
  let securityProfile;
  try {
    securityProfile =
      options.securityProfile ?? computeE2eeSecurityProfile(rootDirectory);
  } catch (error) {
    blockers.push(
      `E2EE security profile cannot be computed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ready: false, blockers };
  }
  if (status?.protocol?.externalAuditCompleted !== true) {
    blockers.push('external audit is not complete');
  }
  if (
    status?.protocol?.mlsAttachmentProfile &&
    status.protocol.mlsAttachmentExternalAuditCompleted !== true
  ) {
    blockers.push('MLS attachment profile external audit is not complete');
  }
  if (status?.protocol?.productionCapabilityAdvertised !== true) {
    blockers.push(
      'production MLS capability is not approved for advertisement',
    );
  }
  if (status?.protocol?.candidateOnly !== false) {
    blockers.push('production protocol is still marked candidate-only');
  }
  if (status?.releaseApproved !== true) {
    blockers.push('explicit E2EE production release approval is missing');
  }
  blockers.push(
    ...adversarialReportBlockers(status, options, securityProfile, nowMs),
  );
  const audit = externalAuditBlockers(status, options, securityProfile, nowMs);
  if (Array.isArray(audit)) {
    blockers.push(...audit);
  } else {
    blockers.push(...audit.blockers);
    blockers.push(
      ...approvalBlockers(
        status,
        options,
        securityProfile,
        audit.digest,
        audit.trustStore,
        nowMs,
      ),
    );
  }
  if (!options.skipGeneratedPolicy) {
    blockers.push(...generatedPolicyBlockers(status, options));
  }
  return { ready: blockers.length === 0, blockers, securityProfile };
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
  const statusPath =
    argumentValue('--status') ?? 'security/e2ee-release-status.json';
  const status = readJsonFile(rootDirectory, statusPath);
  const requestedMode = argumentValue('--mode') ?? 'auto';
  const mode =
    requestedMode === 'auto'
      ? status.protocol?.productionCapabilityAdvertised
        ? 'production'
        : 'candidate'
      : requestedMode;
  if (!['candidate', 'production'].includes(mode)) {
    throw new Error('E2EE release mode must be candidate, production, or auto');
  }
  const options = {
    rootDirectory,
    adversarialReportPath: argumentValue('--adversarial-report'),
    sourceCommit: currentGitCommit(rootDirectory),
  };
  const result =
    mode === 'production'
      ? verifyE2eeReleaseReadiness(status, options)
      : verifyE2eeCandidateSafety(status, options);
  if (!result.ready) {
    process.stderr.write(
      `[e2ee-release] ${mode} gate blocked:\n${result.blockers
        .map((item) => `- ${item}`)
        .join('\n')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `[e2ee-release] ${mode} gate passed: ${status.protocol.id} (${status.protocol.implementation})\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
