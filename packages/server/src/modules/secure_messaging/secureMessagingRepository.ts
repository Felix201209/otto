/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  OTTO_E2EE_PROTOCOL_ID,
  OTTO_E2EE_TRUST_VERSION,
  type E2eeAccountRootRegistration,
  type E2eeAccountRootView,
  type E2eeDeviceApprovalProof,
  type E2eeDeviceDirectorySnapshot,
  type E2eeDeviceProof,
  type E2eeDeviceProofView,
  type E2eeDeviceRegistration,
  type E2eeDeviceRevocationProof,
  type E2eeDeviceView,
  type E2eeTransparencyEventKind,
  type E2eeTransparencyInclusionProof,
  type E2eeTransparencyLeaf,
} from './secureMessagingContracts.js';
import {
  accountRootSigningPayload,
  canonicalE2eeJson,
  deviceCredentialHash,
  deviceProofSigningPayload,
  deviceRegistrationSigningPayload,
  e2eeMerkleInclusionProof,
  e2eeMerkleRoot,
  e2eeProofId,
  e2eePublicKeyId,
  e2eeTransparencyLeafHash,
  e2eeTransparencyPayload,
  normalizeE2eePublicKey,
  verifyE2eeSignature,
} from './secureMessagingCrypto.js';
import { verifyE2eeDeviceDirectorySnapshot } from './secureMessagingVerification.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const KEY_PACKAGE_MAX_BYTES = 64 * 1024;
const REGISTRATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PROOF_MAX_AGE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEVICE_MAX_LIFETIME_MS = 400 * 24 * 60 * 60 * 1000;

export interface SecureMessagingRepositoryStore {
  db(): Database;
  now(): number;
  isActiveAccountInOrganization(
    accountId: string,
    organizationId: string,
  ): boolean;
}

interface RootRow {
  organization_id: string;
  account_id: string;
  protocol_id: typeof OTTO_E2EE_PROTOCOL_ID;
  trust_version: typeof OTTO_E2EE_TRUST_VERSION;
  root_key_id: string;
  root_signing_public_key: string;
  recovery_public_key: string;
  issued_at: string;
  nonce: string;
  signature: string;
  recovery_signature: string;
  transparency_sequence: number;
}

interface DeviceRow {
  organization_id: string;
  account_id: string;
  device_id: string;
  protocol_id: typeof OTTO_E2EE_PROTOCOL_ID;
  trust_version: typeof OTTO_E2EE_TRUST_VERSION;
  device_name: string;
  signing_public_key: string;
  mls_key_package: string;
  credential_hash: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  signature: string;
  transparency_sequence: number;
}

interface ProofRow {
  proof_id: string;
  organization_id: string;
  account_id: string;
  proof_type: E2eeDeviceProof['type'];
  actor_device_id: string | null;
  target_device_id: string;
  target_credential_hash: string;
  issued_at: string;
  nonce: string;
  signature: string;
  transparency_sequence: number;
}

interface TransparencyRow {
  account_sequence: number;
  event_kind: E2eeTransparencyEventKind;
  payload_json: string;
  leaf_hash: string;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireText(
  value: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requireNonce(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(normalized)) {
    throw new Error('E2EE proof nonce is invalid');
  }
  return normalized;
}

function requireIsoTime(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`);
  return new Date(timestamp).toISOString();
}

function requireFreshTime(
  value: string,
  label: string,
  nowMs: number,
  maximumAgeMs: number,
): string {
  const normalized = requireIsoTime(value, label);
  const timestamp = Date.parse(normalized);
  if (timestamp > nowMs + CLOCK_SKEW_MS || timestamp < nowMs - maximumAgeMs) {
    throw new Error(`${label} is outside the allowed time window`);
  }
  return normalized;
}

function requireKeyPackage(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error('MLS KeyPackage is invalid');
  }
  const bytes = Buffer.from(normalized, 'base64url');
  if (bytes.length < 32 || bytes.length > KEY_PACKAGE_MAX_BYTES) {
    throw new Error('MLS KeyPackage size is invalid');
  }
  return bytes.toString('base64url');
}

function assertActiveAccount(
  store: SecureMessagingRepositoryStore,
  accountId: string,
  organizationId: string,
): void {
  if (!store.isActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('E2EE account is not active in organization');
  }
}

function withTransaction<T>(database: Database, operation: () => T): T {
  const owns = !database.inTransaction;
  if (owns) database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (owns) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (owns && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function appendTransparencyLeaf(
  database: Database,
  organizationId: string,
  accountId: string,
  kind: E2eeTransparencyEventKind,
  value:
    | E2eeAccountRootRegistration
    | E2eeDeviceRegistration
    | E2eeDeviceProof,
): number {
  const next = Number(
    (
      database
        .prepare(
          `SELECT COALESCE(MAX(account_sequence), 0) + 1 AS next
           FROM e2ee_transparency_log
           WHERE organization_id = ? AND account_id = ?`,
        )
        .get(organizationId, accountId) as { next: number }
    ).next,
  );
  const payload = e2eeTransparencyPayload(kind, value);
  const payloadJson = canonicalE2eeJson(payload);
  database
    .prepare(
      `INSERT INTO e2ee_transparency_log
       (organization_id, account_id, account_sequence, event_kind,
        payload_json, leaf_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      organizationId,
      accountId,
      next,
      kind,
      payloadJson,
      e2eeTransparencyLeafHash(payload),
    );
  return next;
}

function normalizeRoot(
  input: E2eeAccountRootRegistration,
  nowMs: number,
): E2eeAccountRootRegistration {
  const root: E2eeAccountRootRegistration = {
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    organizationId: requireIdentifier(input.organizationId, 'organization id'),
    accountId: requireIdentifier(input.accountId, 'account id'),
    rootSigningPublicKey: normalizeE2eePublicKey(input.rootSigningPublicKey),
    recoveryPublicKey: normalizeE2eePublicKey(input.recoveryPublicKey),
    issuedAt: requireFreshTime(
      input.issuedAt,
      'E2EE root issue time',
      nowMs,
      REGISTRATION_MAX_AGE_MS,
    ),
    nonce: requireNonce(input.nonce),
    signature: requireText(input.signature, 'E2EE root signature', 256),
    recoverySignature: requireText(
      input.recoverySignature,
      'E2EE recovery proof signature',
      256,
    ),
  };
  const {
    signature: _signature,
    recoverySignature: _recoverySignature,
    ...unsignedRoot
  } = root;
  if (
    input.protocolId !== OTTO_E2EE_PROTOCOL_ID ||
    input.trustVersion !== OTTO_E2EE_TRUST_VERSION ||
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
  return root;
}

function normalizeDevice(
  input: E2eeDeviceRegistration,
  nowMs: number,
): E2eeDeviceRegistration {
  const issuedAt = requireFreshTime(
    input.issuedAt,
    'E2EE device issue time',
    nowMs,
    REGISTRATION_MAX_AGE_MS,
  );
  const expiresAt = requireIsoTime(input.expiresAt, 'E2EE device expiry');
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > DEVICE_MAX_LIFETIME_MS) {
    throw new Error('E2EE device credential lifetime is invalid');
  }
  const device: E2eeDeviceRegistration = {
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    organizationId: requireIdentifier(input.organizationId, 'organization id'),
    accountId: requireIdentifier(input.accountId, 'account id'),
    deviceId: requireIdentifier(input.deviceId, 'device id'),
    deviceName: requireText(input.deviceName, 'device name', 120),
    signingPublicKey: normalizeE2eePublicKey(input.signingPublicKey),
    mlsKeyPackage: requireKeyPackage(input.mlsKeyPackage),
    issuedAt,
    expiresAt,
    nonce: requireNonce(input.nonce),
    signature: requireText(input.signature, 'E2EE device signature', 256),
  };
  const {
    signature: _signature,
    bootstrap: _bootstrap,
    ...unsignedDevice
  } = device;
  if (
    input.protocolId !== OTTO_E2EE_PROTOCOL_ID ||
    input.trustVersion !== OTTO_E2EE_TRUST_VERSION ||
    !verifyE2eeSignature(
      deviceRegistrationSigningPayload(unsignedDevice),
      device.signature,
      device.signingPublicKey,
    )
  ) {
    throw new Error('E2EE device registration signature is invalid');
  }
  return device;
}

function rootView(row: RootRow): E2eeAccountRootView {
  return {
    protocolId: row.protocol_id,
    trustVersion: row.trust_version,
    organizationId: row.organization_id,
    accountId: row.account_id,
    rootKeyId: row.root_key_id,
    rootSigningPublicKey: row.root_signing_public_key,
    recoveryPublicKey: row.recovery_public_key,
    issuedAt: row.issued_at,
    nonce: row.nonce,
    signature: row.signature,
    recoverySignature: row.recovery_signature,
    transparencySequence: row.transparency_sequence,
  };
}

function deviceRegistrationFromRow(
  row: DeviceRow,
): Omit<E2eeDeviceRegistration, 'bootstrap'> {
  return {
    protocolId: row.protocol_id,
    trustVersion: row.trust_version,
    organizationId: row.organization_id,
    accountId: row.account_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    signingPublicKey: row.signing_public_key,
    mlsKeyPackage: row.mls_key_package,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    nonce: row.nonce,
    signature: row.signature,
  };
}

function proofFromRow(row: ProofRow): E2eeDeviceProof {
  const common = {
    organizationId: row.organization_id,
    accountId: row.account_id,
    targetDeviceId: row.target_device_id,
    targetCredentialHash: row.target_credential_hash,
    issuedAt: row.issued_at,
    nonce: row.nonce,
    signature: row.signature,
  };
  if (row.proof_type === 'bootstrap') {
    return { type: 'bootstrap', ...common };
  }
  if (!row.actor_device_id) {
    throw new Error('stored E2EE device proof actor is missing');
  }
  return {
    type: row.proof_type,
    actorDeviceId: row.actor_device_id,
    ...common,
  };
}

function loadSnapshot(
  store: SecureMessagingRepositoryStore,
  organizationId: string,
  accountId: string,
): E2eeDeviceDirectorySnapshot {
  assertActiveAccount(store, accountId, organizationId);
  const database = store.db();
  const rootRow = database
    .prepare(
      `SELECT * FROM e2ee_account_roots
       WHERE organization_id = ? AND account_id = ?`,
    )
    .get(organizationId, accountId) as RootRow | undefined;
  if (!rootRow) throw new Error('E2EE account trust root is not registered');
  const deviceRows = database
    .prepare(
      `SELECT * FROM e2ee_devices
       WHERE organization_id = ? AND account_id = ?
       ORDER BY transparency_sequence`,
    )
    .all(organizationId, accountId) as DeviceRow[];
  const proofRows = database
    .prepare(
      `SELECT * FROM e2ee_device_proofs
       WHERE organization_id = ? AND account_id = ?
       ORDER BY transparency_sequence`,
    )
    .all(organizationId, accountId) as ProofRow[];
  const transparencyRows = database
    .prepare(
      `SELECT account_sequence, event_kind, payload_json, leaf_hash
       FROM e2ee_transparency_log
       WHERE organization_id = ? AND account_id = ?
       ORDER BY account_sequence`,
    )
    .all(organizationId, accountId) as TransparencyRow[];
  const proofViews: E2eeDeviceProofView[] = proofRows.map((row) => ({
    proofId: row.proof_id,
    proof: proofFromRow(row),
    transparencySequence: row.transparency_sequence,
  }));

  const rawStates = new Map<string, E2eeDeviceView['state']>(
    deviceRows.map((row) => [row.device_id, 'pending']),
  );
  for (const entry of proofViews) {
    if (entry.proof.type === 'revocation') {
      rawStates.set(entry.proof.targetDeviceId, 'revoked');
    } else {
      rawStates.set(entry.proof.targetDeviceId, 'approved');
    }
  }
  const devices: E2eeDeviceView[] = deviceRows.map((row) => ({
    ...deviceRegistrationFromRow(row),
    bootstrap: undefined,
    credentialHash: row.credential_hash,
    state:
      rawStates.get(row.device_id) !== 'revoked' &&
      Date.parse(row.expires_at) <= store.now()
        ? 'expired'
        : rawStates.get(row.device_id)!,
    transparencySequence: row.transparency_sequence,
  }));
  const leaves: E2eeTransparencyLeaf[] = transparencyRows.map((row) => ({
    accountSequence: row.account_sequence,
    kind: row.event_kind,
    payload: JSON.parse(row.payload_json) as unknown,
    leafHash: row.leaf_hash,
  }));
  const snapshot: E2eeDeviceDirectorySnapshot = {
    protocolId: OTTO_E2EE_PROTOCOL_ID,
    trustVersion: OTTO_E2EE_TRUST_VERSION,
    organizationId,
    accountId,
    root: rootView(rootRow),
    devices,
    proofs: proofViews,
    transparency: {
      checkpoint: {
        size: leaves.length,
        rootHash: e2eeMerkleRoot(leaves.map((leaf) => leaf.leafHash)),
      },
      leaves,
    },
  };
  verifyE2eeDeviceDirectorySnapshot(snapshot, { nowMs: store.now() });
  return snapshot;
}

export function registerE2eeAccountRootInRepository(
  store: SecureMessagingRepositoryStore,
  input: E2eeAccountRootRegistration,
): E2eeDeviceDirectorySnapshot {
  const root = normalizeRoot(input, store.now());
  assertActiveAccount(store, root.accountId, root.organizationId);
  const database = store.db();
  return withTransaction(database, () => {
    const existing = database
      .prepare(
        `SELECT * FROM e2ee_account_roots
         WHERE organization_id = ? AND account_id = ?`,
      )
      .get(root.organizationId, root.accountId) as RootRow | undefined;
    if (existing) {
      if (
        canonicalE2eeJson(rootView(existing)) !==
        canonicalE2eeJson({
          ...root,
          rootKeyId: existing.root_key_id,
          transparencySequence: existing.transparency_sequence,
        })
      ) {
        throw new Error('E2EE account trust root is already registered');
      }
      return loadSnapshot(store, root.organizationId, root.accountId);
    }
    const transparencySequence = appendTransparencyLeaf(
      database,
      root.organizationId,
      root.accountId,
      'account_root_registered',
      root,
    );
    database
      .prepare(
        `INSERT INTO e2ee_account_roots
         (organization_id, account_id, protocol_id, trust_version, root_key_id,
          root_signing_public_key, recovery_public_key, issued_at, nonce,
          signature, recovery_signature, transparency_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        root.organizationId,
        root.accountId,
        root.protocolId,
        root.trustVersion,
        e2eePublicKeyId(root.rootSigningPublicKey),
        root.rootSigningPublicKey,
        root.recoveryPublicKey,
        root.issuedAt,
        root.nonce,
        root.signature,
        root.recoverySignature,
        transparencySequence,
      );
    return loadSnapshot(store, root.organizationId, root.accountId);
  });
}

export function registerE2eeDeviceInRepository(
  store: SecureMessagingRepositoryStore,
  input: E2eeDeviceRegistration,
): E2eeDeviceDirectorySnapshot {
  const device = normalizeDevice(input, store.now());
  assertActiveAccount(store, device.accountId, device.organizationId);
  const database = store.db();
  return withTransaction(database, () => {
    const root = database
      .prepare(
        `SELECT * FROM e2ee_account_roots
         WHERE organization_id = ? AND account_id = ?`,
      )
      .get(device.organizationId, device.accountId) as RootRow | undefined;
    if (!root) throw new Error('E2EE account trust root is not registered');
    const existing = database
      .prepare(
        `SELECT device_id FROM e2ee_devices
         WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
      )
      .get(device.organizationId, device.accountId, device.deviceId);
    if (existing) throw new Error('E2EE device id is already registered');
    const {
      signature: _signature,
      bootstrap: _bootstrap,
      ...unsignedDevice
    } = device;
    const credentialHash = deviceCredentialHash(unsignedDevice);
    const hasDevice = Boolean(
      database
        .prepare(
          `SELECT 1 FROM e2ee_devices
           WHERE organization_id = ? AND account_id = ? LIMIT 1`,
        )
        .get(device.organizationId, device.accountId),
    );
    if (!hasDevice && !input.bootstrap) {
      throw new Error('first E2EE device requires a root-signed bootstrap proof');
    }
    if (hasDevice && input.bootstrap) {
      throw new Error('E2EE root bootstrap cannot approve an additional device');
    }
    let bootstrap: E2eeDeviceProof | null = null;
    if (input.bootstrap) {
      if (
        input.bootstrap.type !== 'bootstrap' ||
        input.bootstrap.organizationId !== device.organizationId ||
        input.bootstrap.accountId !== device.accountId ||
        input.bootstrap.targetDeviceId !== device.deviceId ||
        input.bootstrap.targetCredentialHash !== credentialHash
      ) {
        throw new Error('E2EE bootstrap proof target does not match device');
      }
      bootstrap = {
        type: 'bootstrap',
        organizationId: device.organizationId,
        accountId: device.accountId,
        targetDeviceId: device.deviceId,
        targetCredentialHash: credentialHash,
        issuedAt: requireFreshTime(
          input.bootstrap.issuedAt,
          'E2EE bootstrap proof time',
          store.now(),
          PROOF_MAX_AGE_MS,
        ),
        nonce: requireNonce(input.bootstrap.nonce),
        signature: requireText(
          input.bootstrap.signature,
          'E2EE bootstrap signature',
          256,
        ),
      };
      if (
        !verifyE2eeSignature(
          deviceProofSigningPayload(bootstrap),
          bootstrap.signature,
          root.root_signing_public_key,
        )
      ) {
        throw new Error('E2EE bootstrap proof signature is invalid');
      }
    }
    const transparencySequence = appendTransparencyLeaf(
      database,
      device.organizationId,
      device.accountId,
      'device_registered',
      device,
    );
    database
      .prepare(
        `INSERT INTO e2ee_devices
         (organization_id, account_id, device_id, protocol_id, trust_version,
          device_name, signing_public_key, mls_key_package, credential_hash,
          issued_at, expires_at, nonce, signature, transparency_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        device.organizationId,
        device.accountId,
        device.deviceId,
        device.protocolId,
        device.trustVersion,
        device.deviceName,
        device.signingPublicKey,
        device.mlsKeyPackage,
        credentialHash,
        device.issuedAt,
        device.expiresAt,
        device.nonce,
        device.signature,
        transparencySequence,
      );
    if (bootstrap) insertProof(database, bootstrap);
    return loadSnapshot(store, device.organizationId, device.accountId);
  });
}

function insertProof(database: Database, proof: E2eeDeviceProof): void {
  const proofId = e2eeProofId(proof);
  const kind: E2eeTransparencyEventKind =
    proof.type === 'bootstrap'
      ? 'device_bootstrapped'
      : proof.type === 'approval'
        ? 'device_approved'
        : 'device_revoked';
  const transparencySequence = appendTransparencyLeaf(
    database,
    proof.organizationId,
    proof.accountId,
    kind,
    proof,
  );
  database
    .prepare(
      `INSERT INTO e2ee_device_proofs
       (proof_id, organization_id, account_id, proof_type, actor_device_id,
        target_device_id, target_credential_hash, issued_at, nonce, signature,
        transparency_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      proofId,
      proof.organizationId,
      proof.accountId,
      proof.type,
      proof.type === 'bootstrap' ? null : proof.actorDeviceId,
      proof.targetDeviceId,
      proof.targetCredentialHash,
      proof.issuedAt,
      proof.nonce,
      proof.signature,
      transparencySequence,
    );
}

function normalizeDeviceProof(
  input: E2eeDeviceApprovalProof | E2eeDeviceRevocationProof,
  store: SecureMessagingRepositoryStore,
): E2eeDeviceApprovalProof | E2eeDeviceRevocationProof {
  return {
    type: input.type,
    organizationId: requireIdentifier(input.organizationId, 'organization id'),
    accountId: requireIdentifier(input.accountId, 'account id'),
    actorDeviceId: requireIdentifier(input.actorDeviceId, 'actor device id'),
    targetDeviceId: requireIdentifier(input.targetDeviceId, 'target device id'),
    targetCredentialHash: requireText(
      input.targetCredentialHash,
      'target credential hash',
      64,
    ),
    issuedAt: requireFreshTime(
      input.issuedAt,
      'E2EE device proof time',
      store.now(),
      PROOF_MAX_AGE_MS,
    ),
    nonce: requireNonce(input.nonce),
    signature: requireText(input.signature, 'E2EE device proof signature', 256),
  };
}

function applyDeviceProof(
  store: SecureMessagingRepositoryStore,
  rawProof: E2eeDeviceApprovalProof | E2eeDeviceRevocationProof,
): E2eeDeviceDirectorySnapshot {
  const proof = normalizeDeviceProof(rawProof, store);
  assertActiveAccount(store, proof.accountId, proof.organizationId);
  const database = store.db();
  return withTransaction(database, () => {
    const snapshot = loadSnapshot(store, proof.organizationId, proof.accountId);
    const actor = snapshot.devices.find(
      (device) => device.deviceId === proof.actorDeviceId,
    );
    const target = snapshot.devices.find(
      (device) => device.deviceId === proof.targetDeviceId,
    );
    if (!actor || actor.state !== 'approved') {
      throw new Error('E2EE device proof actor is not approved');
    }
    if (!target || target.credentialHash !== proof.targetCredentialHash) {
      throw new Error('E2EE device proof target credential does not match');
    }
    if (
      (proof.type === 'approval' && target.state !== 'pending') ||
      (proof.type === 'revocation' && target.state !== 'approved')
    ) {
      throw new Error(`E2EE device cannot transition to ${proof.type}`);
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
    insertProof(database, proof);
    return loadSnapshot(store, proof.organizationId, proof.accountId);
  });
}

export function approveE2eeDeviceInRepository(
  store: SecureMessagingRepositoryStore,
  proof: E2eeDeviceApprovalProof,
): E2eeDeviceDirectorySnapshot {
  return applyDeviceProof(store, proof);
}

export function revokeE2eeDeviceInRepository(
  store: SecureMessagingRepositoryStore,
  proof: E2eeDeviceRevocationProof,
): E2eeDeviceDirectorySnapshot {
  return applyDeviceProof(store, proof);
}

export function getE2eeDeviceDirectoryFromRepository(
  store: SecureMessagingRepositoryStore,
  organizationId: string,
  accountId: string,
): E2eeDeviceDirectorySnapshot {
  return loadSnapshot(
    store,
    requireIdentifier(organizationId, 'organization id'),
    requireIdentifier(accountId, 'account id'),
  );
}

export function getE2eeTransparencyInclusionProofFromRepository(
  store: SecureMessagingRepositoryStore,
  organizationId: string,
  accountId: string,
  accountSequence: number,
): E2eeTransparencyInclusionProof {
  const snapshot = getE2eeDeviceDirectoryFromRepository(
    store,
    organizationId,
    accountId,
  );
  const index = accountSequence - 1;
  return {
    accountSequence,
    checkpoint: snapshot.transparency.checkpoint,
    nodes: e2eeMerkleInclusionProof(
      snapshot.transparency.leaves.map((leaf) => leaf.leafHash),
      index,
    ),
  };
}
