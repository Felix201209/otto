/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  E2EE_TRUST_FORMAT,
  canonicalE2eeBytes,
  e2eeDeviceCertificateApprovalPayload,
  e2eeDeviceCertificateHash,
  e2eeDeviceCertificateRequestPayload,
  e2eeMerkleCheckpointPayload,
  e2eeMerkleInclusionProof,
  e2eeMerkleRoot,
  verifyE2eeDeviceCertificateApproval,
  verifyE2eeDeviceCertificateRequest,
  verifyE2eeMerkleAppendOnlySnapshot,
  verifyE2eeMerkleCheckpoint,
  verifyE2eeMerkleInclusion,
  type E2eeDeviceCertificateApprovalV2,
  type E2eeDeviceCertificateRequestV2,
  type E2eeMerkleCheckpoint,
} from './e2eeTrustV2.js';

function publicPem(key: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function requestFixture(): {
  request: E2eeDeviceCertificateRequestV2;
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
} {
  const key = generateKeyPairSync('ed25519');
  const exchange = generateKeyPairSync('x25519');
  const unsigned: E2eeDeviceCertificateRequestV2 = {
    format: E2EE_TRUST_FORMAT,
    deploymentId: 'deployment-1',
    organizationId: 'organization-1',
    accountId: 'account-1',
    deviceId: 'device-2',
    certificateSerial: 'cert-2',
    deviceName: 'Alice laptop',
    credentialSigningPublicKey: publicPem(key.publicKey),
    deviceExchangePublicKey: publicPem(exchange.publicKey),
    predecessorCertificateHash: null,
    proofOfPossession: '',
  };
  return {
    request: {
      ...unsigned,
      proofOfPossession: sign(
        null,
        e2eeDeviceCertificateRequestPayload(unsigned),
        key.privateKey,
      ).toString('base64'),
    },
    privateKey: key.privateKey,
  };
}

describe('E2EE trust v2', () => {
  it('canonicalizes signed payloads without locale-dependent key ordering', () => {
    expect(
      canonicalE2eeBytes('otto:test', {
        z: 1,
        a: { b: 2, A: 3 },
      }).toString('utf8'),
    ).toBe('otto:test\n{"a":{"A":3,"b":2},"z":1}');
  });

  it('requires target proof of possession and an existing device approval', () => {
    const target = requestFixture();
    const approver = generateKeyPairSync('ed25519');
    const normalizedRequest = verifyE2eeDeviceCertificateRequest(target.request);
    const unsigned: E2eeDeviceCertificateApprovalV2 = {
      format: E2EE_TRUST_FORMAT,
      request: normalizedRequest,
      approverDeviceId: 'device-1',
      approverCertificateHash: 'a'.repeat(64),
      approvedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2027-08-01T00:00:00.000Z',
      approvalSignature: '',
    };
    const approval = {
      ...unsigned,
      approvalSignature: sign(
        null,
        e2eeDeviceCertificateApprovalPayload(unsigned),
        approver.privateKey,
      ).toString('base64'),
    };

    expect(
      verifyE2eeDeviceCertificateApproval({
        approval,
        approverSigningPublicKey: publicPem(approver.publicKey),
      }),
    ).toMatchObject({ approverDeviceId: 'device-1' });
    expect(e2eeDeviceCertificateHash(approval)).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      e2eeDeviceCertificateHash({
        ...approval,
        approvalSignature: `${approval.approvalSignature}\n`,
      }),
    ).toBe(e2eeDeviceCertificateHash(approval));

    expect(() =>
      verifyE2eeDeviceCertificateRequest({
        ...target.request,
        deviceId: 'device-attacker',
      }),
    ).toThrow('proof of possession');
    expect(() =>
      verifyE2eeDeviceCertificateApproval({
        approval: {
          ...approval,
          expiresAt: '2028-08-01T00:00:00.000Z',
        },
        approverSigningPublicKey: publicPem(approver.publicKey),
      }),
    ).toThrow('approval signature');
  });

  it('builds and verifies RFC6962-style Merkle inclusion paths', () => {
    const leaves = Array.from({ length: 9 }, (_, index) =>
      canonicalE2eeBytes('otto:test-leaf:v1', { index }),
    );
    const root = e2eeMerkleRoot(leaves);
    for (const [leafIndex, leaf] of leaves.entries()) {
      expect(
        verifyE2eeMerkleInclusion({
          leaf,
          proof: e2eeMerkleInclusionProof(leaves, leafIndex),
          expectedRoot: root,
        }),
      ).toBe(true);
    }
    expect(
      verifyE2eeMerkleInclusion({
        leaf: canonicalE2eeBytes('otto:test-leaf:v1', { index: 99 }),
        proof: e2eeMerkleInclusionProof(leaves, 3),
        expectedRoot: root,
      }),
    ).toBe(false);
  });

  it('rejects rollback and split-view prefixes', () => {
    const original = Array.from({ length: 4 }, (_, index) =>
      canonicalE2eeBytes('otto:test-leaf:v1', { index }),
    );
    const extended = [
      ...original,
      canonicalE2eeBytes('otto:test-leaf:v1', { index: 4 }),
    ];
    expect(() =>
      verifyE2eeMerkleAppendOnlySnapshot({
        leaves: extended,
        treeSize: extended.length,
        rootHash: e2eeMerkleRoot(extended),
        pinnedTreeSize: original.length,
        pinnedRootHash: e2eeMerkleRoot(original),
      }),
    ).not.toThrow();

    const fork = [...extended];
    fork[2] = canonicalE2eeBytes('otto:test-leaf:v1', { index: 'fork' });
    expect(() =>
      verifyE2eeMerkleAppendOnlySnapshot({
        leaves: fork,
        treeSize: fork.length,
        rootHash: e2eeMerkleRoot(fork),
        pinnedTreeSize: original.length,
        pinnedRootHash: e2eeMerkleRoot(original),
      }),
    ).toThrow('rollback or fork');
  });

  it('verifies independently signed witness checkpoints', () => {
    const witness = generateKeyPairSync('ed25519');
    const unsigned: E2eeMerkleCheckpoint = {
      format: E2EE_TRUST_FORMAT,
      deploymentId: 'deployment-1',
      organizationId: 'organization-1',
      accountId: 'account-1',
      treeSize: 5,
      rootHash: 'b'.repeat(64),
      issuedAt: '2026-08-01T00:00:00.000Z',
      witnessKeyId: 'witness-2026-01',
      signature: '',
    };
    const checkpoint = {
      ...unsigned,
      signature: sign(
        null,
        e2eeMerkleCheckpointPayload(unsigned),
        witness.privateKey,
      ).toString('base64'),
    };
    expect(
      verifyE2eeMerkleCheckpoint({
        checkpoint,
        witnessPublicKey: publicPem(witness.publicKey),
      }),
    ).toBe(true);
    expect(
      verifyE2eeMerkleCheckpoint({
        checkpoint: { ...checkpoint, rootHash: 'c'.repeat(64) },
        witnessPublicKey: publicPem(witness.publicKey),
      }),
    ).toBe(false);
  });
});
