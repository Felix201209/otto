/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  OTTO_E2EE_PROTOCOL_ID,
  OTTO_E2EE_TRUST_VERSION,
  type E2eeAccountRootRegistration,
  type E2eeBootstrapProof,
  type E2eeDeviceApprovalProof,
  type E2eeDeviceProof,
  type E2eeDeviceRegistration,
  type E2eeDeviceRevocationProof,
  type E2eeTransparencyCheckpoint,
  type E2eeTransparencyLeaf,
  type E2eeTransparencyProofNode,
} from './secureMessagingContracts.js';

export const ED25519_SIGNATURE_PREFIX = 'ed25519:';
export const EMPTY_E2EE_MERKLE_ROOT = createHash('sha256')
  .update(Buffer.alloc(0))
  .digest('hex');

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalE2eeJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function ed25519PublicKey(value: string): KeyObject {
  const trimmed = value.trim().replace(/\\n/g, '\n');
  const key = trimmed.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(trimmed)
    : createPublicKey({
        key: Buffer.from(trimmed, 'base64'),
        format: 'der',
        type: 'spki',
      });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('E2EE signing key must be Ed25519');
  }
  return key;
}

export function normalizeE2eePublicKey(value: string): string {
  return ed25519PublicKey(value)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}

export function e2eePublicKeyId(value: string): string {
  const der = ed25519PublicKey(value).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex');
}

export function verifyE2eeSignature(
  payload: unknown,
  signature: string,
  publicKey: string,
): boolean {
  if (!signature.startsWith(ED25519_SIGNATURE_PREFIX)) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(
      signature.slice(ED25519_SIGNATURE_PREFIX.length),
      'base64url',
    );
  } catch {
    return false;
  }
  if (bytes.length !== 64) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalE2eeJson(payload)),
      ed25519PublicKey(publicKey),
      bytes,
    );
  } catch {
    return false;
  }
}

export function accountRootSigningPayload(
  input: Omit<
    E2eeAccountRootRegistration,
    'signature' | 'recoverySignature'
  >,
): unknown {
  return {
    purpose: 'otto-e2ee-account-root-registration',
    ...input,
  };
}

export function deviceRegistrationSigningPayload(
  input: Omit<E2eeDeviceRegistration, 'signature' | 'bootstrap'>,
): unknown {
  return {
    purpose: 'otto-e2ee-device-registration',
    ...input,
  };
}

export function deviceCredentialHash(
  input: Omit<E2eeDeviceRegistration, 'signature' | 'bootstrap'>,
): string {
  return createHash('sha256')
    .update(canonicalE2eeJson(deviceRegistrationSigningPayload(input)))
    .digest('hex');
}

export function deviceProofSigningPayload(input: E2eeDeviceProof): unknown {
  const { signature: _signature, ...proof } = input;
  return {
    purpose: `otto-e2ee-device-${input.type}`,
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    ...proof,
  };
}

export function e2eeProofId(proof: E2eeDeviceProof): string {
  return createHash('sha256')
    .update(canonicalE2eeJson(proof))
    .digest('hex');
}

export function e2eeTransparencyPayload(
  kind: E2eeTransparencyLeaf['kind'],
  value:
    | E2eeAccountRootRegistration
    | E2eeDeviceRegistration
    | E2eeDeviceProof,
): unknown {
  return { kind, value };
}

export function e2eeTransparencyLeafHash(payload: unknown): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalE2eeJson(payload))]))
    .digest('hex');
}

function e2eeTransparencyNodeHash(left: string, right: string): string {
  return createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from([1]),
        Buffer.from(left, 'hex'),
        Buffer.from(right, 'hex'),
      ]),
    )
    .digest('hex');
}

function largestPowerOfTwoBelow(value: number): number {
  let result = 1;
  while (result * 2 < value) result *= 2;
  return result;
}

export function e2eeMerkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) return EMPTY_E2EE_MERKLE_ROOT;
  if (hashes.length === 1) return hashes[0];
  const split = largestPowerOfTwoBelow(hashes.length);
  return e2eeTransparencyNodeHash(
    e2eeMerkleRoot(hashes.slice(0, split)),
    e2eeMerkleRoot(hashes.slice(split)),
  );
}

export function e2eeMerkleInclusionProof(
  hashes: readonly string[],
  index: number,
): E2eeTransparencyProofNode[] {
  if (!Number.isInteger(index) || index < 0 || index >= hashes.length) {
    throw new Error('E2EE transparency leaf index is out of range');
  }
  if (hashes.length === 1) return [];
  const split = largestPowerOfTwoBelow(hashes.length);
  if (index < split) {
    return [
      ...e2eeMerkleInclusionProof(hashes.slice(0, split), index),
      { position: 'right', hash: e2eeMerkleRoot(hashes.slice(split)) },
    ];
  }
  return [
    ...e2eeMerkleInclusionProof(hashes.slice(split), index - split),
    { position: 'left', hash: e2eeMerkleRoot(hashes.slice(0, split)) },
  ];
}

export function verifyE2eeMerkleInclusion(input: {
  leafHash: string;
  accountSequence: number;
  nodes: readonly E2eeTransparencyProofNode[];
  checkpoint: E2eeTransparencyCheckpoint;
}): boolean {
  const index = input.accountSequence - 1;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= input.checkpoint.size ||
    !/^[a-f0-9]{64}$/u.test(input.leafHash) ||
    !/^[a-f0-9]{64}$/u.test(input.checkpoint.rootHash) ||
    input.nodes.some((node) => !/^[a-f0-9]{64}$/u.test(node.hash))
  ) {
    return false;
  }
  const expectedPositions = (size: number, leafIndex: number): Array<'left' | 'right'> => {
    if (size === 1) return [];
    const split = largestPowerOfTwoBelow(size);
    return leafIndex < split
      ? [...expectedPositions(split, leafIndex), 'right']
      : [
          ...expectedPositions(size - split, leafIndex - split),
          'left',
        ];
  };
  if (
    canonicalE2eeJson(input.nodes.map((node) => node.position)) !==
    canonicalE2eeJson(expectedPositions(input.checkpoint.size, index))
  ) {
    return false;
  }
  let current = input.leafHash;
  for (const node of input.nodes) {
    current =
      node.position === 'left'
        ? e2eeTransparencyNodeHash(node.hash, current)
        : e2eeTransparencyNodeHash(current, node.hash);
  }
  return current === input.checkpoint.rootHash;
}

export function isBootstrapProof(
  value: E2eeDeviceProof,
): value is E2eeBootstrapProof {
  return value.type === 'bootstrap';
}

export function isApprovalProof(
  value: E2eeDeviceProof,
): value is E2eeDeviceApprovalProof {
  return value.type === 'approval';
}

export function isRevocationProof(
  value: E2eeDeviceProof,
): value is E2eeDeviceRevocationProof {
  return value.type === 'revocation';
}
