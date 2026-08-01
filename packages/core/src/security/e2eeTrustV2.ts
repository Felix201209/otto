/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Shared, side-effect-free trust primitives for the E2EE v2 prototype.
 * Private-key operations stay in the desktop main process. The server uses
 * this module only to validate signed statements and publish Merkle proofs.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

export const E2EE_TRUST_FORMAT = 2 as const;
export const E2EE_MERKLE_EMPTY_ROOT = createHash('sha256')
  .update(Buffer.alloc(0))
  .digest('hex');

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export interface E2eeDeviceCertificateRequestV2 {
  format: 2;
  deploymentId: string;
  organizationId: string;
  accountId: string;
  deviceId: string;
  certificateSerial: string;
  deviceName: string;
  credentialSigningPublicKey: string;
  deviceExchangePublicKey: string;
  predecessorCertificateHash: string | null;
  proofOfPossession: string;
}

export interface E2eeDeviceCertificateApprovalV2 {
  format: 2;
  request: Omit<E2eeDeviceCertificateRequestV2, 'proofOfPossession'>;
  approverDeviceId: string;
  approverCertificateHash: string;
  approvedAt: string;
  expiresAt: string;
  approvalSignature: string;
}

export interface E2eeMerkleInclusionProof {
  leafIndex: number;
  treeSize: number;
  hashes: string[];
}

export interface E2eeMerkleCheckpoint {
  format: 2;
  deploymentId: string;
  organizationId: string;
  accountId: string;
  treeSize: number;
  rootHash: string;
  issuedAt: string;
  witnessKeyId: string;
  signature: string;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireHash(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_SHA256.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizePublicKey(value: string, label: string): string {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('wrong key type');
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error(`${label} must be an Ed25519 public key`);
  }
}

function normalizeExchangePublicKey(value: string, label: string): string {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== 'x25519') {
      throw new Error('wrong key type');
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error(`${label} must be an X25519 public key`);
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function canonicalE2eeBytes(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}\n${JSON.stringify(canonicalize(value))}`, 'utf8');
}

function normalizedCertificateRequest(
  input: E2eeDeviceCertificateRequestV2,
): Omit<E2eeDeviceCertificateRequestV2, 'proofOfPossession'> {
  return {
    format: E2EE_TRUST_FORMAT,
    deploymentId: requireIdentifier(input.deploymentId, 'deployment id'),
    organizationId: requireIdentifier(input.organizationId, 'organization id'),
    accountId: requireIdentifier(input.accountId, 'account id'),
    deviceId: requireIdentifier(input.deviceId, 'device id'),
    certificateSerial: requireIdentifier(
      input.certificateSerial,
      'certificate serial',
    ),
    deviceName: input.deviceName.trim().slice(0, 120) || 'Otto device',
    credentialSigningPublicKey: normalizePublicKey(
      input.credentialSigningPublicKey,
      'credential signing public key',
    ),
    deviceExchangePublicKey: normalizeExchangePublicKey(
      input.deviceExchangePublicKey,
      'device exchange public key',
    ),
    predecessorCertificateHash:
      input.predecessorCertificateHash === null
        ? null
        : requireHash(
            input.predecessorCertificateHash,
            'predecessor certificate hash',
          ),
  };
}

export function e2eeDeviceCertificateRequestPayload(
  input: E2eeDeviceCertificateRequestV2,
): Buffer {
  return canonicalE2eeBytes(
    'otto:e2ee-device-certificate-request:v2',
    normalizedCertificateRequest(input),
  );
}

export function verifyE2eeDeviceCertificateRequest(
  input: E2eeDeviceCertificateRequestV2,
): Omit<E2eeDeviceCertificateRequestV2, 'proofOfPossession'> {
  const normalized = normalizedCertificateRequest(input);
  let signature: Buffer;
  try {
    signature = Buffer.from(input.proofOfPossession, 'base64');
  } catch {
    throw new Error('device proof of possession is invalid');
  }
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      canonicalE2eeBytes(
        'otto:e2ee-device-certificate-request:v2',
        normalized,
      ),
      createPublicKey(normalized.credentialSigningPublicKey),
      signature,
    )
  ) {
    throw new Error('device proof of possession is invalid');
  }
  return normalized;
}

export function e2eeDeviceCertificateRequestHash(
  input: E2eeDeviceCertificateRequestV2,
): string {
  return createHash('sha256')
    .update(e2eeDeviceCertificateRequestPayload(input))
    .update(Buffer.from(input.proofOfPossession, 'base64'))
    .digest('hex');
}

function normalizedCertificateApproval(
  input: E2eeDeviceCertificateApprovalV2,
): Omit<E2eeDeviceCertificateApprovalV2, 'approvalSignature'> {
  const request = normalizedCertificateRequest({
    ...input.request,
    proofOfPossession: '',
  });
  const approvedAtMs = Date.parse(input.approvedAt);
  const expiresAtMs = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(approvedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= approvedAtMs
  ) {
    throw new Error('device certificate lifetime is invalid');
  }
  return {
    format: E2EE_TRUST_FORMAT,
    request,
    approverDeviceId: requireIdentifier(
      input.approverDeviceId,
      'approver device id',
    ),
    approverCertificateHash: requireHash(
      input.approverCertificateHash,
      'approver certificate hash',
    ),
    approvedAt: new Date(approvedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function e2eeDeviceCertificateApprovalPayload(
  input: E2eeDeviceCertificateApprovalV2,
): Buffer {
  return canonicalE2eeBytes(
    'otto:e2ee-device-certificate-approval:v2',
    normalizedCertificateApproval(input),
  );
}

export function verifyE2eeDeviceCertificateApproval(input: {
  approval: E2eeDeviceCertificateApprovalV2;
  approverSigningPublicKey: string;
}): Omit<E2eeDeviceCertificateApprovalV2, 'approvalSignature'> {
  const normalized = normalizedCertificateApproval(input.approval);
  const signature = Buffer.from(input.approval.approvalSignature, 'base64');
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      canonicalE2eeBytes(
        'otto:e2ee-device-certificate-approval:v2',
        normalized,
      ),
      createPublicKey(
        normalizePublicKey(
          input.approverSigningPublicKey,
          'approver signing public key',
        ),
      ),
      signature,
    )
  ) {
    throw new Error('device certificate approval signature is invalid');
  }
  return normalized;
}

export function e2eeDeviceCertificateHash(
  input: E2eeDeviceCertificateApprovalV2,
): string {
  const signature = Buffer.from(input.approvalSignature, 'base64');
  if (signature.length !== 64) {
    throw new Error('device certificate approval signature is invalid');
  }
  return createHash('sha256')
    .update(
      canonicalE2eeBytes(
        'otto:e2ee-device-certificate:v2',
        normalizedCertificateApproval(input),
      ),
    )
    .update(signature)
    .digest('hex');
}

function hashLeaf(leaf: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.from([0]))
    .update(leaf)
    .digest();
}

function hashNode(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.from([1]))
    .update(left)
    .update(right)
    .digest();
}

function largestPowerOfTwoLessThan(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 1) {
    throw new Error('Merkle subtree size is invalid');
  }
  let result = 1;
  while (result * 2 < value) result *= 2;
  return result;
}

function subtreeHash(leaves: readonly Buffer[], start: number, size: number): Buffer {
  if (size === 1) return hashLeaf(leaves[start]!);
  const split = largestPowerOfTwoLessThan(size);
  return hashNode(
    subtreeHash(leaves, start, split),
    subtreeHash(leaves, start + split, size - split),
  );
}

export function e2eeMerkleRoot(leaves: readonly Buffer[]): string {
  return leaves.length === 0
    ? E2EE_MERKLE_EMPTY_ROOT
    : subtreeHash(leaves, 0, leaves.length).toString('hex');
}

function inclusionPath(
  leaves: readonly Buffer[],
  leafIndex: number,
  start: number,
  size: number,
): Buffer[] {
  if (size === 1) return [];
  const split = largestPowerOfTwoLessThan(size);
  if (leafIndex < split) {
    return [
      ...inclusionPath(leaves, leafIndex, start, split),
      subtreeHash(leaves, start + split, size - split),
    ];
  }
  return [
    ...inclusionPath(leaves, leafIndex - split, start + split, size - split),
    subtreeHash(leaves, start, split),
  ];
}

export function e2eeMerkleInclusionProof(
  leaves: readonly Buffer[],
  leafIndex: number,
): E2eeMerkleInclusionProof {
  if (
    leaves.length === 0 ||
    !Number.isSafeInteger(leafIndex) ||
    leafIndex < 0 ||
    leafIndex >= leaves.length
  ) {
    throw new Error('Merkle leaf index is invalid');
  }
  return {
    leafIndex,
    treeSize: leaves.length,
    hashes: inclusionPath(leaves, leafIndex, 0, leaves.length).map((hash) =>
      hash.toString('hex'),
    ),
  };
}

function rootFromInclusionProof(
  leaf: Buffer,
  proof: readonly Buffer[],
  leafIndex: number,
  treeSize: number,
  cursor: { value: number },
): Buffer {
  if (treeSize === 1) return hashLeaf(leaf);
  const split = largestPowerOfTwoLessThan(treeSize);
  if (leafIndex < split) {
    const left = rootFromInclusionProof(
      leaf,
      proof,
      leafIndex,
      split,
      cursor,
    );
    const right = proof[cursor.value++];
    if (!right) throw new Error('Merkle inclusion proof is incomplete');
    return hashNode(left, right);
  }
  const right = rootFromInclusionProof(
    leaf,
    proof,
    leafIndex - split,
    treeSize - split,
    cursor,
  );
  const left = proof[cursor.value++];
  if (!left) throw new Error('Merkle inclusion proof is incomplete');
  return hashNode(left, right);
}

export function verifyE2eeMerkleInclusion(input: {
  leaf: Buffer;
  proof: E2eeMerkleInclusionProof;
  expectedRoot: string;
}): boolean {
  try {
    const expectedRoot = requireHash(input.expectedRoot, 'Merkle root');
    if (
      input.proof.treeSize <= 0 ||
      input.proof.leafIndex < 0 ||
      input.proof.leafIndex >= input.proof.treeSize
    ) {
      return false;
    }
    const proof = input.proof.hashes.map((hash) =>
      Buffer.from(requireHash(hash, 'Merkle proof hash'), 'hex'),
    );
    const cursor = { value: 0 };
    const root = rootFromInclusionProof(
      input.leaf,
      proof,
      input.proof.leafIndex,
      input.proof.treeSize,
      cursor,
    ).toString('hex');
    return cursor.value === proof.length && root === expectedRoot;
  } catch {
    return false;
  }
}

export function verifyE2eeMerkleAppendOnlySnapshot(input: {
  leaves: readonly Buffer[];
  treeSize: number;
  rootHash: string;
  pinnedTreeSize?: number;
  pinnedRootHash?: string;
}): void {
  if (input.treeSize !== input.leaves.length) {
    throw new Error('Merkle transparency tree size is invalid');
  }
  if (e2eeMerkleRoot(input.leaves) !== requireHash(input.rootHash, 'Merkle root')) {
    throw new Error('Merkle transparency root is invalid');
  }
  if (input.pinnedTreeSize === undefined) return;
  if (
    !Number.isSafeInteger(input.pinnedTreeSize) ||
    input.pinnedTreeSize < 0 ||
    input.pinnedTreeSize > input.treeSize ||
    !input.pinnedRootHash
  ) {
    throw new Error('Merkle transparency checkpoint is invalid');
  }
  const prefixRoot = e2eeMerkleRoot(input.leaves.slice(0, input.pinnedTreeSize));
  if (prefixRoot !== requireHash(input.pinnedRootHash, 'pinned Merkle root')) {
    throw new Error('Merkle transparency rollback or fork detected');
  }
}

export function e2eeMerkleCheckpointPayload(
  checkpoint: E2eeMerkleCheckpoint,
): Buffer {
  return canonicalE2eeBytes('otto:e2ee-merkle-checkpoint:v2', {
    format: E2EE_TRUST_FORMAT,
    deploymentId: requireIdentifier(checkpoint.deploymentId, 'deployment id'),
    organizationId: requireIdentifier(
      checkpoint.organizationId,
      'organization id',
    ),
    accountId: requireIdentifier(checkpoint.accountId, 'account id'),
    treeSize: checkpoint.treeSize,
    rootHash: requireHash(checkpoint.rootHash, 'Merkle root'),
    issuedAt: new Date(checkpoint.issuedAt).toISOString(),
    witnessKeyId: requireIdentifier(checkpoint.witnessKeyId, 'witness key id'),
  });
}

export function verifyE2eeMerkleCheckpoint(input: {
  checkpoint: E2eeMerkleCheckpoint;
  witnessPublicKey: string;
}): boolean {
  try {
    if (!Number.isSafeInteger(input.checkpoint.treeSize) || input.checkpoint.treeSize < 0) {
      return false;
    }
    const signature = Buffer.from(input.checkpoint.signature, 'base64');
    return (
      signature.length === 64 &&
      verifySignature(
        null,
        e2eeMerkleCheckpointPayload(input.checkpoint),
        createPublicKey(
          normalizePublicKey(input.witnessPublicKey, 'witness public key'),
        ),
        signature,
      )
    );
  } catch {
    return false;
  }
}
