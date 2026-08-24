/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createAliyunServerArtifactIndex,
  serializeAliyunServerArtifactIndex,
  sha256,
  signAliyunServerArtifactIndex,
  validateAliyunServerArtifactPolicy,
  verifyAliyunServerArtifactIndexSignature,
} from '../aliyun-server-artifact.mjs';

function fixture(overrides = {}) {
  const { manifest: manifestOverrides, ...rootOverrides } = overrides;
  const archive = Buffer.from('signed enterprise archive');
  const archiveSha256 = sha256(archive);
  const manifest = {
    format: 'otto-enterprise-release-v1',
    version: '1.10.2',
    releaseChannel: 'stable',
    sourceCommit: '1'.repeat(40),
    sourceTreeDirty: false,
    sourceInputSha256: '2'.repeat(64),
    sourceDiffSha256: '3'.repeat(64),
    buildCommit: '4'.repeat(40),
    runtime: {
      node: '22.23.1',
      supportedArchitectures: ['linux-x64', 'linux-arm64'],
    },
    database: {
      schemaFrom: [2, 3],
      schemaTo: 3,
      futureSchemaPolicy: 'reject',
    },
    supplyChain: {
      sbom: { path: 'sbom.cdx.json', sha256: '5'.repeat(64) },
      licenses: {
        path: 'THIRD-PARTY-LICENSES.json',
        sha256: '6'.repeat(64),
      },
      provenance: { path: 'provenance.json', sha256: '7'.repeat(64) },
    },
    ...manifestOverrides,
  };
  return {
    manifest,
    buildInfo: {
      version: manifest.version,
      buildCommit: manifest.buildCommit,
      sourceCommit: manifest.sourceCommit,
      sourceTreeDirty: manifest.sourceTreeDirty,
    },
    releaseSequence: 42,
    publishedAt: '2026-08-24T00:00:00.000Z',
    metadataExpiresAt: '2026-11-22T00:00:00.000Z',
    archive: {
      file: 'otto-enterprise-oneclick-v1.10.2-444444444444.tar.gz',
      size: archive.length,
      sha256: archiveSha256,
    },
    packageSignature: {
      format: 'otto-enterprise-package-signature-v1',
      algorithm: 'Ed25519',
      file: 'otto-enterprise-oneclick-v1.10.2-444444444444.tar.gz',
      sha256: archiveSha256,
      keyId: '8'.repeat(16),
      signature: 'fixture',
    },
    packageSignatureFileSha256: '9'.repeat(64),
    ...rootOverrides,
  };
}

describe('Aliyun server artifact index', () => {
  it('binds release identity, runtime, database, supply chain and rollback sequence', () => {
    const index = createAliyunServerArtifactIndex(fixture());
    expect(index).toMatchObject({
      format: 'otto-aliyun-server-artifact-v1',
      releaseSequence: 42,
      status: 'active',
      release: {
        version: '1.10.2',
        sourceCommit: '1'.repeat(40),
        buildCommit: '4'.repeat(40),
      },
      artifact: {
        immutable: true,
        supportedArchitectures: ['linux-x64', 'linux-arm64'],
      },
      secretContract: { embeddedCustomerSecrets: false },
    });
  });

  it('accepts an externally trusted Ed25519 signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const index = createAliyunServerArtifactIndex(fixture());
    const document = serializeAliyunServerArtifactIndex(index);
    const signed = signAliyunServerArtifactIndex({
      document,
      file: 'artifact.json',
      privateKey: privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    });
    expect(
      verifyAliyunServerArtifactIndexSignature({
        document,
        file: 'artifact.json',
        envelope: signed.envelope,
        trustedPublicKey: publicKey
          .export({ format: 'pem', type: 'spki' })
          .toString(),
      }),
    ).toMatchObject({ ok: true, keyId: signed.envelope.keyId });
  });

  it.each([
    ['tampered document', 'document'],
    ['wrong public key', 'key'],
    ['self-selected public key', 'embedded-key'],
  ])('rejects %s', (_name, mutation) => {
    const trusted = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const document = serializeAliyunServerArtifactIndex(
      createAliyunServerArtifactIndex(fixture()),
    );
    const signed = signAliyunServerArtifactIndex({
      document,
      file: 'artifact.json',
      privateKey: trusted.privateKey
        .export({ format: 'pem', type: 'pkcs8' })
        .toString(),
    });
    if (mutation === 'embedded-key') signed.envelope.publicKey = 'attacker';
    expect(() =>
      verifyAliyunServerArtifactIndexSignature({
        document:
          mutation === 'document'
            ? Buffer.concat([document, Buffer.from('x')])
            : document,
        file: 'artifact.json',
        envelope: signed.envelope,
        trustedPublicKey: (mutation === 'key'
          ? attacker.publicKey
          : trusted.publicKey
        )
          .export({ format: 'pem', type: 'spki' })
          .toString(),
      }),
    ).toThrow();
  });

  it.each([
    ['rollback', { minimumReleaseSequence: 43 }],
    ['wrong architecture', { architecture: 'darwin-arm64' }],
    ['expired metadata', { now: '2026-12-01T00:00:00.000Z' }],
  ])('rejects %s', (_name, policy) => {
    const index = createAliyunServerArtifactIndex(fixture());
    expect(() => validateAliyunServerArtifactPolicy(index, policy)).toThrow();
  });

  it('rejects revoked metadata', () => {
    const index = createAliyunServerArtifactIndex(fixture());
    index.status = 'revoked';
    expect(() =>
      validateAliyunServerArtifactPolicy(index, {
        now: '2026-08-25T00:00:00.000Z',
      }),
    ).toThrow('revoked or inactive');
  });

  it('rejects dirty stable builds before they reach the signing boundary', () => {
    expect(() =>
      createAliyunServerArtifactIndex(
        fixture({ manifest: { sourceTreeDirty: true } }),
      ),
    ).toThrow('clean source tree');
  });
});
