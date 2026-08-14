#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeE2eeSecurityProfile,
  currentGitCommit,
  readJsonFile,
  resolveRepositoryPath,
} from './e2ee-release-evidence.mjs';

const SCENARIOS = [
  {
    id: 'directory-rollback-and-fork',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-e2ee.test.ts',
        'pins transparency heads and rejects a server rollback or fork',
      ],
    ],
  },
  {
    id: 'directory-key-substitution',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-e2ee.test.ts',
        'rejects malformed transparency entries and inconsistent device directories',
      ],
    ],
  },
  {
    id: 'ciphertext-and-attachment-tampering',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-e2ee.test.ts',
        'encrypts for sender and recipient devices and detects message tampering',
      ],
      [
        'packages/desktop/src/main/enterprise-mls-attachments.test.ts',
        'fails closed on object tampering or a cross-generation binding',
      ],
      [
        'otto-native/src/mls.rs',
        'remote_commit_tampering_quarantines_without_advancing_cursor',
      ],
    ],
  },
  {
    id: 'revoked-device-exclusion',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-e2ee.test.ts',
        'covers every active device and stops targeting a revoked device',
      ],
      [
        'packages/server/src/modules/collaboration/mlsTransportRepository.test.ts',
        'rejects revoked senders and cross-tenant participants',
      ],
    ],
  },
  {
    id: 'transport-acknowledgement-substitution',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-mls.test.ts',
        'does not acknowledge a transport response with different security bindings',
      ],
    ],
  },
  {
    id: 'epoch-skip-and-commit-tampering',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-mls.test.ts',
        'fails closed when a remote Commit skips an epoch',
      ],
      [
        'otto-native/src/mls.rs',
        'remote_commit_tampering_quarantines_without_advancing_cursor',
      ],
    ],
  },
  {
    id: 'cross-tenant-device-injection',
    evidence: [
      [
        'packages/server/src/modules/collaboration/mlsTransportRepository.test.ts',
        'rejects revoked senders and cross-tenant participants',
      ],
      [
        'otto-native/src/mls.rs',
        'member_key_packages_cannot_cross_server_or_organization_boundaries',
      ],
    ],
  },
  {
    id: 'replay-and-idempotency',
    evidence: [
      [
        'packages/server/src/modules/collaboration/mlsTransportRepository.test.ts',
        'enforces epoch ordering and idempotent event identifiers',
      ],
      [
        'packages/desktop/src/main/enterprise-mls.test.ts',
        'replays the durable application outbox before encrypting a new message',
      ],
    ],
  },
  {
    id: 'plaintext-downgrade-refusal',
    evidence: [
      [
        'packages/desktop/src/main/enterprise-client.test.ts',
        'fails closed instead of downgrading when the server advertises MLS private chat',
      ],
    ],
  },
];

function npmCommand(args) {
  if (process.env.npm_execpath) {
    return [process.execPath, [process.env.npm_execpath, ...args]];
  }
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];
}

function verifyScenarioSources(rootDirectory) {
  for (const scenario of SCENARIOS) {
    for (const [relativePath, selector] of scenario.evidence) {
      const source = fs.readFileSync(
        resolveRepositoryPath(rootDirectory, relativePath),
        'utf8',
      );
      if (!source.includes(selector)) {
        throw new Error(
          `E2EE adversarial scenario ${scenario.id} lost evidence selector ${selector}`,
        );
      }
    }
  }
}

function runCommand(rootDirectory, executable, args) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd: rootDirectory,
    stdio: 'inherit',
    shell: false,
  });
  return {
    executable,
    args,
    startedAt,
    durationMs: Date.now() - started,
    exitCode: result.status ?? 1,
    error: result.error?.message ?? null,
  };
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
  verifyScenarioSources(rootDirectory);
  const expected = new Set(status.assurance.requiredMaliciousServerScenarios);
  const actual = new Set(SCENARIOS.map((scenario) => scenario.id));
  if (
    expected.size !== actual.size ||
    [...expected].some((scenario) => !actual.has(scenario))
  ) {
    throw new Error(
      'E2EE adversarial scenario runner disagrees with release status',
    );
  }
  const commands = [
    npmCommand([
      '--workspace',
      'otto-desktop',
      'run',
      'test',
      '--',
      'src/main/enterprise-e2ee.test.ts',
      'src/main/enterprise-client.test.ts',
      'src/main/enterprise-mls.test.ts',
      'src/main/enterprise-mls-attachments.test.ts',
    ]),
    npmCommand([
      '--workspace',
      'otto-server',
      'run',
      'test',
      '--',
      'src/modules/collaboration/mlsTransportRepository.test.ts',
    ]),
    [
      'cargo',
      ['test', '--manifest-path', 'otto-native/Cargo.toml', 'mls::tests'],
    ],
  ];
  const securityProfile = computeE2eeSecurityProfile(rootDirectory);
  const results = [];
  for (const [executable, args] of commands) {
    const result = runCommand(rootDirectory, executable, args);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  const passed =
    results.length === commands.length &&
    results.every((item) => item.exitCode === 0);
  const sourceDirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDirectory,
      encoding: 'utf8',
    }).trim(),
  );
  const report = {
    format: 1,
    type: 'otto-e2ee-adversarial-verification',
    protocolId: status.protocol.id,
    implementation: status.protocol.implementation,
    sourceCommit: currentGitCommit(rootDirectory),
    sourceDirty,
    securityProfileDigest: securityProfile.digest,
    generatedAt: new Date().toISOString(),
    passed,
    scenarios: SCENARIOS.map((scenario) => ({
      id: scenario.id,
      status: passed ? 'passed' : 'failed',
      evidence: scenario.evidence.map(([file, selector]) => ({
        file,
        selector,
      })),
    })),
    commands: results,
  };
  const outputPath = resolveRepositoryPath(
    rootDirectory,
    argumentValue('--output') ?? status.assurance.adversarialReportPath,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[e2ee-adversarial] report: ${outputPath}\n`);
  if (!passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
