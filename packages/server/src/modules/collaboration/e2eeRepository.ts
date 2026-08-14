/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * The server-side half of private-chat E2EE. This module validates device
 * ownership, signatures and envelope coverage, but deliberately has no API
 * capable of decrypting a message or attachment.
 */

import { createHash, createPublicKey, verify } from 'node:crypto';

import type { Database, EncryptedObjectStore } from '../data_platform/index.js';

export const E2EE_PROTOCOL_VERSION = 1 as const;
export const E2EE_MESSAGE_MAX_CIPHERTEXT_BYTES = 64 * 1024;
export const E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024 + 16;
export const E2EE_ATTACHMENT_MAX_COUNT = 6;

export type E2eeContentType = 'message' | 'atoa_request' | 'atoa_response';

export interface E2eeRepositoryStore {
  db(): Database;
  attachmentObjectStore?: EncryptedObjectStore;
  getActiveAccountInOrganization(
    accountId: string,
    organizationId: string,
  ): { id: string; name: string } | null;
}

export interface E2eeDeviceRegistrationInput {
  organizationId: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
}

export interface E2eeDeviceView {
  accountId: string;
  deviceId: string;
  deviceName: string;
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
  keyFingerprint: string;
  approvalState: 'pending' | 'approved';
  approvedByDeviceId: string | null;
  approvedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export type E2eeKeyTransparencyEvent =
  'bootstrap_approved' | 'registered_pending' | 'approved' | 'revoked';

export interface E2eeKeyTransparencyEntry {
  sequence: number;
  accountId: string;
  deviceId: string;
  event: E2eeKeyTransparencyEvent;
  keyFingerprint: string;
  actorDeviceId: string | null;
  previousHash: string;
  entryHash: string;
  createdAt: string;
}

export interface E2eeKeyTransparencyView {
  accountId: string;
  headSequence: number;
  headHash: string;
  entries: E2eeKeyTransparencyEntry[];
}

export interface E2eeDeviceApprovalInput {
  organizationId: string;
  accountId: string;
  approverDeviceId: string;
  targetDeviceId: string;
  targetKeyFingerprint: string;
  signature: string;
}

export interface E2eeMessageEnvelope {
  accountId: string;
  deviceId: string;
  ephemeralPublicKey: string;
  wrappedKey: string;
  nonce: string;
}

export interface E2eeAttachmentCiphertextInput {
  id: string;
  ciphertext: string;
  nonce: string;
}

export interface SendE2eeDirectMessageInput {
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  messageId: string;
  senderDeviceId: string;
  protocolVersion: 1;
  contentType: E2eeContentType;
  inReplyToMessageId?: string | null;
  ciphertext: string;
  nonce: string;
  signature: string;
  envelopes: E2eeMessageEnvelope[];
  attachments?: E2eeAttachmentCiphertextInput[];
}

export interface E2eeAttachmentCiphertextView {
  id: string;
  ciphertextSize: number;
  nonce: string;
}

export interface E2eeDirectMessageView {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  senderDeviceId: string;
  senderIdentitySigningPublicKey: string;
  protocolVersion: 1;
  contentType: E2eeContentType;
  inReplyToMessageId: string | null;
  ciphertext: string;
  nonce: string;
  signature: string;
  envelopes: E2eeMessageEnvelope[];
  createdAt: string;
  readAt: string | null;
  attachments: E2eeAttachmentCiphertextView[];
}

export interface E2eeAttachmentDownload {
  message: E2eeDirectMessageView;
  attachment: {
    id: string;
    ciphertext: string;
    nonce: string;
  };
}

interface DeviceRow {
  organization_id: string;
  account_id: string;
  device_id: string;
  device_name: string;
  identity_signing_public_key: string;
  device_exchange_public_key: string;
  key_fingerprint: string;
  approval_state: 'pending' | 'approved';
  approved_by_device_id: string | null;
  approved_at: string | null;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

interface TransparencyRow {
  sequence: number;
  account_id: string;
  device_id: string;
  event: E2eeKeyTransparencyEvent;
  key_fingerprint: string;
  actor_device_id: string | null;
  previous_hash: string;
  entry_hash: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  organization_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  content_type: E2eeContentType;
  e2ee_protocol_version: number;
  e2ee_sender_device_id: string;
  e2ee_ciphertext: string;
  e2ee_nonce: string;
  e2ee_signature: string;
  e2ee_envelopes_json: string;
  in_reply_to_message_id: string | null;
  created_at: string;
  read_at: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  byte_size: number;
  content: Uint8Array;
  storage_backend: string;
  storage_key: string | null;
  e2ee_nonce: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireBase64(
  value: string,
  label: string,
  maximumBytes: number,
): Buffer {
  const normalized = value.trim();
  if (!normalized || normalized.length > Math.ceil(maximumBytes / 3) * 4 + 8) {
    throw new Error(`${label} is invalid`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (
    !decoded.length ||
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== normalized
  ) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
}

function requireNonce(value: string, label: string): string {
  const decoded = requireBase64(value, label, 12);
  if (decoded.length !== 12) throw new Error(`${label} must be 12 bytes`);
  return value;
}

function requirePublicKey(
  value: string,
  expectedType: 'ed25519' | 'x25519',
  label: string,
): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error(`${label} is invalid`);
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== expectedType) throw new Error('wrong type');
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error(`${label} must be a valid ${expectedType} public key`);
  }
}

const KEY_FINGERPRINT = /^[0-9a-f]{64}$/;
const EMPTY_TRANSPARENCY_HASH = '0'.repeat(64);

export function e2eeDeviceKeyFingerprint(input: {
  identitySigningPublicKey: string;
  deviceExchangePublicKey: string;
}): string {
  const signing = requirePublicKey(
    input.identitySigningPublicKey,
    'ed25519',
    'identity signing public key',
  );
  const exchange = requirePublicKey(
    input.deviceExchangePublicKey,
    'x25519',
    'device exchange public key',
  );
  return createHash('sha256')
    .update('otto:e2ee-device-fingerprint:v1\n')
    .update(signing)
    .update('\n')
    .update(exchange)
    .digest('hex');
}

function requireKeyFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!KEY_FINGERPRINT.test(normalized)) {
    throw new Error('E2EE device key fingerprint is invalid');
  }
  return normalized;
}

export function e2eeDeviceApprovalSignaturePayload(
  input: Omit<E2eeDeviceApprovalInput, 'signature'>,
): Buffer {
  const payload = {
    organizationId: requireIdentifier(input.organizationId, 'organization id'),
    accountId: requireIdentifier(input.accountId, 'account id'),
    approverDeviceId: requireIdentifier(
      input.approverDeviceId,
      'approver device id',
    ),
    targetDeviceId: requireIdentifier(input.targetDeviceId, 'target device id'),
    targetKeyFingerprint: requireKeyFingerprint(input.targetKeyFingerprint),
  };
  return Buffer.from(
    `otto:e2ee-device-approval:v1\n${JSON.stringify(payload)}`,
    'utf8',
  );
}

function transparencyEntryHash(input: {
  sequence: number;
  organizationId: string;
  accountId: string;
  deviceId: string;
  event: E2eeKeyTransparencyEvent;
  keyFingerprint: string;
  actorDeviceId: string | null;
  previousHash: string;
  createdAt: string;
}): string {
  return createHash('sha256')
    .update('otto:e2ee-key-transparency:v1\n')
    .update(JSON.stringify(input))
    .digest('hex');
}

function atomicDeviceMutation<T>(database: Database, operation: () => T): T {
  const nested = database.inTransaction;
  database.exec(
    nested ? 'SAVEPOINT otto_e2ee_device_mutation' : 'BEGIN IMMEDIATE',
  );
  try {
    const result = operation();
    database.exec(nested ? 'RELEASE otto_e2ee_device_mutation' : 'COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec(
        nested
          ? 'ROLLBACK TO otto_e2ee_device_mutation; RELEASE otto_e2ee_device_mutation'
          : 'ROLLBACK',
      );
    } catch {
      // Preserve the mutation error.
    }
    throw error;
  }
}

function appendTransparencyEntry(
  database: Database,
  input: {
    organizationId: string;
    accountId: string;
    deviceId: string;
    event: E2eeKeyTransparencyEvent;
    keyFingerprint: string;
    actorDeviceId: string | null;
    createdAt: string;
  },
): E2eeKeyTransparencyEntry {
  const previous = database
    .prepare(
      `SELECT sequence, entry_hash FROM e2ee_key_transparency_log
       WHERE organization_id = ? AND account_id = ?
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(input.organizationId, input.accountId) as
    { sequence: number; entry_hash: string } | undefined;
  const sequence = Number(previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entry_hash ?? EMPTY_TRANSPARENCY_HASH;
  const entryHash = transparencyEntryHash({
    sequence,
    organizationId: input.organizationId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    event: input.event,
    keyFingerprint: input.keyFingerprint,
    actorDeviceId: input.actorDeviceId,
    previousHash,
    createdAt: input.createdAt,
  });
  database
    .prepare(
      `INSERT INTO e2ee_key_transparency_log
         (organization_id, sequence, account_id, device_id, event,
          key_fingerprint, actor_device_id, previous_hash, entry_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.organizationId,
      sequence,
      input.accountId,
      input.deviceId,
      input.event,
      input.keyFingerprint,
      input.actorDeviceId,
      previousHash,
      entryHash,
      input.createdAt,
    );
  return {
    sequence,
    accountId: input.accountId,
    deviceId: input.deviceId,
    event: input.event,
    keyFingerprint: input.keyFingerprint,
    actorDeviceId: input.actorDeviceId,
    previousHash,
    entryHash,
    createdAt: input.createdAt,
  };
}

function deviceView(row: DeviceRow): E2eeDeviceView {
  const keyFingerprint =
    row.key_fingerprint ||
    e2eeDeviceKeyFingerprint({
      identitySigningPublicKey: row.identity_signing_public_key,
      deviceExchangePublicKey: row.device_exchange_public_key,
    });
  return {
    accountId: row.account_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    identitySigningPublicKey: row.identity_signing_public_key,
    deviceExchangePublicKey: row.device_exchange_public_key,
    keyFingerprint,
    approvalState: row.approval_state || 'approved',
    approvedByDeviceId: row.approved_by_device_id ?? null,
    approvedAt: row.approved_at ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function registerE2eeDeviceInRepository(
  store: E2eeRepositoryStore,
  input: E2eeDeviceRegistrationInput,
): E2eeDeviceView {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  const deviceId = requireIdentifier(input.deviceId, 'device id');
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('device account is not active in organization');
  }
  const deviceName = input.deviceName.trim().slice(0, 120);
  if (!deviceName) throw new Error('device name is required');
  const identitySigningPublicKey = requirePublicKey(
    input.identitySigningPublicKey,
    'ed25519',
    'identity signing public key',
  );
  const deviceExchangePublicKey = requirePublicKey(
    input.deviceExchangePublicKey,
    'x25519',
    'device exchange public key',
  );
  const keyFingerprint = e2eeDeviceKeyFingerprint({
    identitySigningPublicKey,
    deviceExchangePublicKey,
  });
  const database = store.db();
  return atomicDeviceMutation(database, () => {
    const existing = database
      .prepare(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
      )
      .get(organizationId, accountId, deviceId) as DeviceRow | undefined;
    if (
      existing &&
      (existing.identity_signing_public_key !== identitySigningPublicKey ||
        existing.device_exchange_public_key !== deviceExchangePublicKey)
    ) {
      throw new Error(
        'a registered device id cannot be rebound to different keys',
      );
    }
    if (existing) {
      database
        .prepare(
          `UPDATE e2ee_devices SET device_name = ?, last_seen_at = ?
           WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
        )
        .run(
          deviceName,
          new Date().toISOString(),
          organizationId,
          accountId,
          deviceId,
        );
    } else {
      const history = database
        .prepare(
          `SELECT COUNT(*) AS count FROM e2ee_devices
           WHERE organization_id = ? AND account_id = ?`,
        )
        .get(organizationId, accountId) as { count: number };
      const bootstrap = Number(history.count) === 0;
      const createdAt = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO e2ee_devices
             (organization_id, account_id, device_id, device_name,
              identity_signing_public_key, device_exchange_public_key,
              key_fingerprint, approval_state, approved_at, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          organizationId,
          accountId,
          deviceId,
          deviceName,
          identitySigningPublicKey,
          deviceExchangePublicKey,
          keyFingerprint,
          bootstrap ? 'approved' : 'pending',
          bootstrap ? createdAt : null,
          createdAt,
          createdAt,
        );
      appendTransparencyEntry(database, {
        organizationId,
        accountId,
        deviceId,
        event: bootstrap ? 'bootstrap_approved' : 'registered_pending',
        keyFingerprint,
        actorDeviceId: bootstrap ? deviceId : null,
        createdAt,
      });
    }
    return deviceView(
      database
        .prepare(
          `SELECT * FROM e2ee_devices
           WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
        )
        .get(organizationId, accountId, deviceId) as DeviceRow,
    );
  });
}

export function listE2eeDevicesInRepository(
  store: E2eeRepositoryStore,
  input: {
    organizationId: string;
    requesterAccountId: string;
    accountIds: string[];
    includeRevoked?: boolean;
    includePending?: boolean;
  },
): E2eeDeviceView[] {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const requesterAccountId = requireIdentifier(
    input.requesterAccountId,
    'requester account id',
  );
  if (
    !store.getActiveAccountInOrganization(requesterAccountId, organizationId)
  ) {
    throw new Error('requester account is not active in organization');
  }
  const accountIds = [
    ...new Set(
      input.accountIds.map((id) => requireIdentifier(id, 'account id')),
    ),
  ];
  if (accountIds.length === 0 || accountIds.length > 2) {
    throw new Error('one or two device accounts are required');
  }
  for (const accountId of accountIds) {
    if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
      throw new Error('device account is not active in organization');
    }
  }
  const placeholders = accountIds.map(() => '?').join(',');
  const includeRevoked =
    input.includeRevoked && accountIds.every((id) => id === requesterAccountId);
  const includePending =
    input.includePending && accountIds.every((id) => id === requesterAccountId);
  const rows = store
    .db()
    .prepare(
      `SELECT * FROM e2ee_devices
     WHERE organization_id = ? AND account_id IN (${placeholders})
       ${includeRevoked ? '' : 'AND revoked_at IS NULL'}
       ${includePending ? '' : "AND approval_state = 'approved'"}
     ORDER BY account_id, created_at, device_id`,
    )
    .all(organizationId, ...accountIds) as DeviceRow[];
  return rows.map(deviceView);
}

export function revokeE2eeDeviceInRepository(
  store: E2eeRepositoryStore,
  input: { organizationId: string; accountId: string; deviceId: string },
): boolean {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  const deviceId = requireIdentifier(input.deviceId, 'device id');
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('device account is not active in organization');
  }
  const database = store.db();
  return atomicDeviceMutation(database, () => {
    const device = database
      .prepare(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
      )
      .get(organizationId, accountId, deviceId) as DeviceRow | undefined;
    if (!device || device.revoked_at) return false;
    const revokedAt = new Date().toISOString();
    const result = database
      .prepare(
        `UPDATE e2ee_devices SET revoked_at = ?
         WHERE organization_id = ? AND account_id = ? AND device_id = ?
           AND revoked_at IS NULL`,
      )
      .run(revokedAt, organizationId, accountId, deviceId);
    if (Number(result.changes) !== 1) return false;
    appendTransparencyEntry(database, {
      organizationId,
      accountId,
      deviceId,
      event: 'revoked',
      keyFingerprint:
        device.key_fingerprint ||
        e2eeDeviceKeyFingerprint({
          identitySigningPublicKey: device.identity_signing_public_key,
          deviceExchangePublicKey: device.device_exchange_public_key,
        }),
      actorDeviceId: null,
      createdAt: revokedAt,
    });
    return true;
  });
}

export function approveE2eeDeviceInRepository(
  store: E2eeRepositoryStore,
  rawInput: E2eeDeviceApprovalInput,
): E2eeDeviceView {
  const unsigned = {
    organizationId: requireIdentifier(
      rawInput.organizationId,
      'organization id',
    ),
    accountId: requireIdentifier(rawInput.accountId, 'account id'),
    approverDeviceId: requireIdentifier(
      rawInput.approverDeviceId,
      'approver device id',
    ),
    targetDeviceId: requireIdentifier(
      rawInput.targetDeviceId,
      'target device id',
    ),
    targetKeyFingerprint: requireKeyFingerprint(rawInput.targetKeyFingerprint),
  };
  if (unsigned.approverDeviceId === unsigned.targetDeviceId) {
    throw new Error('a pending device cannot approve itself');
  }
  if (
    !store.getActiveAccountInOrganization(
      unsigned.accountId,
      unsigned.organizationId,
    )
  ) {
    throw new Error('device account is not active in organization');
  }
  const signature = requireBase64(
    rawInput.signature,
    'device approval signature',
    128,
  );
  const database = store.db();
  return atomicDeviceMutation(database, () => {
    const approver = database
      .prepare(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = ? AND account_id = ? AND device_id = ?
           AND approval_state = 'approved' AND revoked_at IS NULL`,
      )
      .get(
        unsigned.organizationId,
        unsigned.accountId,
        unsigned.approverDeviceId,
      ) as DeviceRow | undefined;
    if (!approver)
      throw new Error('approver E2EE device is not active and approved');
    const target = database
      .prepare(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = ? AND account_id = ? AND device_id = ?
           AND revoked_at IS NULL`,
      )
      .get(
        unsigned.organizationId,
        unsigned.accountId,
        unsigned.targetDeviceId,
      ) as DeviceRow | undefined;
    if (!target) throw new Error('pending E2EE device is unavailable');
    const targetFingerprint =
      target.key_fingerprint ||
      e2eeDeviceKeyFingerprint({
        identitySigningPublicKey: target.identity_signing_public_key,
        deviceExchangePublicKey: target.device_exchange_public_key,
      });
    if (targetFingerprint !== unsigned.targetKeyFingerprint) {
      throw new Error('pending E2EE device fingerprint changed');
    }
    if (
      !verify(
        null,
        e2eeDeviceApprovalSignaturePayload(unsigned),
        approver.identity_signing_public_key,
        signature,
      )
    ) {
      throw new Error('E2EE device approval signature is invalid');
    }
    if (target.approval_state === 'approved') return deviceView(target);
    const approvedAt = new Date().toISOString();
    database
      .prepare(
        `UPDATE e2ee_devices
         SET approval_state = 'approved', approved_by_device_id = ?, approved_at = ?
         WHERE organization_id = ? AND account_id = ? AND device_id = ?
           AND approval_state = 'pending' AND revoked_at IS NULL`,
      )
      .run(
        unsigned.approverDeviceId,
        approvedAt,
        unsigned.organizationId,
        unsigned.accountId,
        unsigned.targetDeviceId,
      );
    appendTransparencyEntry(database, {
      organizationId: unsigned.organizationId,
      accountId: unsigned.accountId,
      deviceId: unsigned.targetDeviceId,
      event: 'approved',
      keyFingerprint: targetFingerprint,
      actorDeviceId: unsigned.approverDeviceId,
      createdAt: approvedAt,
    });
    return deviceView(
      database
        .prepare(
          `SELECT * FROM e2ee_devices
           WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
        )
        .get(
          unsigned.organizationId,
          unsigned.accountId,
          unsigned.targetDeviceId,
        ) as DeviceRow,
    );
  });
}

export function listE2eeKeyTransparencyInRepository(
  store: E2eeRepositoryStore,
  input: {
    organizationId: string;
    requesterAccountId: string;
    accountId: string;
  },
): E2eeKeyTransparencyView {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const requesterAccountId = requireIdentifier(
    input.requesterAccountId,
    'requester account id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  if (
    !store.getActiveAccountInOrganization(requesterAccountId, organizationId) ||
    !store.getActiveAccountInOrganization(accountId, organizationId)
  ) {
    throw new Error('key transparency account is not active in organization');
  }
  const rows = store
    .db()
    .prepare(
      `SELECT * FROM e2ee_key_transparency_log
       WHERE organization_id = ? AND account_id = ? ORDER BY sequence`,
    )
    .all(organizationId, accountId) as TransparencyRow[];
  let previousHash = EMPTY_TRANSPARENCY_HASH;
  const entries = rows.map((row, index) => {
    const entry: E2eeKeyTransparencyEntry = {
      sequence: Number(row.sequence),
      accountId: row.account_id,
      deviceId: row.device_id,
      event: row.event,
      keyFingerprint: row.key_fingerprint,
      actorDeviceId: row.actor_device_id,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
      createdAt: row.created_at,
    };
    const expectedHash = transparencyEntryHash({
      sequence: entry.sequence,
      organizationId,
      accountId: entry.accountId,
      deviceId: entry.deviceId,
      event: entry.event,
      keyFingerprint: entry.keyFingerprint,
      actorDeviceId: entry.actorDeviceId,
      previousHash: entry.previousHash,
      createdAt: entry.createdAt,
    });
    if (
      entry.sequence !== index + 1 ||
      entry.previousHash !== previousHash ||
      entry.entryHash !== expectedHash
    ) {
      throw new Error('E2EE key transparency log integrity check failed');
    }
    previousHash = entry.entryHash;
    return entry;
  });
  return {
    accountId,
    headSequence: entries.length,
    headHash: previousHash,
    entries,
  };
}

function envelopeDigest(envelopes: readonly E2eeMessageEnvelope[]): string {
  const canonical = [...envelopes]
    .sort((a, b) =>
      `${a.accountId}:${a.deviceId}`.localeCompare(
        `${b.accountId}:${b.deviceId}`,
      ),
    )
    .map((envelope) => ({
      accountId: envelope.accountId,
      deviceId: envelope.deviceId,
      ephemeralPublicKey: envelope.ephemeralPublicKey,
      wrappedKey: envelope.wrappedKey,
      nonce: envelope.nonce,
    }));
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('base64');
}

export function e2eeMessageSignaturePayload(
  input: Omit<SendE2eeDirectMessageInput, 'signature'>,
): Buffer {
  const body = {
    protocolVersion: input.protocolVersion,
    organizationId: input.organizationId,
    messageId: input.messageId,
    senderAccountId: input.senderAccountId,
    recipientAccountId: input.recipientAccountId,
    senderDeviceId: input.senderDeviceId,
    contentType: input.contentType,
    inReplyToMessageId: input.inReplyToMessageId ?? null,
    nonce: input.nonce,
    ciphertextHash: createHash('sha256')
      .update(Buffer.from(input.ciphertext, 'base64'))
      .digest('base64'),
    envelopeDigest: envelopeDigest(input.envelopes),
  };
  return Buffer.from(`otto-e2ee-message-v1\n${JSON.stringify(body)}`, 'utf8');
}

function normalizeEnvelope(envelope: E2eeMessageEnvelope): E2eeMessageEnvelope {
  return {
    accountId: requireIdentifier(envelope.accountId, 'envelope account id'),
    deviceId: requireIdentifier(envelope.deviceId, 'envelope device id'),
    ephemeralPublicKey: requirePublicKey(
      envelope.ephemeralPublicKey,
      'x25519',
      'envelope ephemeral public key',
    ),
    wrappedKey: requireBase64(envelope.wrappedKey, 'wrapped key', 128).toString(
      'base64',
    ),
    nonce: requireNonce(envelope.nonce, 'envelope nonce'),
  };
}

function normalizeAttachment(
  attachment: E2eeAttachmentCiphertextInput,
): E2eeAttachmentCiphertextInput & { bytes: Buffer } {
  const id = requireIdentifier(attachment.id, 'attachment id');
  const bytes = requireBase64(
    attachment.ciphertext,
    'attachment ciphertext',
    E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES,
  );
  if (bytes.length <= 16) throw new Error('attachment ciphertext is too short');
  return {
    id,
    ciphertext: bytes.toString('base64'),
    nonce: requireNonce(attachment.nonce, 'attachment nonce'),
    bytes,
  };
}

function parseEnvelopes(value: string): E2eeMessageEnvelope[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new Error('stored E2EE envelopes are invalid');
  return parsed as E2eeMessageEnvelope[];
}

function attachmentViews(
  database: Database,
  messageId: string,
): E2eeAttachmentCiphertextView[] {
  const rows = database
    .prepare(
      `SELECT id, byte_size, e2ee_nonce FROM direct_message_attachments
     WHERE message_id = ? ORDER BY ordinal, id`,
    )
    .all(messageId) as Array<{
    id: string;
    byte_size: number;
    e2ee_nonce: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    ciphertextSize: Number(row.byte_size) + 16,
    nonce: row.e2ee_nonce,
  }));
}

function messageView(
  database: Database,
  row: MessageRow,
  attachments = attachmentViews(database, row.id),
): E2eeDirectMessageView {
  if (row.e2ee_protocol_version !== E2EE_PROTOCOL_VERSION) {
    throw new Error('stored E2EE protocol version is unsupported');
  }
  const senderDevice = database
    .prepare(
      `SELECT identity_signing_public_key FROM e2ee_devices
     WHERE organization_id = ? AND account_id = ? AND device_id = ?`,
    )
    .get(
      row.organization_id,
      row.sender_account_id,
      row.e2ee_sender_device_id,
    ) as { identity_signing_public_key: string } | undefined;
  if (!senderDevice)
    throw new Error('stored E2EE sender device is unavailable');
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    recipientAccountId: row.recipient_account_id,
    senderDeviceId: row.e2ee_sender_device_id,
    senderIdentitySigningPublicKey: senderDevice.identity_signing_public_key,
    protocolVersion: E2EE_PROTOCOL_VERSION,
    contentType: row.content_type,
    inReplyToMessageId: row.in_reply_to_message_id,
    ciphertext: row.e2ee_ciphertext,
    nonce: row.e2ee_nonce,
    signature: row.e2ee_signature,
    envelopes: parseEnvelopes(row.e2ee_envelopes_json),
    createdAt: row.created_at,
    readAt: row.read_at,
    attachments,
  };
}

export function sendE2eeDirectMessageInRepository(
  store: E2eeRepositoryStore,
  rawInput: SendE2eeDirectMessageInput,
): E2eeDirectMessageView {
  if (rawInput.protocolVersion !== E2EE_PROTOCOL_VERSION) {
    throw new Error('E2EE protocol version is unsupported');
  }
  const input = {
    ...rawInput,
    organizationId: requireIdentifier(
      rawInput.organizationId,
      'organization id',
    ),
    senderAccountId: requireIdentifier(
      rawInput.senderAccountId,
      'sender account id',
    ),
    recipientAccountId: requireIdentifier(
      rawInput.recipientAccountId,
      'recipient account id',
    ),
    messageId: requireIdentifier(rawInput.messageId, 'message id'),
    senderDeviceId: requireIdentifier(
      rawInput.senderDeviceId,
      'sender device id',
    ),
  };
  if (input.senderAccountId === input.recipientAccountId) {
    throw new Error('sender and recipient must be different');
  }
  if (
    !store.getActiveAccountInOrganization(
      input.senderAccountId,
      input.organizationId,
    )
  ) {
    throw new Error('sender account is not active in organization');
  }
  if (
    !store.getActiveAccountInOrganization(
      input.recipientAccountId,
      input.organizationId,
    )
  ) {
    throw new Error('recipient account is not active in organization');
  }
  if (
    !['message', 'atoa_request', 'atoa_response'].includes(input.contentType)
  ) {
    throw new Error('E2EE content type is invalid');
  }
  const inReplyToMessageId = input.inReplyToMessageId
    ? requireIdentifier(input.inReplyToMessageId, 'reply message id')
    : null;
  if ((input.contentType === 'atoa_response') !== Boolean(inReplyToMessageId)) {
    throw new Error('A2A responses must reference exactly one request');
  }
  const ciphertext = requireBase64(
    input.ciphertext,
    'message ciphertext',
    E2EE_MESSAGE_MAX_CIPHERTEXT_BYTES,
  ).toString('base64');
  if (Buffer.from(ciphertext, 'base64').length <= 16) {
    throw new Error('message ciphertext is too short');
  }
  const nonce = requireNonce(input.nonce, 'message nonce');
  const signature = requireBase64(input.signature, 'message signature', 128);
  const envelopes = input.envelopes.map(normalizeEnvelope);
  const attachments = (input.attachments ?? []).map(normalizeAttachment);
  if (attachments.length > E2EE_ATTACHMENT_MAX_COUNT) {
    throw new Error('a message can contain at most 6 encrypted attachments');
  }
  const uniqueAttachmentIds = new Set(attachments.map((item) => item.id));
  if (uniqueAttachmentIds.size !== attachments.length) {
    throw new Error('encrypted attachment ids must be unique');
  }

  const database = store.db();
  const activeDevices = database
    .prepare(
      `SELECT * FROM e2ee_devices
     WHERE organization_id = ? AND account_id IN (?, ?)
       AND approval_state = 'approved' AND revoked_at IS NULL
     ORDER BY account_id, device_id`,
    )
    .all(
      input.organizationId,
      input.senderAccountId,
      input.recipientAccountId,
    ) as DeviceRow[];
  const senderDevice = activeDevices.find(
    (device) =>
      device.account_id === input.senderAccountId &&
      device.device_id === input.senderDeviceId,
  );
  if (!senderDevice)
    throw new Error('sender E2EE device is not registered or was revoked');
  if (
    !activeDevices.some(
      (device) => device.account_id === input.recipientAccountId,
    )
  ) {
    throw new Error('recipient has no active E2EE device');
  }
  const expectedEnvelopeIds = activeDevices
    .map((device) => `${device.account_id}:${device.device_id}`)
    .sort();
  const actualEnvelopeIds = envelopes
    .map((envelope) => `${envelope.accountId}:${envelope.deviceId}`)
    .sort();
  if (
    new Set(actualEnvelopeIds).size !== actualEnvelopeIds.length ||
    JSON.stringify(actualEnvelopeIds) !== JSON.stringify(expectedEnvelopeIds)
  ) {
    throw new Error(
      'message key envelopes must cover every active participant device exactly once',
    );
  }
  const signaturePayload = e2eeMessageSignaturePayload({
    ...input,
    inReplyToMessageId,
    ciphertext,
    nonce,
    envelopes,
    attachments,
  });
  if (
    !verify(
      null,
      signaturePayload,
      senderDevice.identity_signing_public_key,
      signature,
    )
  ) {
    throw new Error('message signature is invalid');
  }

  if (inReplyToMessageId) {
    const request = database
      .prepare(
        `SELECT id FROM direct_messages
       WHERE id = ? AND organization_id = ?
         AND sender_account_id = ? AND recipient_account_id = ?
         AND content_type = 'atoa_request' AND e2ee_protocol_version = 1`,
      )
      .get(
        inReplyToMessageId,
        input.organizationId,
        input.recipientAccountId,
        input.senderAccountId,
      );
    if (!request) throw new Error('referenced A2A request does not exist');
  }

  const storedObjectKeys: string[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO direct_messages
        (id, organization_id, sender_account_id, recipient_account_id, content,
         content_type, e2ee_protocol_version, e2ee_sender_device_id,
         e2ee_ciphertext, e2ee_nonce, e2ee_signature, e2ee_envelopes_json,
         in_reply_to_message_id)
       VALUES (?, ?, ?, ?, '[e2ee:v1]', ?, 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.messageId,
        input.organizationId,
        input.senderAccountId,
        input.recipientAccountId,
        input.contentType,
        input.senderDeviceId,
        ciphertext,
        nonce,
        signature.toString('base64'),
        JSON.stringify(envelopes),
        inReplyToMessageId,
      );
    const insertAttachment = database.prepare(
      `INSERT INTO direct_message_attachments
        (id, message_id, organization_id, ordinal, file_name, mime_type,
         byte_size, content, storage_backend, storage_key, e2ee_nonce)
       VALUES (?, ?, ?, ?, '[e2ee]', 'application/octet-stream', ?, ?, ?, ?, ?)`,
    );
    attachments.forEach((attachment, ordinal) => {
      const stored = store.attachmentObjectStore?.put({
        namespace: input.organizationId,
        objectId: attachment.id,
        content: attachment.bytes,
      });
      if (stored) storedObjectKeys.push(stored.key);
      insertAttachment.run(
        attachment.id,
        input.messageId,
        input.organizationId,
        ordinal,
        attachment.bytes.length - 16,
        stored ? Buffer.alloc(0) : attachment.bytes,
        stored?.backend ?? 'sqlite',
        stored?.key ?? null,
        attachment.nonce,
      );
    });
    if (inReplyToMessageId) {
      database
        .prepare(
          `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
         WHERE id = ? AND organization_id = ?`,
        )
        .run(inReplyToMessageId, input.organizationId);
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* preserve original error */
    }
    for (const key of storedObjectKeys) {
      try {
        store.attachmentObjectStore?.delete(key);
      } catch {
        /* orphan sweep */
      }
    }
    throw error;
  }
  return messageView(
    database,
    database
      .prepare('SELECT * FROM direct_messages WHERE id = ?')
      .get(input.messageId) as MessageRow,
  );
}

export function listE2eeDirectMessagesInRepository(
  store: E2eeRepositoryStore,
  input: {
    organizationId: string;
    accountId: string;
    peerAccountId: string;
    limit?: number;
  },
): E2eeDirectMessageView[] {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  const peerAccountId = requireIdentifier(
    input.peerAccountId,
    'peer account id',
  );
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('message account is not active in organization');
  }
  if (!store.getActiveAccountInOrganization(peerAccountId, organizationId)) {
    throw new Error('message peer is not active in organization');
  }
  const limit = Number.isFinite(input.limit)
    ? Math.min(200, Math.max(1, Math.floor(input.limit!)))
    : 100;
  const database = store.db();
  database
    .prepare(
      `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE organization_id = ? AND sender_account_id = ? AND recipient_account_id = ?
       AND e2ee_protocol_version = 1`,
    )
    .run(organizationId, peerAccountId, accountId);
  const rows = (
    database
      .prepare(
        `SELECT * FROM direct_messages
     WHERE organization_id = ? AND e2ee_protocol_version = 1 AND (
       (sender_account_id = ? AND recipient_account_id = ?) OR
       (sender_account_id = ? AND recipient_account_id = ?)
     ) ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        organizationId,
        accountId,
        peerAccountId,
        peerAccountId,
        accountId,
        limit,
      ) as MessageRow[]
  ).reverse();
  return rows.map((row) => messageView(database, row));
}

export function listPendingE2eeAtoaRequestsInRepository(
  store: E2eeRepositoryStore,
  input: { organizationId: string; accountId: string; limit?: number },
): Array<E2eeDirectMessageView & { peerAccountId: string }> {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('A2A account is not active in organization');
  }
  const limit = Number.isFinite(input.limit)
    ? Math.min(100, Math.max(1, Math.floor(input.limit!)))
    : 50;
  const database = store.db();
  const rows = database
    .prepare(
      `SELECT request.* FROM direct_messages request
     WHERE request.organization_id = ?
       AND request.recipient_account_id = ?
       AND request.content_type = 'atoa_request'
       AND request.e2ee_protocol_version = 1
       AND NOT EXISTS (
         SELECT 1 FROM direct_messages response
         WHERE response.organization_id = request.organization_id
           AND response.in_reply_to_message_id = request.id
           AND response.content_type = 'atoa_response'
           AND response.e2ee_protocol_version = 1
       )
     ORDER BY request.created_at, request.id LIMIT ?`,
    )
    .all(organizationId, accountId, limit) as MessageRow[];
  return rows.map((row) => ({
    ...messageView(database, row),
    peerAccountId: row.sender_account_id,
  }));
}

export function listUnreadE2eeNotificationsInRepository(
  store: E2eeRepositoryStore,
  input: { organizationId: string; accountId: string; limit?: number },
): Array<{
  id: string;
  source: 'enterprise';
  title: string;
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
}> {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('message account is not active in organization');
  }
  const limit = Number.isFinite(input.limit)
    ? Math.min(100, Math.max(1, Math.floor(input.limit!)))
    : 50;
  const rows = store
    .db()
    .prepare(
      `SELECT m.id, m.sender_account_id, m.created_at, a.name AS sender_name
     FROM direct_messages m
     JOIN accounts a ON a.id = m.sender_account_id
       AND a.organization_id = m.organization_id
     WHERE m.organization_id = ? AND m.recipient_account_id = ?
       AND m.read_at IS NULL AND m.e2ee_protocol_version = 1
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .all(organizationId, accountId, limit) as Array<{
    id: string;
    sender_account_id: string;
    sender_name: string;
    created_at: string;
  }>;
  return rows.reverse().map((row) => ({
    id: row.id,
    source: 'enterprise' as const,
    title: `${row.sender_name} sent an encrypted message`,
    senderAccountId: row.sender_account_id,
    senderName: row.sender_name,
    preview: 'End-to-end encrypted message',
    createdAt: row.created_at,
  }));
}

export function getE2eeAttachmentInRepository(
  store: E2eeRepositoryStore,
  input: { organizationId: string; accountId: string; attachmentId: string },
): E2eeAttachmentDownload {
  const organizationId = requireIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireIdentifier(input.accountId, 'account id');
  const attachmentId = requireIdentifier(input.attachmentId, 'attachment id');
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('attachment account is not active in organization');
  }
  const database = store.db();
  const row = database
    .prepare(
      `SELECT a.* FROM direct_message_attachments a
     JOIN direct_messages m ON m.id = a.message_id
     WHERE a.id = ? AND a.organization_id = ?
       AND m.e2ee_protocol_version = 1
       AND (m.sender_account_id = ? OR m.recipient_account_id = ?)`,
    )
    .get(attachmentId, organizationId, accountId, accountId) as
    AttachmentRow | undefined;
  if (!row) throw new Error('encrypted attachment not found or access denied');
  let ciphertext: Buffer;
  if (row.storage_backend === 'encrypted-filesystem') {
    if (!row.storage_key || !store.attachmentObjectStore) {
      throw new Error('attachment object storage is unavailable');
    }
    ciphertext = store.attachmentObjectStore.read(row.storage_key);
  } else if (row.storage_backend === 'sqlite') {
    ciphertext = Buffer.from(row.content);
  } else {
    throw new Error('attachment storage backend is unsupported');
  }
  const message = database
    .prepare('SELECT * FROM direct_messages WHERE id = ?')
    .get(row.message_id) as MessageRow;
  return {
    message: messageView(database, message),
    attachment: {
      id: row.id,
      ciphertext: ciphertext.toString('base64'),
      nonce: row.e2ee_nonce,
    },
  };
}

export function createE2eeFacade(store: E2eeRepositoryStore) {
  return {
    registerE2eeDevice: (input: E2eeDeviceRegistrationInput) =>
      registerE2eeDeviceInRepository(store, input),
    listE2eeDevices: (
      input: Parameters<typeof listE2eeDevicesInRepository>[1],
    ) => listE2eeDevicesInRepository(store, input),
    revokeE2eeDevice: (
      input: Parameters<typeof revokeE2eeDeviceInRepository>[1],
    ) => revokeE2eeDeviceInRepository(store, input),
    approveE2eeDevice: (input: E2eeDeviceApprovalInput) =>
      approveE2eeDeviceInRepository(store, input),
    listE2eeKeyTransparency: (
      input: Parameters<typeof listE2eeKeyTransparencyInRepository>[1],
    ) => listE2eeKeyTransparencyInRepository(store, input),
    sendE2eeDirectMessage: (input: SendE2eeDirectMessageInput) =>
      sendE2eeDirectMessageInRepository(store, input),
    listE2eeDirectMessages: (
      input: Parameters<typeof listE2eeDirectMessagesInRepository>[1],
    ) => listE2eeDirectMessagesInRepository(store, input),
    listPendingE2eeAtoaRequests: (
      input: Parameters<typeof listPendingE2eeAtoaRequestsInRepository>[1],
    ) => listPendingE2eeAtoaRequestsInRepository(store, input),
    listUnreadE2eeNotifications: (
      input: Parameters<typeof listUnreadE2eeNotificationsInRepository>[1],
    ) => listUnreadE2eeNotificationsInRepository(store, input),
    getE2eeAttachment: (
      input: Parameters<typeof getE2eeAttachmentInRepository>[1],
    ) => getE2eeAttachmentInRepository(store, input),
  };
}
