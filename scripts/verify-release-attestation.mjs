#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_HUMAN_CHECKS = new Set([
  'desktop-smoke',
  'enterprise-canary',
  'rollback-readiness',
  'security-release-review',
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`Release attestation rejected: ${message}`);
  process.exitCode = 1;
}

const file = argument('--file');
const version = argument('--version');
const commit = argument('--commit');
if (!file || !version || !commit) {
  fail('usage: verify-release-attestation.mjs --file <path> --version <version> --commit <sha>');
} else if (!/^[0-9a-f]{40}$/i.test(commit)) {
  fail('commit must be an exact 40-character SHA');
} else {
  let attestation;
  try {
    attestation = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    fail(`cannot read valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (attestation) {
    if (attestation.schemaVersion !== 1) fail('schemaVersion must be 1');
    if (attestation.version !== version) fail(`version must equal ${version}`);
    if (attestation.sourceCommit !== commit) fail('sourceCommit must equal the release commit');
    if (typeof attestation.preparedBy !== 'string' || !attestation.preparedBy.trim()) fail('preparedBy is required');
    if (Number.isNaN(Date.parse(attestation.preparedAt ?? ''))) fail('preparedAt must be an ISO-8601 timestamp');
    if (typeof attestation.riskAssessment?.summary !== 'string' || !attestation.riskAssessment.summary.trim()) fail('riskAssessment.summary is required');
    if (!Array.isArray(attestation.riskAssessment?.highRiskChanges)) fail('riskAssessment.highRiskChanges must be an array');
    if (!/^https:\/\//.test(attestation.automatedEvidence?.ciRunUrl ?? '')) fail('automatedEvidence.ciRunUrl must be HTTPS');
    if (typeof attestation.automatedEvidence?.artifactVerification !== 'string' || !attestation.automatedEvidence.artifactVerification.trim()) fail('automatedEvidence.artifactVerification is required');

    const checks = new Map((attestation.humanChecks ?? []).map((check) => [check?.id, check]));
    for (const id of REQUIRED_HUMAN_CHECKS) {
      const check = checks.get(id);
      if (!check || check.status !== 'passed' || typeof check.evidence !== 'string' || !check.evidence.trim()) {
        fail(`${id} must be passed with evidence`);
      }
    }
  }
}

if (!process.exitCode) console.log('Release attestation verified.');
