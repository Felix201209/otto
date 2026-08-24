#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateAliyunServerArtifactPolicy,
  verifyAliyunServerArtifactIndexSignature,
} from './aliyun-server-artifact.mjs';
import {
  assertEnterpriseArtifactContainsNoSecrets,
  extractEnterpriseArchive,
  readEnterpriseArtifactMetadata,
  sha256File,
} from './aliyun-server-artifact-files.mjs';
import { verifyEnterprisePackageSignature } from './verify-enterprise-package-signature.mjs';

function parseArguments(argv) {
  const result = { positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--architecture') result.architecture = argv[++index];
    else if (value === '--minimum-release-sequence') {
      result.minimumReleaseSequence = Number(argv[++index]);
    } else if (value === '--trusted-public-key-file') {
      result.trustedPublicKeyFile = argv[++index];
    } else if (value.startsWith('--')) {
      throw new Error(`unsupported option: ${value}`);
    } else result.positional.push(value);
  }
  return result;
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

function verifyReleaseDirectory(releaseRoot) {
  const verifier = path.join(releaseRoot, '..', 'tools', 'verify-release.mjs');
  const environment = { ...process.env };
  delete environment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY;
  delete environment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE;
  const result = spawnSync(process.execPath, [verifier, releaseRoot], {
    encoding: 'utf8',
    env: environment,
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `inner enterprise release verification failed: ${result.stderr || ''}`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [indexInput, signatureInput] = options.positional;
  if (!indexInput) {
    throw new Error(
      'usage: verify-aliyun-server-artifact.mjs <index> [index-signature] [--architecture linux-x64|linux-arm64] [--minimum-release-sequence N]',
    );
  }
  const indexPath = path.resolve(indexInput);
  const indexSignaturePath = path.resolve(signatureInput || `${indexPath}.sig`);
  const trustedPublicKey = options.trustedPublicKeyFile
    ? readFileSync(path.resolve(options.trustedPublicKeyFile), 'utf8')
    : process.env.OTTO_ENTERPRISE_SIGNING_PUBLIC_KEY?.replace(/\\n/g, '\n');
  if (!trustedPublicKey)
    throw new Error('trusted artifact public key is missing');
  const document = readFileSync(indexPath);
  const index = JSON.parse(document.toString('utf8'));
  const indexSignature = JSON.parse(readFileSync(indexSignaturePath, 'utf8'));
  verifyAliyunServerArtifactIndexSignature({
    document,
    file: indexPath,
    envelope: indexSignature,
    trustedPublicKey,
  });
  validateAliyunServerArtifactPolicy(index, {
    architecture: options.architecture,
    minimumReleaseSequence: options.minimumReleaseSequence,
  });

  const archivePath = path.join(path.dirname(indexPath), index.artifact.file);
  const packageSignaturePath = path.join(
    path.dirname(indexPath),
    index.artifact.packageSignature.file,
  );
  if (statSync(archivePath).size !== index.artifact.size) {
    throw new Error('enterprise archive size does not match artifact index');
  }
  if ((await sha256File(archivePath)) !== index.artifact.sha256) {
    throw new Error('enterprise archive SHA-256 does not match artifact index');
  }
  if (
    (await sha256File(packageSignaturePath)) !==
    index.artifact.packageSignature.fileSha256
  ) {
    throw new Error(
      'package signature file SHA-256 does not match artifact index',
    );
  }
  const packageVerification = await verifyEnterprisePackageSignature({
    archivePath,
    signaturePath: packageSignaturePath,
    trustedPublicKey,
  });
  if (packageVerification.keyId !== index.artifact.packageSignature.keyId) {
    throw new Error('package signature key does not match artifact index');
  }

  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'otto-cloud-verify-'),
  );
  try {
    const packageRoot = extractEnterpriseArchive(archivePath, temporaryRoot);
    assertEnterpriseArtifactContainsNoSecrets(packageRoot);
    verifyReleaseDirectory(path.join(packageRoot, 'release'));
    const { manifest, buildInfo } = readEnterpriseArtifactMetadata(packageRoot);
    assertEqual(
      index.release,
      {
        version: manifest.version,
        channel: manifest.releaseChannel,
        sourceCommit: manifest.sourceCommit,
        sourceTreeDirty: manifest.sourceTreeDirty,
        sourceInputSha256: manifest.sourceInputSha256,
        sourceDiffSha256: manifest.sourceDiffSha256,
        buildCommit: manifest.buildCommit,
      },
      'release identity does not match artifact index',
    );
    assertEqual(
      index.runtime,
      manifest.runtime,
      'runtime contract does not match artifact index',
    );
    assertEqual(
      index.database,
      manifest.database,
      'database contract does not match artifact index',
    );
    assertEqual(
      index.supplyChain,
      manifest.supplyChain,
      'supply-chain digests do not match artifact index',
    );
    if (
      buildInfo.version !== index.release.version ||
      buildInfo.buildCommit !== index.release.buildCommit ||
      buildInfo.sourceCommit !== index.release.sourceCommit
    ) {
      throw new Error('BUILD-INFO.json does not match artifact index');
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: index.release.version,
      releaseSequence: index.releaseSequence,
      archiveSha256: index.artifact.sha256,
      architecture: options.architecture || null,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[aliyun-artifact-verification] ${error.message}\n`);
  process.exitCode = 3;
});
