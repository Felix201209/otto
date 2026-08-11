#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeE2eeSecurityProfile,
  currentGitCommit,
  readJsonFile,
  resolveRepositoryPath,
  sha256File,
} from './e2ee-release-evidence.mjs';

function argumentValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function openMlsVersions(rootDirectory) {
  const cargoLock = fs.readFileSync(
    resolveRepositoryPath(rootDirectory, 'otto-native/Cargo.lock'),
    'utf8',
  );
  const versions = {};
  for (const packageName of [
    'openmls',
    'openmls_basic_credential',
    'openmls_rust_crypto',
    'openmls_traits',
  ]) {
    const expression = new RegExp(
      `\\[\\[package\\]\\]\\s+name = "${packageName}"\\s+version = "([^"]+)"`,
      'u',
    );
    const match = expression.exec(cargoLock);
    if (!match)
      throw new Error(`cannot resolve ${packageName} from Cargo.lock`);
    versions[packageName] = match[1];
  }
  return versions;
}

function main() {
  const rootDirectory = path.resolve(argumentValue('--root') ?? process.cwd());
  const status = readJsonFile(
    rootDirectory,
    argumentValue('--status') ?? 'security/e2ee-release-status.json',
  );
  const sourceDirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDirectory,
      encoding: 'utf8',
    }).trim(),
  );
  if (sourceDirty && !process.argv.includes('--allow-dirty')) {
    throw new Error('E2EE audit bundle requires a clean committed worktree');
  }
  const securityProfile = computeE2eeSecurityProfile(rootDirectory);
  const threatModelPath = status.assurance.threatModelPath;
  const adversarialPath = status.assurance.adversarialReportPath;
  const adversarialAbsolutePath = resolveRepositoryPath(
    rootDirectory,
    adversarialPath,
  );
  const bundle = {
    format: 1,
    type: 'otto-e2ee-audit-bundle',
    protocolId: status.protocol.id,
    implementation: status.protocol.implementation,
    sourceCommit: currentGitCommit(rootDirectory),
    sourceDirty,
    generatedAt: new Date().toISOString(),
    securityProfile,
    dependencies: openMlsVersions(rootDirectory),
    threatModel: {
      path: threatModelPath,
      sha256: sha256File(resolveRepositoryPath(rootDirectory, threatModelPath)),
    },
    adversarialVerification: fs.existsSync(adversarialAbsolutePath)
      ? { path: adversarialPath, sha256: sha256File(adversarialAbsolutePath) }
      : null,
    auditorInstructions: {
      requiredThreatModel: 'server-hostile',
      requiredFindingsForRelease: { critical: 0, high: 0 },
      attestationType: 'otto-e2ee-external-audit',
      signatureAlgorithm: 'Ed25519',
    },
  };
  const outputPath = resolveRepositoryPath(
    rootDirectory,
    argumentValue('--output') ?? 'artifacts/security/e2ee-audit-bundle.json',
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  process.stdout.write(`[e2ee-audit] bundle manifest: ${outputPath}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
