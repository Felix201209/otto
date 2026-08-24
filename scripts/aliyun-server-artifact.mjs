/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import path from 'node:path';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizePrivateKey(value) {
  const key = createPrivateKey(value.trim().replace(/\\n/g, '\n'));
  assert(
    key.asymmetricKeyType === 'ed25519',
    'artifact index signing requires an Ed25519 private key',
  );
  return key;
}

export function normalizeArtifactPublicKey(value) {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  assert(trimmed.length > 0, 'trusted artifact public key is empty');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'spki',
      });
  assert(
    key.asymmetricKeyType === 'ed25519',
    'artifact index trust store only accepts Ed25519 public keys',
  );
  return key;
}

export function artifactSigningKeyId(publicKey) {
  return sha256(publicKey.export({ format: 'der', type: 'spki' })).slice(0, 32);
}

function requireSupplyChainEntry(manifest, kind, expectedPath) {
  const entry = manifest.supplyChain?.[kind];
  assert(entry?.path === expectedPath, `missing ${kind} supply-chain document`);
  assert(
    SHA256_PATTERN.test(entry.sha256 || ''),
    `invalid ${kind} supply-chain digest`,
  );
  return { path: entry.path, sha256: entry.sha256 };
}

export function createAliyunServerArtifactIndex(input) {
  const { manifest, buildInfo, archive, packageSignature } = input;
  assert(
    manifest?.format === 'otto-enterprise-release-v1',
    'enterprise release manifest is invalid',
  );
  assert(
    COMMIT_PATTERN.test(manifest.sourceCommit || ''),
    'source commit is invalid',
  );
  assert(
    COMMIT_PATTERN.test(manifest.buildCommit || ''),
    'build commit is invalid',
  );
  assert(
    Number.isSafeInteger(input.releaseSequence) && input.releaseSequence > 0,
    'release sequence must be a positive integer',
  );
  assert(
    archive?.file === path.basename(archive.file || ''),
    'archive file must be a basename',
  );
  assert(
    Number.isSafeInteger(archive.size) && archive.size > 0,
    'archive size is invalid',
  );
  assert(
    SHA256_PATTERN.test(archive.sha256 || ''),
    'archive SHA-256 is invalid',
  );
  assert(
    packageSignature?.format === 'otto-enterprise-package-signature-v1' &&
      packageSignature.algorithm === 'Ed25519' &&
      packageSignature.file === archive.file &&
      packageSignature.sha256 === archive.sha256 &&
      /^[0-9a-f]{16}$/.test(packageSignature.keyId || '') &&
      typeof packageSignature.signature === 'string' &&
      packageSignature.signature.length > 0,
    'enterprise package signature metadata does not match archive',
  );
  assert(
    SHA256_PATTERN.test(input.packageSignatureFileSha256 || ''),
    'package signature file SHA-256 is invalid',
  );
  assert(
    Array.isArray(manifest.runtime?.supportedArchitectures) &&
      manifest.runtime.supportedArchitectures.length > 0,
    'release architectures are missing',
  );
  assert(
    buildInfo?.version === manifest.version &&
      buildInfo.buildCommit === manifest.buildCommit &&
      buildInfo.sourceCommit === manifest.sourceCommit,
    'BUILD-INFO.json does not match release manifest',
  );
  if (manifest.releaseChannel === 'stable') {
    assert(
      manifest.sourceTreeDirty === false && buildInfo.sourceTreeDirty === false,
      'stable cloud artifacts require a clean source tree',
    );
  }
  const publishedAt = new Date(input.publishedAt);
  const expiresAt = new Date(input.metadataExpiresAt);
  assert(!Number.isNaN(publishedAt.valueOf()), 'publishedAt is invalid');
  assert(!Number.isNaN(expiresAt.valueOf()), 'metadataExpiresAt is invalid');
  assert(expiresAt > publishedAt, 'metadata must expire after publication');

  return {
    format: 'otto-aliyun-server-artifact-v1',
    releaseSequence: input.releaseSequence,
    status: 'active',
    publishedAt: publishedAt.toISOString(),
    metadataExpiresAt: expiresAt.toISOString(),
    release: {
      version: manifest.version,
      channel: manifest.releaseChannel,
      sourceCommit: manifest.sourceCommit,
      sourceTreeDirty: manifest.sourceTreeDirty,
      sourceInputSha256: manifest.sourceInputSha256,
      sourceDiffSha256: manifest.sourceDiffSha256,
      buildCommit: manifest.buildCommit,
    },
    artifact: {
      type: 'computenest-private-file',
      name: 'otto-enterprise-server',
      immutable: true,
      file: archive.file,
      size: archive.size,
      sha256: archive.sha256,
      packageSignature: {
        file: `${archive.file}.sig`,
        fileSha256: input.packageSignatureFileSha256,
        format: packageSignature.format,
        algorithm: packageSignature.algorithm,
        keyId: packageSignature.keyId,
      },
      supportedArchitectures: [...manifest.runtime.supportedArchitectures],
    },
    runtime: manifest.runtime,
    database: manifest.database,
    supplyChain: {
      sbom: requireSupplyChainEntry(manifest, 'sbom', 'sbom.cdx.json'),
      licenses: requireSupplyChainEntry(
        manifest,
        'licenses',
        'THIRD-PARTY-LICENSES.json',
      ),
      provenance: requireSupplyChainEntry(
        manifest,
        'provenance',
        'provenance.json',
      ),
    },
    deployment: {
      minimumResources: {
        cpuCores: 2,
        memoryMiB: 4096,
        systemDiskGiB: 40,
      },
      servicePort: 7777,
      hooks: [
        'verify.sh',
        'install.sh',
        'upgrade.sh',
        'backup-now.sh',
        'restore-backup.sh',
        'tools/health-check.mjs',
      ],
      rollback: 'transactional-health-gated',
      dataOwnership: 'external-persistent-services',
    },
    secretContract: {
      embeddedCustomerSecrets: false,
      delivery: 'runtime-encrypted-reference-only',
      acceptedSources: [
        'Compute Nest encrypted parameters',
        'OOS SecretParameter',
      ],
    },
    verifier: {
      minimumVersion: 1,
      rejectRollbackBelowReleaseSequence: true,
      requireExternalTrustRoot: true,
    },
  };
}

export function serializeAliyunServerArtifactIndex(index) {
  return Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export function signAliyunServerArtifactIndex(input) {
  const document = Buffer.isBuffer(input.document)
    ? input.document
    : Buffer.from(input.document);
  const privateKey = normalizePrivateKey(input.privateKey);
  const publicKey = createPublicKey(privateKey);
  return {
    envelope: {
      format: 'otto-aliyun-artifact-index-signature-v1',
      algorithm: 'Ed25519',
      file: path.basename(input.file),
      sha256: sha256(document),
      keyId: artifactSigningKeyId(publicKey),
      signature: sign(null, document, privateKey).toString('base64url'),
    },
    publicKey,
  };
}

export function verifyAliyunServerArtifactIndexSignature(input) {
  const document = Buffer.isBuffer(input.document)
    ? input.document
    : Buffer.from(input.document);
  const { envelope } = input;
  assert(
    envelope?.format === 'otto-aliyun-artifact-index-signature-v1' &&
      envelope.algorithm === 'Ed25519' &&
      envelope.file === path.basename(input.file) &&
      SHA256_PATTERN.test(envelope.sha256 || '') &&
      /^[0-9a-f]{32}$/.test(envelope.keyId || '') &&
      typeof envelope.signature === 'string',
    'cloud artifact index signature envelope is invalid',
  );
  assert(
    !('publicKey' in envelope),
    'signature envelope must not select its trust key',
  );
  const publicKey = normalizeArtifactPublicKey(input.trustedPublicKey);
  assert(
    envelope.keyId === artifactSigningKeyId(publicKey),
    'cloud artifact signing key mismatch',
  );
  assert(
    envelope.sha256 === sha256(document),
    'cloud artifact index SHA-256 mismatch',
  );
  const signature = Buffer.from(envelope.signature, 'base64url');
  assert(
    signature.length === 64 && verify(null, document, publicKey, signature),
    'cloud artifact index Ed25519 signature is invalid',
  );
  return { ok: true, sha256: envelope.sha256, keyId: envelope.keyId };
}

export function validateAliyunServerArtifactPolicy(index, options = {}) {
  assert(
    index?.format === 'otto-aliyun-server-artifact-v1',
    'artifact index is invalid',
  );
  assert(index.status === 'active', 'artifact is revoked or inactive');
  assert(
    Number.isSafeInteger(index.releaseSequence) && index.releaseSequence > 0,
    'artifact release sequence is invalid',
  );
  if (options.minimumReleaseSequence !== undefined) {
    assert(
      index.releaseSequence >= options.minimumReleaseSequence,
      'artifact release sequence is below the trusted rollback floor',
    );
  }
  if (options.architecture) {
    assert(
      index.artifact?.supportedArchitectures?.includes(options.architecture),
      `artifact does not support ${options.architecture}`,
    );
  }
  const now = new Date(options.now || Date.now());
  const expiresAt = new Date(index.metadataExpiresAt);
  assert(
    !Number.isNaN(expiresAt.valueOf()) && expiresAt > now,
    'artifact metadata is expired',
  );
  assert(index.artifact?.immutable === true, 'artifact must be immutable');
  assert(
    index.secretContract?.embeddedCustomerSecrets === false,
    'artifact secret contract is not fail closed',
  );
  return { ok: true, releaseSequence: index.releaseSequence };
}
