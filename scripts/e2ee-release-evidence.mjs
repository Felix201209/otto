#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const E2EE_PRODUCTION_CAPABILITY = 'e2ee_mls_v1';

const EXPLICIT_SECURITY_FILES = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'package-lock.json',
  'package.json',
  'otto-native/Cargo.lock',
  'otto-native/Cargo.toml',
  'otto-native/src/lib.rs',
  'otto-native/src/main.rs',
  'packages/desktop/src/main/enterprise-client.ts',
  'packages/server/src/enterprise/clusteredServer.ts',
  'packages/server/src/enterprise/server.ts',
  'scripts/build-e2ee-audit-bundle.mjs',
  'scripts/e2ee-release-evidence.mjs',
  'scripts/run-e2ee-adversarial-verification.mjs',
  'scripts/verify-e2ee-release-readiness.mjs',
]);

const EXCLUDED_EVIDENCE_FILES = new Set([
  'security/e2ee-release-status.json',
  'security/e2ee-external-audit.json',
  'security/e2ee-production-approval.json',
  'packages/server/src/enterprise/e2eeProductionReleasePolicy.ts',
]);

function normalizePath(value) {
  return value.replaceAll('\\', '/');
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    stableCompare(left, right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

export function resolveRepositoryPath(rootDirectory, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('E2EE evidence path must be repository-relative');
  }
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('E2EE evidence path escapes the repository');
  }
  return resolved;
}

export function resolveRepositoryFile(rootDirectory, relativePath) {
  const root = fs.realpathSync(path.resolve(rootDirectory));
  const resolved = resolveRepositoryPath(root, relativePath);
  const realPath = fs.realpathSync(resolved);
  if (realPath !== root && !realPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('E2EE evidence file escapes the repository through a link');
  }
  if (!fs.statSync(realPath).isFile()) {
    throw new Error('E2EE evidence path is not a regular file');
  }
  return realPath;
}

export function readJsonFile(rootDirectory, relativePath) {
  return JSON.parse(
    fs.readFileSync(resolveRepositoryFile(rootDirectory, relativePath), 'utf8'),
  );
}

export function discoverE2eeSecurityFiles(trackedFiles) {
  return trackedFiles
    .map(normalizePath)
    .filter((filePath) => {
      if (EXCLUDED_EVIDENCE_FILES.has(filePath)) return false;
      if (EXPLICIT_SECURITY_FILES.has(filePath)) return true;
      const lower = filePath.toLowerCase();
      return (
        lower.includes('e2ee') ||
        lower.includes('mls') ||
        lower.startsWith('docs/security/') ||
        lower.startsWith('otto-native/src/mls')
      );
    })
    .sort(stableCompare);
}

function trackedWorkingTreeEntries(rootDirectory) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: rootDirectory,
      encoding: 'utf8',
    },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .map((filePath) => normalizePath(filePath));
}

function gitObjectId(rootDirectory, filePath) {
  return execFileSync('git', ['hash-object', `--path=${filePath}`, filePath], {
    cwd: rootDirectory,
    encoding: 'utf8',
  }).trim();
}

export function computeE2eeSecurityProfile(rootDirectory) {
  const workingTreeFiles = trackedWorkingTreeEntries(rootDirectory);
  const selected = new Set(discoverE2eeSecurityFiles(workingTreeFiles));
  const files = workingTreeFiles
    .filter((filePath) => selected.has(filePath))
    .map((filePath) => ({
      path: filePath,
      objectId: gitObjectId(rootDirectory, filePath),
    }))
    .sort((left, right) => stableCompare(left.path, right.path));
  if (files.length < 10) {
    throw new Error('E2EE audit scope is unexpectedly small');
  }
  return {
    algorithm: 'git-working-tree-sha256-v1',
    digest: sha256(
      files.map((entry) => `${entry.path}\0${entry.objectId}\n`).join(''),
    ),
    files,
  };
}

export function currentGitCommit(rootDirectory) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDirectory,
    encoding: 'utf8',
  }).trim();
}

function trustedKey(trustStore, keyId, role, nowMs) {
  const key = trustStore?.keys?.find(
    (candidate) => candidate.keyId === keyId && candidate.role === role,
  );
  if (!key || typeof key.publicKeyPem !== 'string' || key.revokedAt !== null) {
    return null;
  }
  const activeFrom = Date.parse(key.activeFrom);
  const activeUntil = key.activeUntil ? Date.parse(key.activeUntil) : Infinity;
  if (
    !Number.isFinite(activeFrom) ||
    (key.activeUntil && !Number.isFinite(activeUntil)) ||
    nowMs < activeFrom ||
    nowMs > activeUntil
  ) {
    return null;
  }
  try {
    const publicKey = createPublicKey(key.publicKeyPem);
    return publicKey.asymmetricKeyType === 'ed25519' ? publicKey : null;
  } catch {
    return null;
  }
}

export function verifySignedStatement(input) {
  const {
    envelope,
    expectedType,
    requiredRoles,
    trustStore,
    nowMs = Date.now(),
  } = input;
  const errors = [];
  if (
    !envelope ||
    envelope.format !== 1 ||
    envelope.type !== expectedType ||
    !envelope.statement ||
    typeof envelope.statement !== 'object' ||
    !Array.isArray(envelope.signatures)
  ) {
    return { valid: false, errors: [`${expectedType} envelope is invalid`] };
  }
  const message = Buffer.from(canonicalJson(envelope.statement), 'utf8');
  const verifiedRoles = new Set();
  const verifiedKeyIds = new Set();
  const verifiedPublicKeys = new Set();
  for (const signature of envelope.signatures) {
    if (
      !signature ||
      signature.algorithm !== 'Ed25519' ||
      typeof signature.keyId !== 'string' ||
      typeof signature.role !== 'string' ||
      typeof signature.signature !== 'string' ||
      verifiedKeyIds.has(signature.keyId)
    ) {
      errors.push(`${expectedType} contains an invalid or duplicate signature`);
      continue;
    }
    const key = trustedKey(trustStore, signature.keyId, signature.role, nowMs);
    if (!key) {
      errors.push(
        `${expectedType} signature key is not trusted for ${signature.role}`,
      );
      continue;
    }
    let signatureBytes;
    try {
      signatureBytes = Buffer.from(signature.signature, 'base64');
    } catch {
      signatureBytes = Buffer.alloc(0);
    }
    if (
      signatureBytes.length !== 64 ||
      !verify(null, message, key, signatureBytes)
    ) {
      errors.push(`${expectedType} signature is invalid`);
      continue;
    }
    const publicKeyFingerprint = sha256(
      key.export({ type: 'spki', format: 'der' }),
    );
    if (verifiedPublicKeys.has(publicKeyFingerprint)) {
      errors.push(
        `${expectedType} cannot reuse one public key for multiple approvals`,
      );
      continue;
    }
    verifiedKeyIds.add(signature.keyId);
    verifiedPublicKeys.add(publicKeyFingerprint);
    verifiedRoles.add(signature.role);
  }
  for (const role of requiredRoles) {
    if (!verifiedRoles.has(role)) {
      errors.push(`${expectedType} is missing a valid ${role} signature`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function fileDigestEnvelope(rootDirectory, relativePath) {
  const absolutePath = resolveRepositoryFile(rootDirectory, relativePath);
  return {
    path: normalizePath(relativePath),
    sha256: sha256File(absolutePath),
    value: JSON.parse(fs.readFileSync(absolutePath, 'utf8')),
  };
}
