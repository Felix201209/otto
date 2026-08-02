/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Opaque MLS transport for enterprise private chat. The server validates
 * tenant, device, one-time KeyPackage, epoch and idempotency invariants. It
 * deliberately has no API or column capable of handling MLS plaintext or
 * client private key material.
 */

import { createHash } from 'node:crypto';

import type { Database } from '../data_platform/index.js';

export const MLS_CIPHERSUITE =
  'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' as const;
export const MLS_KEY_PACKAGE_MAX_BYTES = 64 * 1024;
export const MLS_TRANSPORT_PAYLOAD_MAX_BYTES = 1024 * 1024;

export interface MlsResourceGovernancePolicy {
  maxUnclaimedKeyPackagesPerDevice: number;
  maxUnclaimedKeyPackagesPerOrganization: number;
  maxTransportEventsPerConversation: number;
  maxTransportEventsPerOrganization: number;
  maxTransportEventBytesPerConversation: number;
  maxTransportEventBytesPerOrganization: number;
  keyPackagePublishesPerMinute: number;
  transportEventsPerMinute: number;
  keyPackageTtlMs: number;
  claimedKeyPackageTtlMs: number;
  transportEventTtlMs: number;
}

export const DEFAULT_MLS_RESOURCE_GOVERNANCE_POLICY: Readonly<MlsResourceGovernancePolicy> =
  Object.freeze({
    maxUnclaimedKeyPackagesPerDevice: 100,
    maxUnclaimedKeyPackagesPerOrganization: 10_000,
    maxTransportEventsPerConversation: 25_000,
    maxTransportEventsPerOrganization: 100_000,
    maxTransportEventBytesPerConversation: 256 * 1024 * 1024,
    maxTransportEventBytesPerOrganization: 1024 * 1024 * 1024,
    keyPackagePublishesPerMinute: 60,
    transportEventsPerMinute: 300,
    keyPackageTtlMs: 7 * 24 * 60 * 60 * 1_000,
    claimedKeyPackageTtlMs: 24 * 60 * 60 * 1_000,
    transportEventTtlMs: 90 * 24 * 60 * 60 * 1_000,
  });

export type MlsResourceRateAction =
  | 'key_package_publish'
  | 'transport_event_append';

export interface MlsResourceCleanupResult {
  eventsDeleted: number;
  keyPackagesDeleted: number;
  groupSessionsDeleted: number;
  rateBucketsDeleted: number;
  conversationsAdvanced: number;
}

export type MlsTransportEventType = 'welcome' | 'commit' | 'application';

export interface MlsTransportStore {
  db(): Database;
  now?(): number;
  mlsResourcePolicy?: Partial<MlsResourceGovernancePolicy>;
  getActiveAccountInOrganization(
    accountId: string,
    organizationId: string,
  ): { id: string; name: string } | null;
}

export interface PublishMlsKeyPackageInput {
  organizationId: string;
  accountId: string;
  deviceId: string;
  ciphersuite: typeof MLS_CIPHERSUITE;
  reference?: string;
  keyPackage: string;
}

export interface ClaimMlsKeyPackageInput {
  organizationId: string;
  requesterAccountId: string;
  requesterDeviceId: string;
  recipientAccountId: string;
}

export interface MlsKeyPackageView {
  reference: string;
  accountId: string;
  deviceId: string;
  ciphersuite: typeof MLS_CIPHERSUITE;
  keyPackage: string;
  createdAt: string;
  claimedAt: string | null;
  expiresAt: string;
}

export interface AppendMlsTransportEventInput {
  organizationId: string;
  senderAccountId: string;
  peerAccountId: string;
  senderDeviceId: string;
  eventId: string;
  eventType: MlsTransportEventType;
  epoch: number;
  groupId: string;
  payload: string;
  recipientDeviceId?: string | null;
  keyPackageReference?: string | null;
  resetFromGroupId?: string | null;
}

export interface MlsTransportEventView {
  sequence: number;
  eventId: string;
  conversationId: string;
  sessionGeneration: number;
  senderAccountId: string;
  senderDeviceId: string;
  recipientAccountId: string | null;
  recipientDeviceId: string | null;
  eventType: MlsTransportEventType;
  epoch: number;
  groupId: string;
  payload: string;
  keyPackageReference: string | null;
  createdAt: string;
  expiresAt: string;
}

interface KeyPackageRow {
  key_package_reference: string;
  account_id: string;
  device_id: string;
  ciphersuite: typeof MLS_CIPHERSUITE;
  key_package: string;
  created_at: string;
  claimed_at: string | null;
  claimed_by_account_id: string | null;
  claimed_by_device_id: string | null;
  welcome_event_id: string | null;
  expires_at: string;
}

interface ConversationRow {
  conversation_id: string;
  participant_a_account_id: string;
  participant_b_account_id: string;
  group_id: string;
  current_epoch: number;
  active_generation: number;
  retention_floor_sequence: number;
}

interface EventRow {
  sequence: number;
  id: string;
  conversation_id: string;
  session_generation: number;
  sender_account_id: string;
  sender_device_id: string;
  recipient_account_id: string | null;
  recipient_device_id: string | null;
  event_type: MlsTransportEventType;
  epoch: number;
  group_id: string;
  payload: string;
  key_package_reference: string | null;
  created_at: string;
  expires_at: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function positivePolicyInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`MLS resource policy ${label} is invalid`);
  }
  return value;
}

export function resolveMlsResourceGovernancePolicy(
  override: Partial<MlsResourceGovernancePolicy> = {},
): MlsResourceGovernancePolicy {
  const policy = { ...DEFAULT_MLS_RESOURCE_GOVERNANCE_POLICY, ...override };
  for (const [key, value] of Object.entries(policy)) {
    positivePolicyInteger(value, key);
  }
  if (
    policy.maxUnclaimedKeyPackagesPerOrganization <
    policy.maxUnclaimedKeyPackagesPerDevice
  ) {
    throw new Error(
      'MLS resource policy organization KeyPackage quota is invalid',
    );
  }
  if (
    policy.maxTransportEventsPerOrganization <
      policy.maxTransportEventsPerConversation ||
    policy.maxTransportEventBytesPerOrganization <
      policy.maxTransportEventBytesPerConversation
  ) {
    throw new Error('MLS resource policy organization event quota is invalid');
  }
  return policy;
}

function storeNow(store: MlsTransportStore): number {
  const value = (store.now ?? Date.now)();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MLS resource clock is invalid');
  }
  return value;
}

function isoTime(value: number): string {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new Error('MLS resource timestamp is invalid');
  }
  return result.toISOString();
}

export function requireMlsIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

export function requireMlsBase64(
  value: string,
  label: string,
  maximumBytes: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > Math.ceil(maximumBytes / 3) * 4 + 8) {
    throw new Error(`${label} is invalid`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== normalized
  ) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function requireMlsEpoch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('MLS epoch is invalid');
  }
  return value;
}

export function requireMlsKeyPackageReference(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new Error('MLS KeyPackage reference is invalid');
  }
  return normalized;
}

export function mlsKeyPackageReference(keyPackage: string): string {
  const normalized = requireMlsBase64(
    keyPackage,
    'MLS KeyPackage',
    MLS_KEY_PACKAGE_MAX_BYTES,
  );
  return createHash('sha256')
    .update('otto:mls-key-package:v1\n')
    .update(Buffer.from(normalized, 'base64'))
    .digest('hex');
}

export function mlsDirectConversation(input: {
  organizationId: string;
  accountId: string;
  peerAccountId: string;
}): {
  conversationId: string;
  participantAAccountId: string;
  participantBAccountId: string;
} {
  const organizationId = requireMlsIdentifier(
    input.organizationId,
    'organization id',
  );
  const accountId = requireMlsIdentifier(input.accountId, 'account id');
  const peerAccountId = requireMlsIdentifier(
    input.peerAccountId,
    'peer account id',
  );
  if (accountId === peerAccountId) {
    throw new Error('MLS participants must be different');
  }
  const [participantAAccountId, participantBAccountId] = [
    accountId,
    peerAccountId,
  ].sort() as [string, string];
  return {
    conversationId: createHash('sha256')
      .update('otto:mls-direct-conversation:v1\n')
      .update(organizationId)
      .update('\n')
      .update(participantAAccountId)
      .update('\n')
      .update(participantBAccountId)
      .digest('hex'),
    participantAAccountId,
    participantBAccountId,
  };
}

function keyPackageView(row: KeyPackageRow): MlsKeyPackageView {
  return {
    reference: row.key_package_reference,
    accountId: row.account_id,
    deviceId: row.device_id,
    ciphersuite: row.ciphersuite,
    keyPackage: row.key_package,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
  };
}

function eventView(row: EventRow): MlsTransportEventView {
  return {
    sequence: Number(row.sequence),
    eventId: row.id,
    conversationId: row.conversation_id,
    sessionGeneration: Number(row.session_generation),
    senderAccountId: row.sender_account_id,
    senderDeviceId: row.sender_device_id,
    recipientAccountId: row.recipient_account_id,
    recipientDeviceId: row.recipient_device_id,
    eventType: row.event_type,
    epoch: Number(row.epoch),
    groupId: row.group_id,
    payload: row.payload,
    keyPackageReference: row.key_package_reference,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function withMlsMutation<T>(database: Database, operation: () => T): T {
  const nested = database.inTransaction;
  database.exec(nested ? 'SAVEPOINT otto_mls_transport' : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec(nested ? 'RELEASE otto_mls_transport' : 'COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec(
        nested
          ? 'ROLLBACK TO otto_mls_transport; RELEASE otto_mls_transport'
          : 'ROLLBACK',
      );
    } catch {
      // Preserve the original invariant failure.
    }
    throw error;
  }
}

function consumeMlsRateLimit(input: {
  database: Database;
  organizationId: string;
  accountId: string;
  deviceId: string;
  action: MlsResourceRateAction;
  nowMs: number;
  limit: number;
}): void {
  const bucketStartedAtMs =
    Math.floor(input.nowMs / (60 * 1_000)) * 60 * 1_000;
  const result = input.database
    .prepare(
      `INSERT INTO mls_resource_rate_buckets
        (organization_id, account_id, device_id, action,
         bucket_started_at_ms, request_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (
         organization_id, account_id, device_id, action, bucket_started_at_ms
       ) DO UPDATE SET request_count = request_count + 1
       WHERE request_count < ?`,
    )
    .run(
      input.organizationId,
      input.accountId,
      input.deviceId,
      input.action,
      bucketStartedAtMs,
      input.limit,
    );
  if (result.changes !== 1) {
    throw new Error(`MLS ${input.action} rate limit exceeded`);
  }
}

function enforceMlsKeyPackageInventory(input: {
  database: Database;
  organizationId: string;
  deviceId: string;
  now: string;
  policy: MlsResourceGovernancePolicy;
}): void {
  const device = input.database
    .prepare(
      `SELECT count(*) AS count FROM mls_key_packages
       WHERE organization_id = ? AND device_id = ? AND claimed_at IS NULL
         AND expires_at > ?`,
    )
    .get(input.organizationId, input.deviceId, input.now) as { count: number };
  if (Number(device.count) >= input.policy.maxUnclaimedKeyPackagesPerDevice) {
    throw new Error('MLS KeyPackage device inventory quota exceeded');
  }
  const organization = input.database
    .prepare(
      `SELECT count(*) AS count FROM mls_key_packages
       WHERE organization_id = ? AND claimed_at IS NULL AND expires_at > ?`,
    )
    .get(input.organizationId, input.now) as { count: number };
  if (
    Number(organization.count) >=
    input.policy.maxUnclaimedKeyPackagesPerOrganization
  ) {
    throw new Error('MLS KeyPackage organization inventory quota exceeded');
  }
}

function enforceMlsTransportEventInventory(input: {
  database: Database;
  organizationId: string;
  conversationId: string;
  payloadStorageBytes: number;
  now: string;
  policy: MlsResourceGovernancePolicy;
}): void {
  const usage = (conversationId: string | null) =>
    input.database
      .prepare(
        `SELECT count(*) AS event_count,
                COALESCE(sum(length(payload)), 0) AS storage_bytes
         FROM mls_transport_events
         WHERE organization_id = ? AND expires_at > ?
           AND (? IS NULL OR conversation_id = ?)`,
      )
      .get(
        input.organizationId,
        input.now,
        conversationId,
        conversationId,
      ) as { event_count: number; storage_bytes: number };
  const conversation = usage(input.conversationId);
  if (
    Number(conversation.event_count) >=
      input.policy.maxTransportEventsPerConversation ||
    Number(conversation.storage_bytes) + input.payloadStorageBytes >
      input.policy.maxTransportEventBytesPerConversation
  ) {
    throw new Error('MLS conversation event inventory quota exceeded');
  }
  const organization = usage(null);
  if (
    Number(organization.event_count) >=
      input.policy.maxTransportEventsPerOrganization ||
    Number(organization.storage_bytes) + input.payloadStorageBytes >
      input.policy.maxTransportEventBytesPerOrganization
  ) {
    throw new Error('MLS organization event inventory quota exceeded');
  }
}

function requireActiveApprovedDevice(
  database: Database,
  organizationId: string,
  accountId: string,
  deviceId: string,
): void {
  const row = database
    .prepare(
      `SELECT 1 AS available FROM e2ee_devices
       WHERE organization_id = ? AND account_id = ? AND device_id = ?
         AND approval_state = 'approved' AND revoked_at IS NULL`,
    )
    .get(organizationId, accountId, deviceId);
  if (!row) throw new Error('MLS device is not active and approved');
}

function requireParticipants(
  store: MlsTransportStore,
  organizationId: string,
  accountId: string,
  peerAccountId: string,
): void {
  if (
    !store.getActiveAccountInOrganization(accountId, organizationId) ||
    !store.getActiveAccountInOrganization(peerAccountId, organizationId)
  ) {
    throw new Error('MLS participant is not active in organization');
  }
}

export function publishMlsKeyPackageInRepository(
  store: MlsTransportStore,
  raw: PublishMlsKeyPackageInput,
): MlsKeyPackageView {
  const organizationId = requireMlsIdentifier(
    raw.organizationId,
    'organization id',
  );
  const accountId = requireMlsIdentifier(raw.accountId, 'account id');
  const deviceId = requireMlsIdentifier(raw.deviceId, 'device id');
  if (raw.ciphersuite !== MLS_CIPHERSUITE) {
    throw new Error('MLS ciphersuite is unsupported');
  }
  const keyPackage = requireMlsBase64(
    raw.keyPackage,
    'MLS KeyPackage',
    MLS_KEY_PACKAGE_MAX_BYTES,
  );
  const reference = raw.reference
    ? requireMlsKeyPackageReference(raw.reference)
    : mlsKeyPackageReference(keyPackage);
  const database = store.db();
  const nowMs = storeNow(store);
  const now = isoTime(nowMs);
  const policy = resolveMlsResourceGovernancePolicy(store.mlsResourcePolicy);
  requireParticipants(store, organizationId, accountId, accountId);
  requireActiveApprovedDevice(database, organizationId, accountId, deviceId);
  return withMlsMutation(database, () => {
    const existing = database
      .prepare(
        `SELECT * FROM mls_key_packages
         WHERE organization_id = ? AND key_package_reference = ?`,
      )
      .get(organizationId, reference) as KeyPackageRow | undefined;
    if (existing) {
      if (
        existing.account_id !== accountId ||
        existing.device_id !== deviceId ||
        existing.ciphersuite !== raw.ciphersuite ||
        existing.key_package !== keyPackage ||
        existing.claimed_at !== null ||
        existing.expires_at <= now
      ) {
        throw new Error('MLS KeyPackage reference conflict or reuse');
      }
      return keyPackageView(existing);
    }
    consumeMlsRateLimit({
      database,
      organizationId,
      accountId,
      deviceId,
      action: 'key_package_publish',
      nowMs,
      limit: policy.keyPackagePublishesPerMinute,
    });
    enforceMlsKeyPackageInventory({
      database,
      organizationId,
      deviceId,
      now,
      policy,
    });
    database
      .prepare(
        `INSERT INTO mls_key_packages
          (organization_id, key_package_reference, account_id, device_id,
           ciphersuite, key_package, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        organizationId,
        reference,
        accountId,
        deviceId,
        raw.ciphersuite,
        keyPackage,
        isoTime(nowMs + policy.keyPackageTtlMs),
      );
    return keyPackageView(
      database
        .prepare(
          `SELECT * FROM mls_key_packages
           WHERE organization_id = ? AND key_package_reference = ?`,
        )
        .get(organizationId, reference) as KeyPackageRow,
    );
  });
}

export function claimMlsKeyPackageInRepository(
  store: MlsTransportStore,
  raw: ClaimMlsKeyPackageInput,
): MlsKeyPackageView | null {
  const organizationId = requireMlsIdentifier(
    raw.organizationId,
    'organization id',
  );
  const requesterAccountId = requireMlsIdentifier(
    raw.requesterAccountId,
    'requester account id',
  );
  const requesterDeviceId = requireMlsIdentifier(
    raw.requesterDeviceId,
    'requester device id',
  );
  const recipientAccountId = requireMlsIdentifier(
    raw.recipientAccountId,
    'recipient account id',
  );
  mlsDirectConversation({
    organizationId,
    accountId: requesterAccountId,
    peerAccountId: recipientAccountId,
  });
  requireParticipants(
    store,
    organizationId,
    requesterAccountId,
    recipientAccountId,
  );
  const database = store.db();
  const nowMs = storeNow(store);
  const now = isoTime(nowMs);
  const policy = resolveMlsResourceGovernancePolicy(store.mlsResourcePolicy);
  requireActiveApprovedDevice(
    database,
    organizationId,
    requesterAccountId,
    requesterDeviceId,
  );
  return withMlsMutation(database, () => {
    const recoverable = database
      .prepare(
        `SELECT package.* FROM mls_key_packages AS package
         JOIN e2ee_devices AS device
           ON device.organization_id = package.organization_id
          AND device.account_id = package.account_id
          AND device.device_id = package.device_id
         WHERE package.organization_id = ? AND package.account_id = ?
           AND package.claimed_by_account_id = ?
           AND package.claimed_by_device_id = ?
           AND package.claimed_at IS NOT NULL
           AND package.welcome_event_id IS NULL
           AND package.expires_at > ?
           AND device.approval_state = 'approved' AND device.revoked_at IS NULL
         ORDER BY package.claimed_at, package.key_package_reference
         LIMIT 1`,
      )
      .get(
        organizationId,
        recipientAccountId,
        requesterAccountId,
        requesterDeviceId,
        now,
      ) as KeyPackageRow | undefined;
    if (recoverable) return keyPackageView(recoverable);
    const row = database
      .prepare(
        `SELECT package.* FROM mls_key_packages AS package
         JOIN e2ee_devices AS device
           ON device.organization_id = package.organization_id
          AND device.account_id = package.account_id
          AND device.device_id = package.device_id
         WHERE package.organization_id = ? AND package.account_id = ?
           AND package.claimed_at IS NULL
           AND package.expires_at > ?
           AND device.approval_state = 'approved' AND device.revoked_at IS NULL
         ORDER BY package.created_at, package.key_package_reference
         LIMIT 1`,
      )
      .get(organizationId, recipientAccountId, now) as
      KeyPackageRow | undefined;
    if (!row) return null;
    database
      .prepare(
        `UPDATE mls_key_packages
         SET claimed_at = datetime('now'), claimed_by_account_id = ?,
             claimed_by_device_id = ?, expires_at = ?
         WHERE organization_id = ? AND key_package_reference = ?
           AND claimed_at IS NULL`,
      )
      .run(
        requesterAccountId,
        requesterDeviceId,
        isoTime(nowMs + policy.claimedKeyPackageTtlMs),
        organizationId,
        row.key_package_reference,
      );
    return keyPackageView(
      database
        .prepare(
          `SELECT * FROM mls_key_packages
           WHERE organization_id = ? AND key_package_reference = ?`,
        )
        .get(organizationId, row.key_package_reference) as KeyPackageRow,
    );
  });
}

function eventMatches(
  row: EventRow,
  input: {
    conversationId: string;
    senderAccountId: string;
    senderDeviceId: string;
    recipientAccountId: string | null;
    recipientDeviceId: string | null;
    eventType: MlsTransportEventType;
    epoch: number;
    groupId: string;
    payload: string;
    keyPackageReference: string | null;
  },
): boolean {
  return (
    row.conversation_id === input.conversationId &&
    row.sender_account_id === input.senderAccountId &&
    row.sender_device_id === input.senderDeviceId &&
    row.recipient_account_id === input.recipientAccountId &&
    row.recipient_device_id === input.recipientDeviceId &&
    row.event_type === input.eventType &&
    Number(row.epoch) === input.epoch &&
    row.group_id === input.groupId &&
    row.payload === input.payload &&
    row.key_package_reference === input.keyPackageReference
  );
}

export function appendMlsTransportEventInRepository(
  store: MlsTransportStore,
  raw: AppendMlsTransportEventInput,
): MlsTransportEventView {
  const organizationId = requireMlsIdentifier(
    raw.organizationId,
    'organization id',
  );
  const senderAccountId = requireMlsIdentifier(
    raw.senderAccountId,
    'sender account id',
  );
  const peerAccountId = requireMlsIdentifier(
    raw.peerAccountId,
    'peer account id',
  );
  const senderDeviceId = requireMlsIdentifier(
    raw.senderDeviceId,
    'sender device id',
  );
  const eventId = requireMlsIdentifier(raw.eventId, 'MLS event id');
  if (!['welcome', 'commit', 'application'].includes(raw.eventType)) {
    throw new Error('MLS event type is invalid');
  }
  const epoch = requireMlsEpoch(raw.epoch);
  const groupId = requireMlsBase64(raw.groupId, 'MLS group id', 255);
  const payload = requireMlsBase64(
    raw.payload,
    'MLS transport payload',
    MLS_TRANSPORT_PAYLOAD_MAX_BYTES,
  );
  const recipientDeviceId =
    raw.eventType === 'welcome'
      ? requireMlsIdentifier(raw.recipientDeviceId ?? '', 'recipient device id')
      : null;
  const keyPackageReference =
    raw.eventType === 'welcome'
      ? requireMlsKeyPackageReference(raw.keyPackageReference ?? '')
      : null;
  const resetFromGroupId = raw.resetFromGroupId
    ? requireMlsBase64(raw.resetFromGroupId, 'MLS reset source group id', 255)
    : null;
  if (
    raw.eventType !== 'welcome' &&
    (raw.recipientDeviceId || raw.keyPackageReference)
  ) {
    throw new Error('only MLS Welcome may target a KeyPackage device');
  }
  if (
    resetFromGroupId &&
    (raw.eventType !== 'commit' || epoch !== 1 || resetFromGroupId === groupId)
  ) {
    throw new Error(
      'explicit MLS session reset requires an epoch 1 Commit for a new group',
    );
  }
  requireParticipants(store, organizationId, senderAccountId, peerAccountId);
  const database = store.db();
  const nowMs = storeNow(store);
  const now = isoTime(nowMs);
  const policy = resolveMlsResourceGovernancePolicy(store.mlsResourcePolicy);
  requireActiveApprovedDevice(
    database,
    organizationId,
    senderAccountId,
    senderDeviceId,
  );
  const direct = mlsDirectConversation({
    organizationId,
    accountId: senderAccountId,
    peerAccountId,
  });
  const normalized = {
    conversationId: direct.conversationId,
    senderAccountId,
    senderDeviceId,
    recipientAccountId: raw.eventType === 'welcome' ? peerAccountId : null,
    recipientDeviceId,
    eventType: raw.eventType,
    epoch,
    groupId,
    payload,
    keyPackageReference,
  };
  return withMlsMutation(database, () => {
    const existing = database
      .prepare(
        `SELECT * FROM mls_transport_events
         WHERE organization_id = ? AND id = ?`,
      )
      .get(organizationId, eventId) as EventRow | undefined;
    if (existing) {
      if (!eventMatches(existing, normalized)) {
        throw new Error('MLS event idempotency conflict');
      }
      if (existing.expires_at <= now) {
        throw new Error('MLS event cursor expired; secure session reset required');
      }
      return eventView(existing);
    }

    consumeMlsRateLimit({
      database,
      organizationId,
      accountId: senderAccountId,
      deviceId: senderDeviceId,
      action: 'transport_event_append',
      nowMs,
      limit: policy.transportEventsPerMinute,
    });
    enforceMlsTransportEventInventory({
      database,
      organizationId,
      conversationId: direct.conversationId,
      payloadStorageBytes: Buffer.byteLength(payload, 'utf8'),
      now,
      policy,
    });

    let sessionGeneration = 1;
    let conversation = database
      .prepare(
        `SELECT * FROM mls_conversations
         WHERE organization_id = ? AND conversation_id = ?`,
      )
      .get(organizationId, direct.conversationId) as
      ConversationRow | undefined;
    if (!conversation) {
      if (raw.eventType !== 'commit' || epoch !== 1 || resetFromGroupId) {
        throw new Error('first MLS transport event must be the epoch 1 commit');
      }
      database
        .prepare(
          `INSERT INTO mls_conversations
            (organization_id, conversation_id, participant_a_account_id,
             participant_b_account_id, group_id, current_epoch,
             active_generation)
           VALUES (?, ?, ?, ?, ?, 1, 1)`,
        )
        .run(
          organizationId,
          direct.conversationId,
          direct.participantAAccountId,
          direct.participantBAccountId,
          groupId,
        );
      database
        .prepare(
          `INSERT INTO mls_group_sessions
            (organization_id, conversation_id, generation, group_id,
             current_epoch, status, created_at)
           VALUES (?, ?, 1, ?, 1, 'active', ?)`,
        )
        .run(organizationId, direct.conversationId, groupId, now);
      conversation = database
        .prepare(
          `SELECT * FROM mls_conversations
           WHERE organization_id = ? AND conversation_id = ?`,
        )
        .get(organizationId, direct.conversationId) as ConversationRow;
    } else {
      sessionGeneration = Number(conversation.active_generation);
      if (conversation.group_id !== groupId) {
        if (
          raw.eventType !== 'commit' ||
          epoch !== 1 ||
          !resetFromGroupId
        ) {
          throw new Error(
            'a new MLS group requires an explicit MLS session reset',
          );
        }
        if (resetFromGroupId !== conversation.group_id) {
          throw new Error('MLS reset source group is no longer active');
        }
        const reused = database
          .prepare(
            `SELECT 1 AS used FROM mls_group_sessions
             WHERE organization_id = ? AND conversation_id = ?
               AND group_id = ?`,
          )
          .get(organizationId, direct.conversationId, groupId);
        if (reused) {
          throw new Error('MLS reset group id was already used');
        }
        const retired = database
          .prepare(
            `UPDATE mls_group_sessions
             SET status = 'retired', retired_at = ?
             WHERE organization_id = ? AND conversation_id = ?
               AND generation = ? AND status = 'active'`,
          )
          .run(
            now,
            organizationId,
            direct.conversationId,
            sessionGeneration,
          );
        if (retired.changes !== 1) {
          throw new Error('MLS active group session state is inconsistent');
        }
        sessionGeneration += 1;
        database
          .prepare(
            `UPDATE mls_conversations
             SET group_id = ?, current_epoch = 1, active_generation = ?,
                 updated_at = ?
             WHERE organization_id = ? AND conversation_id = ?`,
          )
          .run(
            groupId,
            sessionGeneration,
            now,
            organizationId,
            direct.conversationId,
          );
        database
          .prepare(
            `INSERT INTO mls_group_sessions
              (organization_id, conversation_id, generation, group_id,
               current_epoch, status, created_at, reset_by_account_id,
               reset_by_device_id, reset_event_id)
             VALUES (?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
          )
          .run(
            organizationId,
            direct.conversationId,
            sessionGeneration,
            groupId,
            now,
            senderAccountId,
            senderDeviceId,
            eventId,
          );
      } else {
        if (resetFromGroupId) {
          throw new Error('MLS reset target group must be new');
        }
        if (raw.eventType === 'commit') {
          if (epoch !== Number(conversation.current_epoch) + 1) {
            throw new Error('MLS commit must advance to the next epoch');
          }
          database
            .prepare(
              `UPDATE mls_conversations
               SET current_epoch = ?, updated_at = ?
               WHERE organization_id = ? AND conversation_id = ?`,
            )
            .run(epoch, now, organizationId, direct.conversationId);
          const sessionUpdated = database
            .prepare(
              `UPDATE mls_group_sessions SET current_epoch = ?
               WHERE organization_id = ? AND conversation_id = ?
                 AND generation = ? AND status = 'active'`,
            )
            .run(
              epoch,
              organizationId,
              direct.conversationId,
              sessionGeneration,
            );
          if (sessionUpdated.changes !== 1) {
            throw new Error('MLS active group session state is inconsistent');
          }
        } else if (epoch !== Number(conversation.current_epoch)) {
          throw new Error('MLS event must use the current epoch');
        }
      }
    }

    if (raw.eventType === 'welcome') {
      requireActiveApprovedDevice(
        database,
        organizationId,
        peerAccountId,
        recipientDeviceId!,
      );
      const claimed = database
        .prepare(
          `SELECT * FROM mls_key_packages
           WHERE organization_id = ? AND key_package_reference = ?`,
        )
        .get(organizationId, keyPackageReference!) as KeyPackageRow | undefined;
      if (
        !claimed ||
        claimed.account_id !== peerAccountId ||
        claimed.device_id !== recipientDeviceId ||
        claimed.claimed_by_account_id !== senderAccountId ||
        claimed.claimed_by_device_id !== senderDeviceId ||
        !claimed.claimed_at ||
        claimed.welcome_event_id ||
        claimed.expires_at <= now
      ) {
        throw new Error(
          'MLS Welcome does not match an unused KeyPackage claim for this device',
        );
      }
    }

    database
      .prepare(
        `INSERT INTO mls_transport_events
          (id, organization_id, conversation_id, session_generation,
           sender_account_id,
           sender_device_id, recipient_account_id, recipient_device_id,
           event_type, epoch, group_id, payload, key_package_reference,
           expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        organizationId,
        direct.conversationId,
        sessionGeneration,
        senderAccountId,
        senderDeviceId,
        normalized.recipientAccountId,
        recipientDeviceId,
        raw.eventType,
        epoch,
        groupId,
        payload,
        keyPackageReference,
        isoTime(nowMs + policy.transportEventTtlMs),
      );
    if (raw.eventType === 'welcome') {
      database
        .prepare(
          `UPDATE mls_key_packages SET welcome_event_id = ?
           WHERE organization_id = ? AND key_package_reference = ?`,
        )
        .run(eventId, organizationId, keyPackageReference);
    }
    return eventView(
      database
        .prepare(
          `SELECT * FROM mls_transport_events
           WHERE organization_id = ? AND id = ?`,
        )
        .get(organizationId, eventId) as EventRow,
    );
  });
}

export function listMlsTransportEventsInRepository(
  store: MlsTransportStore,
  raw: {
    organizationId: string;
    accountId: string;
    peerAccountId: string;
    afterSequence?: number;
    limit?: number;
  },
): MlsTransportEventView[] {
  const organizationId = requireMlsIdentifier(
    raw.organizationId,
    'organization id',
  );
  const accountId = requireMlsIdentifier(raw.accountId, 'account id');
  const peerAccountId = requireMlsIdentifier(
    raw.peerAccountId,
    'peer account id',
  );
  requireParticipants(store, organizationId, accountId, peerAccountId);
  const afterSequence = Math.max(0, Math.floor(raw.afterSequence ?? 0));
  if (!Number.isSafeInteger(afterSequence)) {
    throw new Error('MLS event sequence is invalid');
  }
  const limit = Math.max(1, Math.min(500, Math.floor(raw.limit ?? 100)));
  const direct = mlsDirectConversation({
    organizationId,
    accountId,
    peerAccountId,
  });
  const database = store.db();
  const now = isoTime(storeNow(store));
  const retention = database
    .prepare(
      `SELECT conversation.retention_floor_sequence,
              COALESCE(MAX(
                CASE WHEN event.expires_at <= ? THEN event.sequence END
              ), 0) AS expired_floor_sequence
       FROM mls_conversations AS conversation
       LEFT JOIN mls_transport_events AS event
         ON event.organization_id = conversation.organization_id
        AND event.conversation_id = conversation.conversation_id
       WHERE conversation.organization_id = ?
         AND conversation.conversation_id = ?
       GROUP BY conversation.retention_floor_sequence`,
    )
    .get(now, organizationId, direct.conversationId) as
    | {
        retention_floor_sequence: number;
        expired_floor_sequence: number;
      }
    | undefined;
  const retentionFloor = Math.max(
    Number(retention?.retention_floor_sequence ?? 0),
    Number(retention?.expired_floor_sequence ?? 0),
  );
  if (afterSequence < retentionFloor) {
    throw new Error('MLS event cursor expired; secure session reset required');
  }
  return (
    database
      .prepare(
        `SELECT event.* FROM mls_transport_events AS event
         JOIN mls_conversations AS conversation
           ON conversation.organization_id = event.organization_id
          AND conversation.conversation_id = event.conversation_id
         WHERE event.organization_id = ? AND event.conversation_id = ?
           AND event.sequence > ?
           AND event.expires_at > ?
           AND (? IN (
             conversation.participant_a_account_id,
             conversation.participant_b_account_id
           ))
         ORDER BY event.sequence LIMIT ?`,
      )
      .all(
        organizationId,
        direct.conversationId,
        afterSequence,
        now,
        accountId,
        limit,
      ) as EventRow[]
  ).map(eventView);
}

export function cleanupExpiredMlsResourcesInRepository(
  store: MlsTransportStore,
  input: { beforeMs?: number; limit?: number } = {},
): MlsResourceCleanupResult {
  const beforeMs = input.beforeMs ?? storeNow(store);
  if (!Number.isSafeInteger(beforeMs) || beforeMs < 0) {
    throw new Error('MLS cleanup timestamp is invalid');
  }
  const limit = input.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error('MLS cleanup limit is invalid');
  }
  const before = isoTime(beforeMs);
  const database = store.db();
  return withMlsMutation(database, () => {
    const expiredEvents = database
      .prepare(
        `SELECT sequence, organization_id, conversation_id
         FROM mls_transport_events
         WHERE expires_at <= ? ORDER BY sequence LIMIT ?`,
      )
      .all(before, limit) as Array<{
        sequence: number;
        organization_id: string;
        conversation_id: string;
      }>;
    const floors = new Map<string, (typeof expiredEvents)[number]>();
    for (const event of expiredEvents) {
      const key = `${event.organization_id}\n${event.conversation_id}`;
      const current = floors.get(key);
      if (!current || Number(event.sequence) > Number(current.sequence)) {
        floors.set(key, event);
      }
    }
    for (const floor of floors.values()) {
      database
        .prepare(
          `UPDATE mls_conversations
           SET retention_floor_sequence = MAX(retention_floor_sequence, ?)
           WHERE organization_id = ? AND conversation_id = ?`,
        )
        .run(
          floor.sequence,
          floor.organization_id,
          floor.conversation_id,
        );
    }
    let eventsDeleted = 0;
    if (expiredEvents.length > 0) {
      const placeholders = expiredEvents.map(() => '?').join(', ');
      eventsDeleted = Number(database
        .prepare(
          `DELETE FROM mls_transport_events
           WHERE sequence IN (${placeholders})`,
        )
        .run(...expiredEvents.map((event) => event.sequence)).changes);
    }
    const retiredSessions = database
      .prepare(
        `SELECT session.organization_id, session.conversation_id,
                session.generation
         FROM mls_group_sessions AS session
         WHERE session.status = 'retired' AND session.retired_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM mls_transport_events AS event
             WHERE event.organization_id = session.organization_id
               AND event.conversation_id = session.conversation_id
               AND event.session_generation = session.generation
           )
         ORDER BY session.retired_at, session.generation LIMIT ?`,
      )
      .all(before, limit) as Array<{
        organization_id: string;
        conversation_id: string;
        generation: number;
      }>;
    let groupSessionsDeleted = 0;
    const deleteSession = database.prepare(
      `DELETE FROM mls_group_sessions
       WHERE organization_id = ? AND conversation_id = ? AND generation = ?
         AND status = 'retired'`,
    );
    for (const session of retiredSessions) {
      groupSessionsDeleted += Number(
        deleteSession.run(
          session.organization_id,
          session.conversation_id,
          session.generation,
        ).changes,
      );
    }
    const expiredPackages = database
      .prepare(
        `SELECT package.organization_id, package.key_package_reference
         FROM mls_key_packages AS package
         WHERE package.expires_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM mls_transport_events AS event
             WHERE event.organization_id = package.organization_id
               AND event.key_package_reference = package.key_package_reference
           )
         ORDER BY package.expires_at, package.key_package_reference LIMIT ?`,
      )
      .all(before, limit) as Array<{
        organization_id: string;
        key_package_reference: string;
      }>;
    let keyPackagesDeleted = 0;
    const deletePackage = database.prepare(
      `DELETE FROM mls_key_packages
       WHERE organization_id = ? AND key_package_reference = ?`,
    );
    for (const keyPackage of expiredPackages) {
      keyPackagesDeleted += Number(
        deletePackage.run(
          keyPackage.organization_id,
          keyPackage.key_package_reference,
        ).changes,
      );
    }
    const rateBucketsDeleted = Number(database
      .prepare(
        `DELETE FROM mls_resource_rate_buckets
         WHERE rowid IN (
           SELECT rowid FROM mls_resource_rate_buckets
           WHERE bucket_started_at_ms < ?
           ORDER BY bucket_started_at_ms LIMIT ?
         )`,
      )
      .run(Math.max(0, beforeMs - 2 * 60 * 1_000), limit).changes);
    return {
      eventsDeleted,
      keyPackagesDeleted,
      groupSessionsDeleted,
      rateBucketsDeleted,
      conversationsAdvanced: floors.size,
    };
  });
}

export function createMlsTransportFacade(store: MlsTransportStore) {
  return {
    publishMlsKeyPackage: (input: PublishMlsKeyPackageInput) =>
      publishMlsKeyPackageInRepository(store, input),
    claimMlsKeyPackage: (input: ClaimMlsKeyPackageInput) =>
      claimMlsKeyPackageInRepository(store, input),
    appendMlsTransportEvent: (input: AppendMlsTransportEventInput) =>
      appendMlsTransportEventInRepository(store, input),
    listMlsTransportEvents: (
      input: Parameters<typeof listMlsTransportEventsInRepository>[1],
    ) => listMlsTransportEventsInRepository(store, input),
    cleanupExpiredMlsResources: (
      input?: Parameters<typeof cleanupExpiredMlsResourcesInRepository>[1],
    ) => cleanupExpiredMlsResourcesInRepository(store, input),
  };
}
