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

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

export function verifySqlCipherNativeTarget(rootDirectory, target) {
  const match = /^(win32|darwin|linux)-(x64|arm64)$/.exec(target);
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
    ['format', 2],
    ['target', target],
    ['platform', platform],
    ['arch', arch],
    ['runtime', 'electron'],
    ['cipherSelfTest', true],
    ['plainSqliteRejected', true],
    ['license', 'BSD-3-Clause'],
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
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`SQLCipher ${target} manifest ${field} is missing`);
    }
  }
  const actualSha256 = sha256(bindingPath);
  if (manifest.sha256 !== actualSha256) {
    throw new Error(
      `SQLCipher ${target} binding checksum does not match its manifest`,
    );
  }
  if (
    !manifest.sbom ||
    manifest.sbom.format !== 'CycloneDX' ||
    manifest.sbom.path !== 'sbom.cdx.json' ||
    typeof manifest.sbom.sha256 !== 'string'
  ) {
    throw new Error(`SQLCipher ${target} manifest SBOM metadata is invalid`);
  }
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
  assertNativeMagic(bindingPath, platform);
  return { ...manifest, bindingPath, manifestPath, sbomPath };
}

export function verifySqlCipherNativeAssets(rootDirectory, targets) {
  return targets.map((target) =>
    verifySqlCipherNativeTarget(rootDirectory, target),
  );
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
  const verified = verifySqlCipherNativeAssets(rootDirectory, targets);
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
