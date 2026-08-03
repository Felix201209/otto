/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SQLCIPHER_TARGETS = [
  'win32-x64',
  'darwin-x64',
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
];

export const SQLCIPHER_SOURCE = 'https://github.com/sqlcipher/sqlcipher';
export const SQLCIPHER_MATRIX_MANIFEST = 'matrix-manifest.json';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const TARGET_PATTERN = /^(win32|darwin|linux)-(x64|arm64)$/;

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function requireNonEmptyString(value, description) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${description} is missing`);
  }
  return value;
}

function requireRevision(value, description) {
  if (!REVISION_PATTERN.test(value ?? '')) {
    throw new Error(`${description} must be an immutable Git commit`);
  }
  return value;
}

function requireSha256(value, description) {
  if (!SHA256_PATTERN.test(value ?? '')) {
    throw new Error(`${description} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertExpected(actual, expected, description) {
  if (expected && actual !== expected) {
    throw new Error(`${description} must be ${expected}; got ${actual}`);
  }
}

function assertNativeMagic(filePath, platform) {
  const header = fs.readFileSync(filePath).subarray(0, 4);
  if (
    platform === 'win32' &&
    header.subarray(0, 2).toString('ascii') !== 'MZ'
  ) {
    throw new Error(`${filePath} is not a Windows PE binary`);
  }
  if (
    platform === 'linux' &&
    !header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    throw new Error(`${filePath} is not a Linux ELF binary`);
  }
  if (platform === 'darwin') {
    const magic = header.toString('hex');
    if (!['cffaedfe', 'cefaedfe', 'cafebabe', 'cafebabf'].includes(magic)) {
      throw new Error(`${filePath} is not a macOS Mach-O binary`);
    }
  }
}

function sbomProperty(sbom, name) {
  return sbom.metadata?.properties?.find((entry) => entry?.name === name)
    ?.value;
}

export function verifySqlCipherNativeTarget(
  rootDirectory,
  target,
  options = {},
) {
  const match = TARGET_PATTERN.exec(target);
  if (!match) throw new Error(`unsupported SQLCipher native target: ${target}`);
  const [, platform, arch] = match;
  const targetDirectory = path.join(rootDirectory, target);
  const bindingPath = path.join(targetDirectory, 'better_sqlite3.node');
  const manifestPath = path.join(targetDirectory, 'manifest.json');
  if (!fs.existsSync(bindingPath)) {
    throw new Error(`SQLCipher native binding is missing for ${target}`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`SQLCipher native manifest is missing for ${target}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [field, expected] of [
    ['format', 3],
    ['target', target],
    ['platform', platform],
    ['arch', arch],
    ['runtime', 'electron'],
    ['cipherSelfTest', true],
    ['plainSqliteRejected', true],
    ['license', 'BSD-3-Clause'],
    ['source', SQLCIPHER_SOURCE],
  ]) {
    if (manifest[field] !== expected) {
      throw new Error(
        `SQLCipher ${target} manifest ${field} must be ${JSON.stringify(expected)}`,
      );
    }
  }
  for (const field of [
    'runtimeVersion',
    'sqlcipherVersion',
    'betterSqlite3Version',
  ]) {
    requireNonEmptyString(
      manifest[field],
      `SQLCipher ${target} manifest ${field}`,
    );
  }
  requireRevision(
    manifest.sourceRevision,
    `SQLCipher ${target} sourceRevision`,
  );
  requireRevision(manifest.buildCommit, `SQLCipher ${target} buildCommit`);
  assertExpected(
    manifest.sourceRevision,
    options.expectedSourceRevision,
    `SQLCipher ${target} sourceRevision`,
  );
  assertExpected(
    manifest.buildCommit,
    options.expectedBuildCommit,
    `SQLCipher ${target} buildCommit`,
  );
  assertExpected(
    manifest.runtimeVersion,
    options.expectedRuntimeVersion,
    `SQLCipher ${target} runtimeVersion`,
  );

  for (const field of [
    'nodeVersion',
    'electronVersion',
    'electronModuleAbi',
    'opensslVersion',
  ]) {
    requireNonEmptyString(
      manifest.toolchain?.[field],
      `SQLCipher ${target} toolchain ${field}`,
    );
  }
  if (manifest.toolchain.electronVersion !== manifest.runtimeVersion) {
    throw new Error(
      `SQLCipher ${target} toolchain Electron version does not match runtimeVersion`,
    );
  }

  const actualSha256 = sha256(bindingPath);
  requireSha256(manifest.sha256, `SQLCipher ${target} binding checksum`);
  if (manifest.sha256 !== actualSha256) {
    throw new Error(
      `SQLCipher ${target} binding checksum does not match its manifest`,
    );
  }

  if (!manifest.notices || manifest.notices.path !== 'THIRD_PARTY_NOTICES.md') {
    throw new Error(`SQLCipher ${target} notices metadata is invalid`);
  }
  requireSha256(
    manifest.notices.sha256,
    `SQLCipher ${target} notices checksum`,
  );
  const noticesPath = path.join(targetDirectory, manifest.notices.path);
  if (!fs.existsSync(noticesPath)) {
    throw new Error(`SQLCipher ${target} third-party notices are missing`);
  }
  if (sha256(noticesPath) !== manifest.notices.sha256) {
    throw new Error(
      `SQLCipher ${target} notices checksum does not match its manifest`,
    );
  }

  if (
    !manifest.sbom ||
    manifest.sbom.format !== 'CycloneDX' ||
    manifest.sbom.path !== 'sbom.cdx.json'
  ) {
    throw new Error(`SQLCipher ${target} manifest SBOM metadata is invalid`);
  }
  requireSha256(manifest.sbom.sha256, `SQLCipher ${target} SBOM checksum`);
  const sbomPath = path.join(targetDirectory, manifest.sbom.path);
  if (!fs.existsSync(sbomPath)) {
    throw new Error(`SQLCipher ${target} SBOM is missing`);
  }
  if (sha256(sbomPath) !== manifest.sbom.sha256) {
    throw new Error(
      `SQLCipher ${target} SBOM checksum does not match its manifest`,
    );
  }
  const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'));
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.5') {
    throw new Error(`SQLCipher ${target} SBOM must be CycloneDX 1.5`);
  }
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  for (const dependency of ['SQLCipher', 'better-sqlite3']) {
    if (!components.some((component) => component?.name === dependency)) {
      throw new Error(`SQLCipher ${target} SBOM is missing ${dependency}`);
    }
  }
  const sbomBindingHash = sbom.metadata?.component?.hashes?.find(
    (entry) => entry?.alg === 'SHA-256',
  )?.content;
  if (sbomBindingHash !== actualSha256) {
    throw new Error(`SQLCipher ${target} SBOM binding checksum is invalid`);
  }
  for (const [property, expected] of [
    ['otto:target', target],
    ['otto:buildCommit', manifest.buildCommit],
    ['otto:sourceRevision', manifest.sourceRevision],
    ['otto:electronVersion', manifest.runtimeVersion],
    ['otto:electronModuleAbi', manifest.toolchain.electronModuleAbi],
  ]) {
    if (sbomProperty(sbom, property) !== expected) {
      throw new Error(
        `SQLCipher ${target} SBOM property ${property} is invalid`,
      );
    }
  }
  assertNativeMagic(bindingPath, platform);
  return {
    ...manifest,
    bindingPath,
    manifestPath,
    noticesPath,
    sbomPath,
  };
}

function assertMatrixConsistency(verified) {
  if (verified.length < 2) return;
  for (const field of [
    'buildCommit',
    'sourceRevision',
    'runtimeVersion',
    'sqlcipherVersion',
    'betterSqlite3Version',
  ]) {
    const values = new Set(verified.map((entry) => entry[field]));
    if (values.size !== 1) {
      throw new Error(`SQLCipher native matrix has inconsistent ${field}`);
    }
  }
  const noticeDigests = new Set(verified.map((entry) => entry.notices.sha256));
  if (noticeDigests.size !== 1) {
    throw new Error('SQLCipher native matrix has inconsistent notices');
  }
}

export function verifySqlCipherNativeAssets(
  rootDirectory,
  targets,
  options = {},
) {
  if (new Set(targets).size !== targets.length) {
    throw new Error('SQLCipher native target list contains duplicates');
  }
  const verified = targets.map((target) =>
    verifySqlCipherNativeTarget(rootDirectory, target, options),
  );
  assertMatrixConsistency(verified);
  return verified;
}

export function createSqlCipherMatrixManifest(verified) {
  assertMatrixConsistency(verified);
  const [first] = verified;
  const actualTargets = verified.map((entry) => entry.target).sort();
  const requiredTargets = [...REQUIRED_SQLCIPHER_TARGETS].sort();
  if (
    !first ||
    JSON.stringify(actualTargets) !== JSON.stringify(requiredTargets)
  ) {
    throw new Error('SQLCipher matrix manifest requires all five targets');
  }
  return {
    format: 1,
    buildCommit: first.buildCommit,
    source: SQLCIPHER_SOURCE,
    sourceRevision: first.sourceRevision,
    runtime: 'electron',
    runtimeVersion: first.runtimeVersion,
    sqlcipherVersion: first.sqlcipherVersion,
    betterSqlite3Version: first.betterSqlite3Version,
    targets: [...REQUIRED_SQLCIPHER_TARGETS],
    noticesSha256: first.notices.sha256,
    assets: Object.fromEntries(
      verified.map((entry) => [
        entry.target,
        {
          bindingSha256: sha256(entry.bindingPath),
          manifestSha256: sha256(entry.manifestPath),
          sbomSha256: sha256(entry.sbomPath),
        },
      ]),
    ),
  };
}

export function writeSqlCipherMatrixManifest(rootDirectory, verified) {
  const manifest = createSqlCipherMatrixManifest(verified);
  const outputPath = path.join(rootDirectory, SQLCIPHER_MATRIX_MANIFEST);
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return outputPath;
}

export function verifySqlCipherMatrixManifest(rootDirectory, verified) {
  const manifestPath = path.join(rootDirectory, SQLCIPHER_MATRIX_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error('SQLCipher native matrix manifest is missing');
  }
  const actual = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = createSqlCipherMatrixManifest(verified);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('SQLCipher native matrix manifest does not match assets');
  }
  const discoveredTargets = fs
    .readdirSync(rootDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TARGET_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const requiredTargets = [...REQUIRED_SQLCIPHER_TARGETS].sort();
  if (JSON.stringify(discoveredTargets) !== JSON.stringify(requiredTargets)) {
    throw new Error('SQLCipher native asset directory set is not exact');
  }
  return { manifestPath, manifest: actual };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function main() {
  const rootDirectory = path.resolve(
    argument('--root') ?? path.join(process.cwd(), 'native', 'sqlcipher'),
  );
  const configuredTargets = process.argv.flatMap((value, index, values) =>
    value === '--target' && values[index + 1] ? [values[index + 1]] : [],
  );
  const targets =
    configuredTargets.length > 0
      ? configuredTargets
      : REQUIRED_SQLCIPHER_TARGETS;
  const verified = verifySqlCipherNativeAssets(rootDirectory, targets, {
    expectedBuildCommit: argument('--expected-build-commit'),
    expectedSourceRevision: argument('--expected-source-revision'),
    expectedRuntimeVersion: argument('--expected-runtime-version'),
  });
  if (process.argv.includes('--write-matrix-manifest')) {
    writeSqlCipherMatrixManifest(rootDirectory, verified);
  }
  if (process.argv.includes('--require-matrix-manifest')) {
    verifySqlCipherMatrixManifest(rootDirectory, verified);
  }
  process.stdout.write(
    `[sqlcipher-assets] verified ${verified.map((entry) => entry.target).join(', ')}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
