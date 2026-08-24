/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`tar ${args.join(' ')} failed: ${result.stderr || ''}`);
  }
  return String(result.stdout);
}

function validateArchivePath(entry) {
  if (
    !entry ||
    entry.includes('\\') ||
    /^(?:[A-Za-z]:|\/)/.test(entry) ||
    entry.split('/').includes('..')
  ) {
    throw new Error(`unsafe archive path: ${entry}`);
  }
}

export function inspectEnterpriseArchive(archivePath) {
  const entries = runTar(['-tzf', archivePath]).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000) {
    throw new Error('enterprise archive entry count is invalid');
  }
  const unique = new Set();
  for (const entry of entries) {
    validateArchivePath(entry);
    if (unique.has(entry)) throw new Error(`duplicate archive path: ${entry}`);
    unique.add(entry);
  }
  const verbose = runTar(['-tvzf', archivePath]).split(/\r?\n/).filter(Boolean);
  if (verbose.length !== entries.length) {
    throw new Error('unable to inspect every enterprise archive entry');
  }
  for (const line of verbose) {
    const type = line.trimStart()[0];
    if (!['-', 'd'].includes(type)) {
      throw new Error(`archive link or special entry is forbidden: ${line}`);
    }
  }
  const roots = new Set(entries.map((entry) => entry.split('/')[0]));
  if (roots.size !== 1) {
    throw new Error('enterprise archive must contain exactly one package root');
  }
  return { entries, packageRootName: [...roots][0] };
}

function assertExtractedTreeSafe(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `extracted package contains a symbolic link: ${absolute}`,
        );
      }
      if (stat.isDirectory()) stack.push(absolute);
      else if (!stat.isFile()) {
        throw new Error(
          `extracted package contains a special file: ${absolute}`,
        );
      }
    }
  }
}

export function extractEnterpriseArchive(archivePath, destination) {
  const inspection = inspectEnterpriseArchive(archivePath);
  runTar(['-xzf', archivePath, '-C', destination]);
  const packageRoot = path.join(destination, inspection.packageRootName);
  assertExtractedTreeSafe(packageRoot);
  return packageRoot;
}

export function readEnterpriseArtifactMetadata(packageRoot) {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, 'release', 'manifest.json'), 'utf8'),
  );
  const buildInfo = JSON.parse(
    readFileSync(path.join(packageRoot, 'BUILD-INFO.json'), 'utf8'),
  );
  return { manifest, buildInfo };
}

export function assertEnterpriseArtifactContainsNoSecrets(packageRoot) {
  const forbiddenNames =
    /(?:^|\/)(?:\.env|id_rsa|id_ed25519|[^/]+\.pfx|[^/]+\.p12)$/i;
  const forbiddenContent = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bLTAI[0-9A-Za-z]{12,}\b/,
    /\bBearer\s+eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  ];
  const stack = [packageRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path
        .relative(packageRoot, absolute)
        .split(path.sep)
        .join('/');
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (forbiddenNames.test(relative)) {
        throw new Error(
          `forbidden secret-bearing file in artifact: ${relative}`,
        );
      }
      const stat = lstatSync(absolute);
      if (stat.size > 2 * 1024 * 1024) continue;
      const content = readFileSync(absolute);
      if (content.includes(0)) continue;
      const text = content.toString('utf8');
      if (forbiddenContent.some((pattern) => pattern.test(text))) {
        throw new Error(`probable plaintext secret in artifact: ${relative}`);
      }
    }
  }
}
