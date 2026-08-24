#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAliyunServerArtifactIndex,
  serializeAliyunServerArtifactIndex,
  sha256,
  signAliyunServerArtifactIndex,
  validateAliyunServerArtifactPolicy,
  verifyAliyunServerArtifactIndexSignature,
} from './aliyun-server-artifact.mjs';
import {
  assertEnterpriseArtifactContainsNoSecrets,
  extractEnterpriseArchive,
  readEnterpriseArtifactMetadata,
  sha256File,
} from './aliyun-server-artifact-files.mjs';
import {
  loadEnterpriseSigningPrivateKey,
  signEnterprisePackage,
} from './sign-enterprise-package.mjs';
import { verifyEnterprisePackageSignature } from './verify-enterprise-package-signature.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function discoverArchive() {
  const deliverables = path.join(repoRoot, 'deliverables');
  const matches = readdirSync(deliverables)
    .filter((file) =>
      /^otto-enterprise-oneclick-v.+-[0-9a-f]{12}\.tar\.gz$/.test(file),
    )
    .map((file) => path.join(deliverables, file));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one enterprise archive, found ${matches.length}`,
    );
  }
  return matches[0];
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function publicKeyPem(publicKey) {
  return publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

function artifactIndexPath(archivePath, version, buildCommit) {
  return path.join(
    path.dirname(archivePath),
    `otto-aliyun-server-artifact-v${version}-${buildCommit.slice(0, 12)}.json`,
  );
}

function verifyReleaseDirectory(packageRoot) {
  const verifier = path.join(packageRoot, 'tools', 'verify-release.mjs');
  const releaseRoot = path.join(packageRoot, 'release');
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
  const archivePath = path.resolve(process.argv[2] || discoverArchive());
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), 'otto-cloud-artifact-'),
  );
  try {
    const packageRoot = extractEnterpriseArchive(archivePath, temporaryRoot);
    assertEnterpriseArtifactContainsNoSecrets(packageRoot);
    verifyReleaseDirectory(packageRoot);
    const { manifest, buildInfo } = readEnterpriseArtifactMetadata(packageRoot);
    const checksumPath = `${archivePath}.sha256`;
    if (!existsSync(checksumPath))
      throw new Error('enterprise package checksum is missing');
    const archiveSha256 = await sha256File(archivePath);
    const checksum = readFileSync(checksumPath, 'utf8').trim();
    if (checksum !== `${archiveSha256}  ${path.basename(archivePath)}`) {
      throw new Error('enterprise package checksum file is inconsistent');
    }
    const releaseSequence = parsePositiveInteger(
      process.env.OTTO_RELEASE_SEQUENCE,
      'OTTO_RELEASE_SEQUENCE',
    );
    const publishedAt =
      process.env.OTTO_ARTIFACT_PUBLISHED_AT || new Date().toISOString();
    const metadataExpiresAt =
      process.env.OTTO_ARTIFACT_METADATA_EXPIRES_AT ||
      new Date(
        new Date(publishedAt).valueOf() + 90 * 24 * 60 * 60 * 1000,
      ).toISOString();
    const indexPath = artifactIndexPath(
      archivePath,
      manifest.version,
      manifest.buildCommit,
    );
    const indexSignaturePath = `${indexPath}.sig`;
    if (existsSync(indexPath) || existsSync(indexSignaturePath)) {
      throw new Error(`cloud artifact index already exists: ${indexPath}`);
    }
    if (
      manifest.releaseChannel === 'stable' &&
      (manifest.sourceTreeDirty !== false ||
        buildInfo.sourceTreeDirty !== false)
    ) {
      throw new Error('stable cloud artifacts require a clean source tree');
    }
    const privateKey = await loadEnterpriseSigningPrivateKey();
    const packageSigning = await signEnterprisePackage({
      archivePath,
      privateKey,
    });
    const trustedPublicKey = publicKeyPem(packageSigning.publicKey);
    await verifyEnterprisePackageSignature({
      archivePath,
      signaturePath: packageSigning.signaturePath,
      trustedPublicKey,
    });
    const index = createAliyunServerArtifactIndex({
      manifest,
      buildInfo,
      releaseSequence,
      publishedAt,
      metadataExpiresAt,
      archive: {
        file: path.basename(archivePath),
        size: statSync(archivePath).size,
        sha256: archiveSha256,
      },
      packageSignature: packageSigning.envelope,
      packageSignatureFileSha256: sha256(
        readFileSync(packageSigning.signaturePath),
      ),
    });
    const document = serializeAliyunServerArtifactIndex(index);
    const indexSigning = signAliyunServerArtifactIndex({
      document,
      file: indexPath,
      privateKey,
    });
    writeFileSync(indexPath, document, { mode: 0o644 });
    writeFileSync(
      indexSignaturePath,
      `${JSON.stringify(indexSigning.envelope, null, 2)}\n`,
      { mode: 0o644 },
    );
    verifyAliyunServerArtifactIndexSignature({
      document,
      file: indexPath,
      envelope: indexSigning.envelope,
      trustedPublicKey,
    });
    validateAliyunServerArtifactPolicy(index, {
      minimumReleaseSequence: releaseSequence,
      now: publishedAt,
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        archivePath,
        packageSignaturePath: packageSigning.signaturePath,
        indexPath,
        indexSignaturePath,
        releaseSequence,
        version: manifest.version,
        sourceCommit: manifest.sourceCommit,
      })}\n`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[aliyun-artifact-signing] ${error.message}\n`);
  process.exitCode = 3;
});
