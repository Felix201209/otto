/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  OTTO_E2EE_PROTOCOL_ID,
  OTTO_E2EE_TRUST_VERSION,
  type E2eeAccountRootRegistration,
  type E2eeDeviceDirectorySnapshot,
  type E2eeDeviceRegistration,
  type E2eeDeviceState,
  type E2eeTransparencyCheckpoint,
} from './secureMessagingContracts.js';
import {
  accountRootSigningPayload,
  canonicalE2eeJson,
  deviceCredentialHash,
  deviceProofSigningPayload,
  deviceRegistrationSigningPayload,
  e2eeMerkleRoot,
  e2eePublicKeyId,
  e2eeTransparencyLeafHash,
  e2eeTransparencyPayload,
  isApprovalProof,
  isBootstrapProof,
  verifyE2eeSignature,
} from './secureMessagingCrypto.js';

function rootRegistration(
  snapshot: E2eeDeviceDirectorySnapshot,
): E2eeAccountRootRegistration {
  const { rootKeyId: _rootKeyId, transparencySequence: _sequence, ...root } =
    snapshot.root;
  return root;
}

function deviceRegistration(
  device: E2eeDeviceDirectorySnapshot['devices'][number],
): E2eeDeviceRegistration {
  const {
    credentialHash: _credentialHash,
    state: _state,
    transparencySequence: _sequence,
    ...registration
  } = device;
  return registration;
}

function assertSameScope(
  snapshot: E2eeDeviceDirectorySnapshot,
  organizationId: string,
  accountId: string,
): void {
  if (
    organizationId !== snapshot.organizationId ||
    accountId !== snapshot.accountId
  ) {
    throw new Error('E2EE directory contains a cross-account trust record');
  }
}

function verifyTransparency(
  snapshot: E2eeDeviceDirectorySnapshot,
  previous?: E2eeTransparencyCheckpoint,
): void {
  const expected = new Map<number, { kind: string; payload: unknown }>();
  const root = rootRegistration(snapshot);
  expected.set(snapshot.root.transparencySequence, {
    kind: 'account_root_registered',
    payload: e2eeTransparencyPayload('account_root_registered', root),
  });
  for (const device of snapshot.devices) {
    const registration = deviceRegistration(device);
    expected.set(device.transparencySequence, {
      kind: 'device_registered',
      payload: e2eeTransparencyPayload('device_registered', registration),
    });
  }
  for (const entry of snapshot.proofs) {
    const kind =
      entry.proof.type === 'bootstrap'
        ? 'device_bootstrapped'
        : entry.proof.type === 'approval'
          ? 'device_approved'
          : 'device_revoked';
    expected.set(entry.transparencySequence, {
      kind,
      payload: e2eeTransparencyPayload(kind, entry.proof),
    });
  }

  const leaves = [...snapshot.transparency.leaves].sort(
    (left, right) => left.accountSequence - right.accountSequence,
  );
  if (leaves.length !== expected.size) {
    throw new Error('E2EE transparency log omitted or added a trust event');
  }
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    if (leaf.accountSequence !== index + 1) {
      throw new Error('E2EE transparency log contains a sequence gap');
    }
    const event = expected.get(leaf.accountSequence);
    if (
      !event ||
      event.kind !== leaf.kind ||
      canonicalE2eeJson(event.payload) !== canonicalE2eeJson(leaf.payload) ||
      e2eeTransparencyLeafHash(leaf.payload) !== leaf.leafHash
    ) {
      throw new Error('E2EE transparency event does not match its signed record');
    }
  }
  const hashes = leaves.map((leaf) => leaf.leafHash);
  if (
    snapshot.transparency.checkpoint.size !== hashes.length ||
    snapshot.transparency.checkpoint.rootHash !== e2eeMerkleRoot(hashes)
  ) {
    throw new Error('E2EE transparency checkpoint is invalid');
  }
  if (previous) {
    if (previous.size > hashes.length) {
      throw new Error('E2EE transparency rollback detected');
    }
    if (
      previous.rootHash !== e2eeMerkleRoot(hashes.slice(0, previous.size))
    ) {
      throw new Error('E2EE transparency fork detected');
    }
  }
}

export function verifyE2eeDeviceDirectorySnapshot(
  snapshot: E2eeDeviceDirectorySnapshot,
  options: {
    previousCheckpoint?: E2eeTransparencyCheckpoint;
    nowMs?: number;
  } = {},
): void {
  if (
    snapshot.protocolId !== OTTO_E2EE_PROTOCOL_ID ||
    snapshot.trustVersion !== OTTO_E2EE_TRUST_VERSION
  ) {
    throw new Error('E2EE directory protocol is unsupported');
  }
  const root = rootRegistration(snapshot);
  const {
    signature: _rootSignature,
    recoverySignature: _recoverySignature,
    ...unsignedRoot
  } = root;
  assertSameScope(snapshot, root.organizationId, root.accountId);
  if (
    e2eePublicKeyId(root.rootSigningPublicKey) !== snapshot.root.rootKeyId ||
    !verifyE2eeSignature(
      accountRootSigningPayload(unsignedRoot),
      root.signature,
      root.rootSigningPublicKey,
    ) ||
    !verifyE2eeSignature(
      accountRootSigningPayload(unsignedRoot),
      root.recoverySignature,
      root.recoveryPublicKey,
    )
  ) {
    throw new Error('E2EE account trust root signature is invalid');
  }

  const registrations = new Map<string, E2eeDeviceRegistration>();
  const states = new Map<string, E2eeDeviceState>();
  for (const device of snapshot.devices) {
    const registration = deviceRegistration(device);
    const {
      signature: _deviceSignature,
      bootstrap: _bootstrap,
      ...unsignedDevice
    } = registration;
    assertSameScope(
      snapshot,
      registration.organizationId,
      registration.accountId,
    );
    if (
      deviceCredentialHash(unsignedDevice) !== device.credentialHash ||
      !verifyE2eeSignature(
        deviceRegistrationSigningPayload(unsignedDevice),
        registration.signature,
        registration.signingPublicKey,
      )
    ) {
      throw new Error('E2EE device registration signature is invalid');
    }
    if (registrations.has(registration.deviceId)) {
      throw new Error('E2EE directory contains a duplicate device');
    }
    registrations.set(registration.deviceId, registration);
    states.set(registration.deviceId, 'pending');
  }

  const proofs = [...snapshot.proofs].sort(
    (left, right) => left.transparencySequence - right.transparencySequence,
  );
  for (const entry of proofs) {
    const proof = entry.proof;
    assertSameScope(snapshot, proof.organizationId, proof.accountId);
    const target = registrations.get(proof.targetDeviceId);
    if (!target) {
      throw new Error('E2EE device proof targets an unknown credential');
    }
    const {
      signature: _targetSignature,
      bootstrap: _targetBootstrap,
      ...unsignedTarget
    } = target;
    if (deviceCredentialHash(unsignedTarget) !== proof.targetCredentialHash) {
      throw new Error('E2EE device proof targets an unknown credential');
    }

    if (isBootstrapProof(proof)) {
      if ([...states.values()].some((state) => state === 'approved')) {
        throw new Error('E2EE bootstrap proof is only valid for the first device');
      }
      if (
        !verifyE2eeSignature(
          deviceProofSigningPayload(proof),
          proof.signature,
          root.rootSigningPublicKey,
        )
      ) {
        throw new Error('E2EE bootstrap proof signature is invalid');
      }
      states.set(proof.targetDeviceId, 'approved');
      continue;
    }

    const actor = registrations.get(proof.actorDeviceId);
    if (!actor || states.get(proof.actorDeviceId) !== 'approved') {
      throw new Error('E2EE device proof actor is not an approved device');
    }
    if (Date.parse(actor.expiresAt) <= Date.parse(proof.issuedAt)) {
      throw new Error('E2EE device proof actor credential was expired');
    }
    if (
      !verifyE2eeSignature(
        deviceProofSigningPayload(proof),
        proof.signature,
        actor.signingPublicKey,
      )
    ) {
      throw new Error('E2EE device proof signature is invalid');
    }
    if (isApprovalProof(proof)) {
      if (states.get(proof.targetDeviceId) !== 'pending') {
        throw new Error('E2EE approval proof does not target a pending device');
      }
      states.set(proof.targetDeviceId, 'approved');
    } else {
      if (states.get(proof.targetDeviceId) !== 'approved') {
        throw new Error('E2EE revocation proof does not target an approved device');
      }
      states.set(proof.targetDeviceId, 'revoked');
    }
  }

  const nowMs = options.nowMs ?? Date.now();
  for (const device of snapshot.devices) {
    const expectedState =
      states.get(device.deviceId) !== 'revoked' &&
      Date.parse(device.expiresAt) <= nowMs
        ? 'expired'
        : states.get(device.deviceId);
    if (device.state !== expectedState) {
      throw new Error('E2EE device state is not backed by signed proofs');
    }
  }
  verifyTransparency(snapshot, options.previousCheckpoint);
}
