/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Asynchronous PostgreSQL authority for the routes every clustered Otto
 * replica needs before optional product modules are mounted. This repository
 * never opens SQLite and never falls back to process-local state.
 */

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from 'node:crypto';

import {
  E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES,
  E2EE_ATTACHMENT_MAX_COUNT,
  E2EE_MESSAGE_MAX_CIPHERTEXT_BYTES,
  E2EE_PROTOCOL_VERSION,
  MLS_CIPHERSUITE,
  MLS_KEY_PACKAGE_MAX_BYTES,
  MLS_TRANSPORT_PAYLOAD_MAX_BYTES,
  resolveMlsResourceGovernancePolicy,
  e2eeDeviceApprovalSignaturePayload,
  e2eeDeviceKeyFingerprint,
  e2eeMessageSignaturePayload,
  mlsDirectConversation,
  mlsKeyPackageReference,
  requireMlsBase64,
  requireMlsEpoch,
  requireMlsKeyPackageReference,
  type E2eeDeviceApprovalInput,
  type E2eeDeviceRegistrationInput,
  type E2eeDeviceView,
  type E2eeDirectMessageView,
  type E2eeKeyTransparencyEntry,
  type E2eeKeyTransparencyEvent,
  type E2eeKeyTransparencyView,
  type E2eeMessageEnvelope,
  type SendE2eeDirectMessageInput,
  type AppendMlsTransportEventInput,
  type ClaimMlsKeyPackageInput,
  type MlsKeyPackageView,
  type MlsResourceCleanupResult,
  type MlsResourceGovernancePolicy,
  type MlsResourceRateAction,
  type MlsTransportEventType,
  type MlsTransportEventView,
  type PublishMlsKeyPackageInput,
} from '../modules/collaboration/index.js';
import {
  hashIdentitySecret,
  identitySecretMatches,
  isAcceptableAccountPassword,
} from '../modules/identity_organization/index.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';
import { createPostgresRegistrationRepository } from './postgresRegistrationRepository.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const KEY_FINGERPRINT = /^[0-9a-f]{64}$/;
const EMPTY_TRANSPARENCY_HASH = '0'.repeat(64);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_BLOCK_SECONDS = 15 * 60;

export interface PostgresEnterpriseOrganizationView {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'enterprise' | 'park';
  status: 'active' | 'disabled';
  parkId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PostgresEnterpriseFeatures {
  enterprise_tree: boolean;
  direct_messages: boolean;
  atoa: boolean;
  park_services: boolean;
}

export interface PostgresEnterpriseAccountView {
  id: string;
  organizationId: string;
  organizationName: string;
  accountType: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  phone: string | null;
  feishuOpenId: string | null;
  name: string;
  role: string | null;
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePostgresEnterpriseAccountInput {
  id?: string;
  organizationId?: string;
  accountType?: 'personal' | 'enterprise';
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  employeeId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
  tags?: readonly string[];
}

export interface UpdatePostgresEnterpriseAccountInput {
  organizationId: string;
  accountId: string;
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
  tags?: readonly string[];
}

export interface PostgresOrganizationStructureView {
  departments: Array<{
    id: string;
    name: string;
    positions: Array<{
      id: string;
      title: string;
      roleMapping: string | null;
    }>;
  }>;
}

export interface PostgresEnterpriseAuditRecord {
  id: number;
  organizationId: string;
  action: string;
  actorEmployeeId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface PostgresE2eeAttachmentReferenceInput {
  id: string;
  nonce: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
}

export type SendPostgresE2eeDirectMessageInput =
  SendE2eeDirectMessageInput & {
    attachmentReferences?: PostgresE2eeAttachmentReferenceInput[];
  };

export interface PostgresE2eeAttachmentAuthority {
  message: E2eeDirectMessageView;
  attachment: PostgresE2eeAttachmentReferenceInput;
}

export interface PostgresUnboundAttachmentObject {
  id: string;
  organizationId: string;
  key: string;
  ciphertextBytes: number;
}

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'enterprise' | 'park';
  status: 'active' | 'disabled';
  park_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  organization_name: string;
  account_type: 'personal' | 'enterprise';
  employee_id: string | null;
  username: string;
  phone: string | null;
  feishu_open_id: string | null;
  password_hash: string;
  name: string;
  role: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  status: 'active' | 'disabled';
  tags: string[] | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DeviceRow extends Record<string, unknown> {
  organization_id: string;
  account_id: string;
  device_id: string;
  device_name: string;
  identity_signing_public_key: string;
  device_exchange_public_key: string;
  key_fingerprint: string;
  approval_state: 'pending' | 'approved';
  approved_by_device_id: string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
}

interface TransparencyRow extends Record<string, unknown> {
  sequence: number | string;
  account_id: string;
  device_id: string;
  event: E2eeKeyTransparencyEvent;
  key_fingerprint: string;
  actor_device_id: string | null;
  previous_hash: string;
  entry_hash: string;
  created_at: Date | string;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  content_type: 'message' | 'atoa_request' | 'atoa_response';
  e2ee_protocol_version: number;
  e2ee_sender_device_id: string;
  e2ee_ciphertext: string;
  e2ee_nonce: string;
  e2ee_signature: string;
  e2ee_envelopes: E2eeMessageEnvelope[] | string;
  in_reply_to_message_id: string | null;
  sender_identity_signing_public_key: string;
  created_at: Date | string;
  read_at: Date | string | null;
  attachment_refs:
    | Array<{ id: string; ciphertextSize: number | string; nonce: string }>
    | string;
}

interface MlsKeyPackageRow extends Record<string, unknown> {
  key_package_reference: string;
  account_id: string;
  device_id: string;
  ciphersuite: typeof MLS_CIPHERSUITE;
  key_package: string;
  created_at: Date | string;
  claimed_at: Date | string | null;
  claimed_by_account_id: string | null;
  claimed_by_device_id: string | null;
  welcome_event_id: string | null;
  expires_at: Date | string;
}

interface MlsConversationRow extends Record<string, unknown> {
  conversation_id: string;
  participant_a_account_id: string;
  participant_b_account_id: string;
  group_id: string;
  current_epoch: number | string;
  active_generation: number | string;
  retention_floor_sequence: number | string;
}

interface MlsGroupSessionRow extends Record<string, unknown> {
  organization_id: string;
  conversation_id: string;
  generation: number | string;
  group_id: string;
  current_epoch: number | string;
  status: 'active' | 'retired';
  created_at: Date | string;
  retired_at: Date | string | null;
  reset_by_account_id: string | null;
  reset_by_device_id: string | null;
  reset_event_id: string | null;
}

interface MlsEventRow extends Record<string, unknown> {
  sequence: number | string;
  id: string;
  conversation_id: string;
  session_generation: number | string;
  sender_account_id: string;
  sender_device_id: string;
  recipient_account_id: string | null;
  recipient_device_id: string | null;
  event_type: MlsTransportEventType;
  epoch: number | string;
  group_id: string;
  payload: string;
  key_package_reference: string | null;
  created_at: Date | string;
  expires_at: Date | string;
}

type Queryable = Pick<PostgresPoolLike, 'query'> | Pick<PostgresClientLike, 'query'>;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  label: string,
  maximumLength = 2_000,
): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maximumLength) {
    throw new Error(`${label} is too long`);
  }
  return normalized;
}

function normalizeUsername(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(normalized)) {
    throw new Error('username is invalid');
  }
  return normalized;
}

export function normalizePostgresEnterprisePhone(value: string): string {
  let digits = value.trim().replace(/[^\d]/g, '');
  if (digits.startsWith('0086')) digits = digits.slice(4);
  else if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2);
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('phone is invalid');
  return `+86${digits}`;
}

function normalizeOptionalPhone(value: string | null | undefined): string | null {
  return value?.trim() ? normalizePostgresEnterprisePhone(value) : null;
}

function normalizeTags(values: readonly string[] | undefined): string[] {
  const tags = (values ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (tags.some((tag) => tag.length > 80)) throw new Error('account tag is too long');
  return [...new Set(tags)].sort((left, right) => left.localeCompare(right));
}

function requireCanonicalBase64(
  value: string,
  label: string,
  maximumBytes: number,
): Buffer {
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, 'base64');
  if (
    !normalized ||
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== normalized
  ) {
    throw new Error(`${label} is invalid`);
  }
  return decoded;
}

function requireNonce(value: string, label: string): string {
  if (requireCanonicalBase64(value, label, 12).length !== 12) {
    throw new Error(`${label} must be 12 bytes`);
  }
  return value;
}

function normalizeAttachmentReference(
  value: PostgresE2eeAttachmentReferenceInput,
): PostgresE2eeAttachmentReferenceInput {
  const ciphertextBytes = Number(value.ciphertextBytes);
  if (
    !Number.isSafeInteger(ciphertextBytes) ||
    ciphertextBytes <= 16 ||
    ciphertextBytes > E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES
  ) {
    throw new Error('attachment ciphertext size is invalid');
  }
  const ciphertextSha256 = value.ciphertextSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(ciphertextSha256)) {
    throw new Error('attachment ciphertext checksum is invalid');
  }
  return {
    id: requiredIdentifier(value.id, 'attachment id'),
    nonce: requireNonce(value.nonce, 'attachment nonce'),
    ciphertextBytes,
    ciphertextSha256,
  };
}

function requirePublicKey(
  value: string,
  expectedType: 'ed25519' | 'x25519',
  label: string,
): string {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== expectedType) throw new Error('wrong type');
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch {
    throw new Error(`${label} must be a valid ${expectedType} public key`);
  }
}

function accountView(row: AccountRow): PostgresEnterpriseAccountView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    accountType: row.account_type,
    employeeId: row.employee_id,
    username: row.username,
    phone: row.phone,
    feishuOpenId: row.feishu_open_id,
    name: row.name,
    role: row.role,
    department: row.department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin,
    status: row.status,
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function organizationView(row: OrganizationRow): PostgresEnterpriseOrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    status: row.status,
    parkId: row.park_id,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function deviceView(row: DeviceRow): E2eeDeviceView {
  return {
    accountId: row.account_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    identitySigningPublicKey: row.identity_signing_public_key,
    deviceExchangePublicKey: row.device_exchange_public_key,
    keyFingerprint: row.key_fingerprint,
    approvalState: row.approval_state,
    approvedByDeviceId: row.approved_by_device_id,
    approvedAt: iso(row.approved_at),
    createdAt: iso(row.created_at)!,
    lastSeenAt: iso(row.last_seen_at)!,
    revokedAt: iso(row.revoked_at),
  };
}

function transparencyEntry(row: TransparencyRow): E2eeKeyTransparencyEntry {
  return {
    sequence: Number(row.sequence),
    accountId: row.account_id,
    deviceId: row.device_id,
    event: row.event,
    keyFingerprint: row.key_fingerprint,
    actorDeviceId: row.actor_device_id,
    previousHash: row.previous_hash,
    entryHash: row.entry_hash,
    createdAt: iso(row.created_at)!,
  };
}

function parseEnvelopes(value: E2eeMessageEnvelope[] | string): E2eeMessageEnvelope[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new Error('stored E2EE envelopes are invalid');
  return parsed as E2eeMessageEnvelope[];
}

function messageView(row: MessageRow): E2eeDirectMessageView {
  if (Number(row.e2ee_protocol_version) !== E2EE_PROTOCOL_VERSION) {
    throw new Error('stored E2EE protocol version is unsupported');
  }
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    recipientAccountId: row.recipient_account_id,
    senderDeviceId: row.e2ee_sender_device_id,
    senderIdentitySigningPublicKey: row.sender_identity_signing_public_key,
    protocolVersion: E2EE_PROTOCOL_VERSION,
    contentType: row.content_type,
    inReplyToMessageId: row.in_reply_to_message_id,
    ciphertext: row.e2ee_ciphertext,
    nonce: row.e2ee_nonce,
    signature: row.e2ee_signature,
    envelopes: parseEnvelopes(row.e2ee_envelopes),
    createdAt: iso(row.created_at)!,
    readAt: iso(row.read_at),
    attachments: (() => {
      const parsed =
        typeof row.attachment_refs === 'string'
          ? (JSON.parse(row.attachment_refs) as unknown)
          : row.attachment_refs;
      if (!Array.isArray(parsed)) {
        throw new Error('stored E2EE attachment references are invalid');
      }
      return parsed.map((value) => {
        const reference = value as {
          id?: unknown;
          ciphertextSize?: unknown;
          nonce?: unknown;
        };
        const ciphertextSize = Number(reference.ciphertextSize);
        if (
          typeof reference.id !== 'string' ||
          !Number.isSafeInteger(ciphertextSize) ||
          ciphertextSize <= 16 ||
          typeof reference.nonce !== 'string'
        ) {
          throw new Error('stored E2EE attachment reference is invalid');
        }
        return {
          id: reference.id,
          ciphertextSize,
          nonce: reference.nonce,
        };
      });
    })(),
  };
}

function mlsKeyPackageView(row: MlsKeyPackageRow): MlsKeyPackageView {
  return {
    reference: row.key_package_reference,
    accountId: row.account_id,
    deviceId: row.device_id,
    ciphersuite: row.ciphersuite,
    keyPackage: row.key_package,
    createdAt: iso(row.created_at)!,
    claimedAt: iso(row.claimed_at),
    expiresAt: iso(row.expires_at)!,
  };
}

function mlsEventView(row: MlsEventRow): MlsTransportEventView {
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
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
  };
}

function postgresMlsEventMatches(
  row: MlsEventRow,
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

async function transaction<T>(pool: PostgresPoolLike, operation: (client: PostgresClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query('BEGIN');
    active = true;
    const result = await operation(client);
    await client.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the domain or PostgreSQL error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

const ACCOUNT_SELECT = `
SELECT a.*, o.name AS organization_name,
       COALESCE(array_agg(t.tag ORDER BY t.tag)
         FILTER (WHERE t.tag IS NOT NULL), ARRAY[]::text[]) AS tags
FROM accounts AS a
JOIN organizations AS o ON o.id = a.organization_id
LEFT JOIN account_tags AS t
  ON t.account_id = a.id AND t.organization_id = a.organization_id`;

const MESSAGE_SELECT = `
SELECT m.*, d.identity_signing_public_key AS sender_identity_signing_public_key,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', attachment.attachment_id,
           'ciphertextSize', attachment.ciphertext_bytes,
           'nonce', attachment.e2ee_nonce
         ) ORDER BY attachment.ordinal)
         FROM direct_message_attachment_objects AS attachment
         WHERE attachment.message_id = m.id
       ), '[]'::jsonb) AS attachment_refs
FROM direct_messages AS m
JOIN e2ee_devices AS d
  ON d.organization_id = m.organization_id
 AND d.account_id = m.sender_account_id
 AND d.device_id = m.e2ee_sender_device_id`;

async function accountByCondition(
  database: Queryable,
  condition: string,
  values: readonly unknown[],
): Promise<AccountRow | null> {
  const result = await database.query<AccountRow>(
    `${ACCOUNT_SELECT}\nWHERE ${condition}\nGROUP BY a.id, o.name`,
    values,
  );
  return result.rows[0] ?? null;
}

function transparencyHash(input: {
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

async function appendTransparencyEntry(
  database: PostgresClientLike,
  input: {
    organizationId: string;
    accountId: string;
    deviceId: string;
    event: E2eeKeyTransparencyEvent;
    keyFingerprint: string;
    actorDeviceId: string | null;
  },
): Promise<E2eeKeyTransparencyEntry> {
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${input.organizationId}:${input.accountId}:e2ee-transparency`,
  ]);
  const previousResult = await database.query<TransparencyRow>(
    `SELECT * FROM e2ee_key_transparency_log
     WHERE organization_id = $1 AND account_id = $2
     ORDER BY sequence DESC LIMIT 1`,
    [input.organizationId, input.accountId],
  );
  const previous = previousResult.rows[0];
  const sequence = Number(previous?.sequence ?? 0) + 1;
  const previousHash = previous?.entry_hash ?? EMPTY_TRANSPARENCY_HASH;
  const createdAt = new Date().toISOString();
  const entryHash = transparencyHash({
    sequence,
    organizationId: input.organizationId,
    accountId: input.accountId,
    deviceId: input.deviceId,
    event: input.event,
    keyFingerprint: input.keyFingerprint,
    actorDeviceId: input.actorDeviceId,
    previousHash,
    createdAt,
  });
  const result = await database.query<TransparencyRow>(
    `INSERT INTO e2ee_key_transparency_log
       (organization_id, sequence, account_id, device_id, event,
        key_fingerprint, actor_device_id, previous_hash, entry_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
     RETURNING *`,
    [
      input.organizationId,
      sequence,
      input.accountId,
      input.deviceId,
      input.event,
      input.keyFingerprint,
      input.actorDeviceId,
      previousHash,
      entryHash,
      createdAt,
    ],
  );
  return transparencyEntry(result.rows[0]!);
}

export function createPostgresEnterpriseCoreRepository(input: {
  pool: PostgresPoolLike;
  defaultOrganizationId?: string;
  sessionTtlMs?: number;
  now?: () => number;
  mlsResourcePolicy?: Partial<MlsResourceGovernancePolicy>;
}) {
  const defaultOrganizationId = input.defaultOrganizationId?.trim() || 'org_default';
  const sessionTtlMs = input.sessionTtlMs ?? SESSION_TTL_MS;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000) {
    throw new Error('PostgreSQL enterprise session TTL is invalid');
  }
  const mlsResourcePolicy = resolveMlsResourceGovernancePolicy(
    input.mlsResourcePolicy,
  );

  function mlsNow(): { milliseconds: number; iso: string } {
    const milliseconds = (input.now ?? Date.now)();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('MLS resource clock is invalid');
    }
    return { milliseconds, iso: new Date(milliseconds).toISOString() };
  }

  async function getOrganization(id: string): Promise<PostgresEnterpriseOrganizationView | null> {
    const result = await input.pool.query<OrganizationRow>(
      'SELECT * FROM organizations WHERE id = $1',
      [requiredIdentifier(id, 'organization id')],
    );
    return result.rows[0] ? organizationView(result.rows[0]) : null;
  }

  async function getAccount(
    id: string,
    organizationId?: string,
  ): Promise<PostgresEnterpriseAccountView | null> {
    const row = await accountByCondition(
      input.pool,
      organizationId
        ? 'a.id = $1 AND a.organization_id = $2 AND a.deleted_at IS NULL'
        : 'a.id = $1 AND a.deleted_at IS NULL',
      organizationId
        ? [requiredIdentifier(id, 'account id'), requiredIdentifier(organizationId, 'organization id')]
        : [requiredIdentifier(id, 'account id')],
    );
    return row ? accountView(row) : null;
  }

  async function listAccounts(organizationId: string): Promise<PostgresEnterpriseAccountView[]> {
    const result = await input.pool.query<AccountRow>(
      `${ACCOUNT_SELECT}
       WHERE a.organization_id = $1 AND a.deleted_at IS NULL
       GROUP BY a.id, o.name ORDER BY a.name, a.id`,
      [requiredIdentifier(organizationId, 'organization id')],
    );
    return result.rows.map(accountView);
  }

  async function logAudit(
    action: string,
    organizationId: string,
    actorEmployeeId: string | null,
    detail: Record<string, unknown>,
    database: Queryable = input.pool,
  ): Promise<void> {
    const normalizedAction = action.trim();
    if (!normalizedAction || normalizedAction.length > 120) {
      throw new Error('audit action is invalid');
    }
    await database.query(
      `INSERT INTO audit_logs (organization_id, action, actor_employee_id, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        requiredIdentifier(organizationId, 'organization id'),
        normalizedAction,
        actorEmployeeId,
        JSON.stringify(detail),
      ],
    );
  }

  async function createAccount(
    raw: CreatePostgresEnterpriseAccountInput,
  ): Promise<PostgresEnterpriseAccountView> {
    if (!isAcceptableAccountPassword(raw.password)) {
      throw new Error('account password does not meet security requirements');
    }
    const id = requiredIdentifier(raw.id ?? `acc_${randomUUID()}`, 'account id');
    const organizationId = requiredIdentifier(
      raw.organizationId ?? defaultOrganizationId,
      'organization id',
    );
    const username = normalizeUsername(raw.username);
    const name = raw.name.trim();
    if (!name || name.length > 120) throw new Error('account name is invalid');
    const tags = normalizeTags(raw.tags);
    await transaction(input.pool, async (client) => {
      const organization = await client.query<OrganizationRow>(
        `SELECT * FROM organizations
         WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [organizationId],
      );
      if (!organization.rows[0]) throw new Error('organization is unavailable');
      await client.query(
        `INSERT INTO accounts
          (id, organization_id, account_type, employee_id, username, phone,
           feishu_open_id, password_hash, name, role, department, department_id,
           position_id, position_title, avatar_url, is_admin, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17)`,
        [
          id,
          organizationId,
          raw.accountType ?? 'enterprise',
          optionalText(raw.employeeId, 'employee id', 200),
          username,
          normalizeOptionalPhone(raw.phone),
          optionalText(raw.feishuOpenId, 'Feishu open id', 200),
          hashIdentitySecret(raw.password),
          name,
          optionalText(raw.role, 'role', 120),
          optionalText(raw.department, 'department', 120),
          optionalText(raw.departmentId, 'department id', 200),
          optionalText(raw.positionId, 'position id', 200),
          optionalText(raw.positionTitle, 'position title', 120),
          optionalText(raw.avatarUrl, 'avatar URL'),
          raw.isAdmin === true,
          raw.status ?? 'active',
        ],
      );
      for (const tag of tags) {
        await client.query(
          `INSERT INTO account_tags (account_id, organization_id, tag)
           VALUES ($1, $2, $3)`,
          [id, organizationId, tag],
        );
      }
      await logAudit('account_created', organizationId, null, { accountId: id }, client);
    });
    return (await getAccount(id, organizationId))!;
  }

  async function updateAccount(
    raw: UpdatePostgresEnterpriseAccountInput,
  ): Promise<PostgresEnterpriseAccountView> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    if (raw.password !== undefined && !isAcceptableAccountPassword(raw.password)) {
      throw new Error('account password does not meet security requirements');
    }
    await transaction(input.pool, async (client) => {
      const existing = await client.query<AccountRow>(
        `SELECT a.*, ''::text AS organization_name, ARRAY[]::text[] AS tags
         FROM accounts AS a
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [accountId, organizationId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('account not found');
      const nextAdmin = raw.isAdmin ?? row.is_admin;
      const nextStatus = raw.status ?? row.status;
      if (row.is_admin && row.status === 'active' && (!nextAdmin || nextStatus !== 'active')) {
        const administrators = await client.query<{ count: number | string } & Record<string, unknown>>(
          `SELECT count(*)::integer AS count FROM accounts
           WHERE organization_id = $1 AND is_admin = TRUE AND status = 'active'
             AND deleted_at IS NULL`,
          [organizationId],
        );
        if (Number(administrators.rows[0]?.count ?? 0) <= 1) {
          throw new Error('organization must retain one active administrator');
        }
      }
      await client.query(
        `UPDATE accounts SET
           username = $3,
           phone = $4,
           feishu_open_id = $5,
           password_hash = $6,
           name = $7,
           role = $8,
           department = $9,
           department_id = $10,
           position_id = $11,
           position_title = $12,
           avatar_url = $13,
           is_admin = $14,
           status = $15,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND organization_id = $2`,
        [
          accountId,
          organizationId,
          raw.username === undefined ? row.username : normalizeUsername(raw.username),
          raw.phone === undefined ? row.phone : normalizeOptionalPhone(raw.phone),
          raw.feishuOpenId === undefined
            ? row.feishu_open_id
            : optionalText(raw.feishuOpenId, 'Feishu open id', 200),
          raw.password === undefined ? row.password_hash : hashIdentitySecret(raw.password),
          raw.name === undefined ? row.name : optionalText(raw.name, 'account name', 120),
          raw.role === undefined ? row.role : optionalText(raw.role, 'role', 120),
          raw.department === undefined
            ? row.department
            : optionalText(raw.department, 'department', 120),
          raw.departmentId === undefined
            ? row.department_id
            : optionalText(raw.departmentId, 'department id', 200),
          raw.positionId === undefined
            ? row.position_id
            : optionalText(raw.positionId, 'position id', 200),
          raw.positionTitle === undefined
            ? row.position_title
            : optionalText(raw.positionTitle, 'position title', 120),
          raw.avatarUrl === undefined
            ? row.avatar_url
            : optionalText(raw.avatarUrl, 'avatar URL'),
          nextAdmin,
          nextStatus,
        ],
      );
      if (raw.tags !== undefined) {
        await client.query('DELETE FROM account_tags WHERE account_id = $1', [accountId]);
        for (const tag of normalizeTags(raw.tags)) {
          await client.query(
            `INSERT INTO account_tags (account_id, organization_id, tag)
             VALUES ($1, $2, $3)`,
            [accountId, organizationId, tag],
          );
        }
      }
      await logAudit('account_updated', organizationId, null, { accountId }, client);
    });
    return (await getAccount(accountId, organizationId))!;
  }

  async function deleteAccount(organizationIdValue: string, accountIdValue: string): Promise<boolean> {
    const organizationId = requiredIdentifier(organizationIdValue, 'organization id');
    const accountId = requiredIdentifier(accountIdValue, 'account id');
    return transaction(input.pool, async (client) => {
      const existing = await client.query<{
        is_admin: boolean;
        status: 'active' | 'disabled';
      } & Record<string, unknown>>(
        `SELECT is_admin, status FROM accounts
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [accountId, organizationId],
      );
      const account = existing.rows[0];
      if (!account) return false;
      if (account.is_admin && account.status === 'active') {
        const administrators = await client.query<{ count: number | string } & Record<string, unknown>>(
          `SELECT count(*)::integer AS count FROM accounts
           WHERE organization_id = $1 AND is_admin = TRUE AND status = 'active'
             AND deleted_at IS NULL`,
          [organizationId],
        );
        if (Number(administrators.rows[0]?.count ?? 0) <= 1) {
          throw new Error('organization must retain one active administrator');
        }
      }
      const deleted = await client.query(
        `UPDATE accounts
         SET deleted_at = CURRENT_TIMESTAMP, status = 'disabled',
             username = concat('deleted-', id), phone = NULL, feishu_open_id = NULL,
             password_hash = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [accountId, organizationId, hashIdentitySecret(randomBytes(32).toString('base64url'))],
      );
      await logAudit('account_deleted', organizationId, null, { accountId }, client);
      return Number(deleted.rowCount ?? 0) === 1;
    });
  }

  async function authenticateAccount(
    identifier: string,
    password: string,
  ): Promise<PostgresEnterpriseAccountView | null> {
    const normalized = identifier.trim();
    const phone = normalized ? (() => {
      try {
        return normalizePostgresEnterprisePhone(normalized);
      } catch {
        return null;
      }
    })() : null;
    const row = await accountByCondition(
      input.pool,
      `a.deleted_at IS NULL AND a.status = 'active'
       AND o.status = 'active'
       AND (lower(a.username) = lower($1) OR ($2::text IS NOT NULL AND a.phone = $2))`,
      [normalized, phone],
    );
    if (!row || !identitySecretMatches(password, row.password_hash)) return null;
    return accountView(row);
  }

  function loginIdentityHash(identifier: string): string {
    return createHash('sha256')
      .update(identifier.trim().toLowerCase())
      .digest('hex');
  }

  async function getLoginRetryAfter(identifier: string): Promise<number> {
    const result = await input.pool.query<
      { retry_after_seconds: number | string } & Record<string, unknown>
    >(
      `SELECT GREATEST(
         0,
         CEIL(EXTRACT(EPOCH FROM (blocked_until - CURRENT_TIMESTAMP)))
       )::integer AS retry_after_seconds
       FROM auth_login_limits
       WHERE identity_hash = $1 AND blocked_until > CURRENT_TIMESTAMP`,
      [loginIdentityHash(identifier)],
    );
    return Math.max(0, Number(result.rows[0]?.retry_after_seconds ?? 0));
  }

  async function recordLoginFailure(identifier: string): Promise<number> {
    const result = await input.pool.query<
      { retry_after_seconds: number | string | null } & Record<string, unknown>
    >(
      `INSERT INTO auth_login_limits (identity_hash, failures)
       VALUES ($1, 1)
       ON CONFLICT (identity_hash) DO UPDATE SET
         failures = CASE
           WHEN auth_login_limits.blocked_until <= CURRENT_TIMESTAMP THEN 1
           ELSE auth_login_limits.failures + 1
         END,
         blocked_until = CASE
           WHEN auth_login_limits.blocked_until > CURRENT_TIMESTAMP
             THEN auth_login_limits.blocked_until
           WHEN (
             CASE
               WHEN auth_login_limits.blocked_until <= CURRENT_TIMESTAMP THEN 1
               ELSE auth_login_limits.failures + 1
             END
           ) >= $2
             THEN CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second')
           ELSE NULL
         END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING CASE
         WHEN blocked_until > CURRENT_TIMESTAMP
           THEN GREATEST(
             1,
             CEIL(EXTRACT(EPOCH FROM (blocked_until - CURRENT_TIMESTAMP)))
           )::integer
         ELSE NULL
       END AS retry_after_seconds`,
      [loginIdentityHash(identifier), LOGIN_FAILURE_LIMIT, LOGIN_BLOCK_SECONDS],
    );
    return Math.max(0, Number(result.rows[0]?.retry_after_seconds ?? 0));
  }

  async function clearLoginFailures(identifier: string): Promise<void> {
    await input.pool.query(
      'DELETE FROM auth_login_limits WHERE identity_hash = $1',
      [loginIdentityHash(identifier)],
    );
  }

  async function createAuthSession(accountIdValue: string) {
    const accountId = requiredIdentifier(accountIdValue, 'account id');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
    const result = await input.pool.query(
      `INSERT INTO auth_sessions (token_hash, account_id, expires_at)
       SELECT $1, id, $3::timestamptz FROM accounts
       WHERE id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [tokenHash, accountId, expiresAt],
    );
    if (Number(result.rowCount ?? 0) !== 1) throw new Error('account is unavailable');
    return { token, expiresAt };
  }

  async function getAccountBySession(token: string): Promise<PostgresEnterpriseAccountView | null> {
    if (!token.trim()) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await accountByCondition(
      input.pool,
      `a.id = (
         SELECT s.account_id FROM auth_sessions AS s
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL
           AND s.expires_at > CURRENT_TIMESTAMP
       ) AND a.status = 'active' AND a.deleted_at IS NULL AND o.status = 'active'`,
      [tokenHash],
    );
    return row ? accountView(row) : null;
  }

  async function revokeAuthSession(token: string): Promise<boolean> {
    if (!token.trim()) return false;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const result = await input.pool.query(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return Number(result.rowCount ?? 0) === 1;
  }

  async function getOrganizationFeatures(
    organizationIdValue: string,
  ): Promise<PostgresEnterpriseFeatures> {
    const organizationId = requiredIdentifier(organizationIdValue, 'organization id');
    const result = await input.pool.query<
      PostgresEnterpriseFeatures & Record<string, unknown>
    >(
      `SELECT enterprise_tree, direct_messages, atoa, park_services
       FROM organization_features WHERE organization_id = $1`,
      [organizationId],
    );
    if (!result.rows[0]) throw new Error('organization features are unavailable');
    return result.rows[0];
  }

  async function updateOrganizationFeatures(
    organizationIdValue: string,
    patch: Partial<PostgresEnterpriseFeatures>,
  ): Promise<PostgresEnterpriseFeatures> {
    const organizationId = requiredIdentifier(organizationIdValue, 'organization id');
    const current = await getOrganizationFeatures(organizationId);
    const next = { ...current, ...patch };
    await input.pool.query(
      `UPDATE organization_features SET
         enterprise_tree = $2, direct_messages = $3, atoa = $4,
         park_services = $5, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1`,
      [
        organizationId,
        next.enterprise_tree,
        next.direct_messages,
        next.atoa,
        next.park_services,
      ],
    );
    await logAudit('organization_features_updated', organizationId, null, { features: next });
    return next;
  }

  async function listOrganizationStructure(
    organizationIdValue: string,
  ): Promise<PostgresOrganizationStructureView> {
    const organizationId = requiredIdentifier(organizationIdValue, 'organization id');
    const departments = await input.pool.query<
      { id: string; name: string } & Record<string, unknown>
    >(
      `SELECT id, name FROM organization_departments
       WHERE organization_id = $1 ORDER BY name, id`,
      [organizationId],
    );
    const positions = await input.pool.query<
      {
        id: string;
        department_id: string;
        title: string;
        role_mapping: string | null;
      } & Record<string, unknown>
    >(
      `SELECT id, department_id, title, role_mapping FROM organization_positions
       WHERE organization_id = $1 ORDER BY title, id`,
      [organizationId],
    );
    return {
      departments: departments.rows.map((department) => ({
        id: department.id,
        name: department.name,
        positions: positions.rows
          .filter((position) => position.department_id === department.id)
          .map((position) => ({
            id: position.id,
            title: position.title,
            roleMapping: position.role_mapping,
          })),
      })),
    };
  }

  async function createOrganizationDepartment(raw: {
    organizationId: string;
    name: string;
  }) {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const name = optionalText(raw.name, 'department name', 120);
    if (!name) throw new Error('department name is required');
    const id = `dept_${randomUUID()}`;
    const result = await input.pool.query<
      { id: string; name: string; created_at: Date | string; updated_at: Date | string } &
        Record<string, unknown>
    >(
      `INSERT INTO organization_departments (id, organization_id, name)
       VALUES ($1, $2, $3)
       RETURNING id, name, created_at, updated_at`,
      [id, organizationId, name],
    );
    await logAudit('organization_department_created', organizationId, null, {
      departmentId: id,
    });
    const row = result.rows[0]!;
    return {
      id: row.id,
      name: row.name,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async function updateOrganizationDepartment(raw: {
    organizationId: string;
    departmentId: string;
    name: string;
  }) {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const departmentId = requiredIdentifier(raw.departmentId, 'department id');
    const name = optionalText(raw.name, 'department name', 120);
    if (!name) throw new Error('department name is required');
    const result = await input.pool.query<
      { id: string; name: string; created_at: Date | string; updated_at: Date | string } &
        Record<string, unknown>
    >(
      `UPDATE organization_departments
       SET name = $3, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND id = $2
       RETURNING id, name, created_at, updated_at`,
      [organizationId, departmentId, name],
    );
    if (!result.rows[0]) throw new Error('department not found');
    await input.pool.query(
      `UPDATE accounts SET department = $3, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND department_id = $2 AND deleted_at IS NULL`,
      [organizationId, departmentId, name],
    );
    await logAudit('organization_department_updated', organizationId, null, {
      departmentId,
    });
    const row = result.rows[0];
    return {
      id: row.id,
      name: row.name,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async function deleteOrganizationDepartment(raw: {
    organizationId: string;
    departmentId: string;
  }): Promise<boolean> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const departmentId = requiredIdentifier(raw.departmentId, 'department id');
    return transaction(input.pool, async (client) => {
      const assigned = await client.query<{ count: number | string } & Record<string, unknown>>(
        `SELECT count(*)::integer AS count FROM accounts
         WHERE organization_id = $1 AND department_id = $2 AND deleted_at IS NULL`,
        [organizationId, departmentId],
      );
      if (Number(assigned.rows[0]?.count ?? 0) > 0) {
        throw new Error('department still has assigned accounts');
      }
      const deleted = await client.query(
        `DELETE FROM organization_departments
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, departmentId],
      );
      if (Number(deleted.rowCount ?? 0) === 1) {
        await logAudit('organization_department_deleted', organizationId, null, {
          departmentId,
        }, client);
        return true;
      }
      return false;
    });
  }

  async function createOrganizationPosition(raw: {
    organizationId: string;
    departmentId: string;
    title: string;
    roleMapping?: string | null;
  }) {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const departmentId = requiredIdentifier(raw.departmentId, 'department id');
    const title = optionalText(raw.title, 'position title', 120);
    if (!title) throw new Error('position title is required');
    const id = `pos_${randomUUID()}`;
    const result = await input.pool.query<
      {
        id: string;
        department_id: string;
        title: string;
        role_mapping: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      } & Record<string, unknown>
    >(
      `INSERT INTO organization_positions
        (id, organization_id, department_id, title, role_mapping)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, department_id, title, role_mapping, created_at, updated_at`,
      [id, organizationId, departmentId, title, optionalText(raw.roleMapping, 'role mapping', 120)],
    );
    await logAudit('organization_position_created', organizationId, null, {
      positionId: id,
    });
    const row = result.rows[0]!;
    return {
      id: row.id,
      departmentId: row.department_id,
      title: row.title,
      roleMapping: row.role_mapping,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async function updateOrganizationPosition(raw: {
    organizationId: string;
    positionId: string;
    title?: string;
    roleMapping?: string | null;
  }) {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const positionId = requiredIdentifier(raw.positionId, 'position id');
    const current = await input.pool.query<
      { title: string; role_mapping: string | null } & Record<string, unknown>
    >(
      `SELECT title, role_mapping FROM organization_positions
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, positionId],
    );
    if (!current.rows[0]) throw new Error('position not found');
    const title = raw.title === undefined
      ? current.rows[0].title
      : optionalText(raw.title, 'position title', 120);
    if (!title) throw new Error('position title is required');
    const roleMapping = raw.roleMapping === undefined
      ? current.rows[0].role_mapping
      : optionalText(raw.roleMapping, 'role mapping', 120);
    const result = await input.pool.query<
      {
        id: string;
        department_id: string;
        title: string;
        role_mapping: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      } & Record<string, unknown>
    >(
      `UPDATE organization_positions SET title = $3, role_mapping = $4,
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND id = $2
       RETURNING id, department_id, title, role_mapping, created_at, updated_at`,
      [organizationId, positionId, title, roleMapping],
    );
    await input.pool.query(
      `UPDATE accounts SET position_title = $3, role = COALESCE($4, role),
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND position_id = $2 AND deleted_at IS NULL`,
      [organizationId, positionId, title, roleMapping],
    );
    await logAudit('organization_position_updated', organizationId, null, {
      positionId,
    });
    const row = result.rows[0]!;
    return {
      id: row.id,
      departmentId: row.department_id,
      title: row.title,
      roleMapping: row.role_mapping,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async function deleteOrganizationPosition(raw: {
    organizationId: string;
    positionId: string;
  }): Promise<boolean> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const positionId = requiredIdentifier(raw.positionId, 'position id');
    return transaction(input.pool, async (client) => {
      const assigned = await client.query<{ count: number | string } & Record<string, unknown>>(
        `SELECT count(*)::integer AS count FROM accounts
         WHERE organization_id = $1 AND position_id = $2 AND deleted_at IS NULL`,
        [organizationId, positionId],
      );
      if (Number(assigned.rows[0]?.count ?? 0) > 0) {
        throw new Error('position still has assigned accounts');
      }
      const deleted = await client.query(
        `DELETE FROM organization_positions
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, positionId],
      );
      if (Number(deleted.rowCount ?? 0) === 1) {
        await logAudit('organization_position_deleted', organizationId, null, {
          positionId,
        }, client);
        return true;
      }
      return false;
    });
  }

  async function listAuditLogs(
    organizationIdValue: string,
    limitValue = 200,
  ): Promise<PostgresEnterpriseAuditRecord[]> {
    const organizationId = requiredIdentifier(organizationIdValue, 'organization id');
    const limit = Math.max(1, Math.min(1_000, Math.floor(limitValue)));
    const result = await input.pool.query<
      {
        id: number | string;
        organization_id: string;
        action: string;
        actor_employee_id: string | null;
        detail: Record<string, unknown> | string;
        created_at: Date | string;
      } & Record<string, unknown>
    >(
      `SELECT id, organization_id, action, actor_employee_id, detail, created_at
       FROM audit_logs WHERE organization_id = $1
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      organizationId: row.organization_id,
      action: row.action,
      actorEmployeeId: row.actor_employee_id,
      detail:
        typeof row.detail === 'string'
          ? (JSON.parse(row.detail) as Record<string, unknown>)
          : row.detail,
      createdAt: iso(row.created_at)!,
    }));
  }

  async function registerE2eeDevice(raw: E2eeDeviceRegistrationInput): Promise<E2eeDeviceView> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const deviceId = requiredIdentifier(raw.deviceId, 'device id');
    const deviceName = raw.deviceName.trim().slice(0, 120);
    if (!deviceName) throw new Error('device name is required');
    const signingKey = requirePublicKey(raw.identitySigningPublicKey, 'ed25519', 'identity signing public key');
    const exchangeKey = requirePublicKey(raw.deviceExchangePublicKey, 'x25519', 'device exchange public key');
    const fingerprint = e2eeDeviceKeyFingerprint({
      identitySigningPublicKey: signingKey,
      deviceExchangePublicKey: exchangeKey,
    });
    return transaction(input.pool, async (client) => {
      const account = await accountByCondition(
        client,
        `a.id = $1 AND a.organization_id = $2 AND a.status = 'active'
         AND a.deleted_at IS NULL AND o.status = 'active'`,
        [accountId, organizationId],
      );
      if (!account) throw new Error('device account is not active in organization');
      const existing = await client.query<DeviceRow>(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = $1 AND account_id = $2 AND device_id = $3
         FOR UPDATE`,
        [organizationId, accountId, deviceId],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          row.identity_signing_public_key !== signingKey ||
          row.device_exchange_public_key !== exchangeKey ||
          row.revoked_at !== null
        ) {
          throw new Error('E2EE device id is already bound or revoked');
        }
        const refreshed = await client.query<DeviceRow>(
          `UPDATE e2ee_devices SET device_name = $4, last_seen_at = CURRENT_TIMESTAMP
           WHERE organization_id = $1 AND account_id = $2 AND device_id = $3
           RETURNING *`,
          [organizationId, accountId, deviceId, deviceName],
        );
        return deviceView(refreshed.rows[0]!);
      }
      const approvedCount = await client.query<{ count: number | string } & Record<string, unknown>>(
        `SELECT count(*)::integer AS count FROM e2ee_devices
         WHERE organization_id = $1 AND account_id = $2
           AND approval_state = 'approved' AND revoked_at IS NULL`,
        [organizationId, accountId],
      );
      const firstDevice = Number(approvedCount.rows[0]?.count ?? 0) === 0;
      const inserted = await client.query<DeviceRow>(
        `INSERT INTO e2ee_devices
          (organization_id, account_id, device_id, device_name,
           identity_signing_public_key, device_exchange_public_key,
           key_fingerprint, approval_state, approved_by_device_id, approved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $8 = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END)
         RETURNING *`,
        [
          organizationId,
          accountId,
          deviceId,
          deviceName,
          signingKey,
          exchangeKey,
          fingerprint,
          firstDevice ? 'approved' : 'pending',
          firstDevice ? deviceId : null,
        ],
      );
      await appendTransparencyEntry(client, {
        organizationId,
        accountId,
        deviceId,
        event: firstDevice ? 'bootstrap_approved' : 'registered_pending',
        keyFingerprint: fingerprint,
        actorDeviceId: firstDevice ? deviceId : null,
      });
      await logAudit('e2ee_device_registered', organizationId, account.employee_id, {
        accountId,
        deviceId,
        approvalState: firstDevice ? 'approved' : 'pending',
      }, client);
      return deviceView(inserted.rows[0]!);
    });
  }

  async function listE2eeDevices(raw: {
    organizationId: string;
    requesterAccountId: string;
    accountIds?: string[];
    includeRevoked?: boolean;
    includePending?: boolean;
  }): Promise<E2eeDeviceView[]> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const requesterAccountId = requiredIdentifier(raw.requesterAccountId, 'requester account id');
    const accountIds = (raw.accountIds?.length ? raw.accountIds : [requesterAccountId]).map((id) =>
      requiredIdentifier(id, 'account id'),
    );
    if (accountIds.some((id) => id !== requesterAccountId)) {
      const requester = await getAccount(requesterAccountId, organizationId);
      if (!requester) throw new Error('requester account is unavailable');
    }
    const result = await input.pool.query<DeviceRow>(
      `SELECT * FROM e2ee_devices
       WHERE organization_id = $1 AND account_id = ANY($2::text[])
         AND ($3::boolean OR revoked_at IS NULL)
         AND ($4::boolean OR approval_state = 'approved')
       ORDER BY account_id, created_at, device_id`,
      [organizationId, accountIds, raw.includeRevoked === true, raw.includePending === true],
    );
    return result.rows.map(deviceView);
  }

  async function approveE2eeDevice(raw: E2eeDeviceApprovalInput): Promise<E2eeDeviceView> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const approverDeviceId = requiredIdentifier(raw.approverDeviceId, 'approver device id');
    const targetDeviceId = requiredIdentifier(raw.targetDeviceId, 'target device id');
    const targetKeyFingerprint = raw.targetKeyFingerprint.trim().toLowerCase();
    if (!KEY_FINGERPRINT.test(targetKeyFingerprint)) throw new Error('E2EE device key fingerprint is invalid');
    const signature = requireCanonicalBase64(raw.signature, 'device approval signature', 128);
    return transaction(input.pool, async (client) => {
      const devices = await client.query<DeviceRow>(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = $1 AND account_id = $2
           AND device_id = ANY($3::text[]) FOR UPDATE`,
        [organizationId, accountId, [approverDeviceId, targetDeviceId]],
      );
      const approver = devices.rows.find((device) => device.device_id === approverDeviceId);
      const target = devices.rows.find((device) => device.device_id === targetDeviceId);
      if (!approver || approver.approval_state !== 'approved' || approver.revoked_at) {
        throw new Error('approver device is not active and approved');
      }
      if (!target || target.revoked_at) throw new Error('target device is unavailable');
      if (target.key_fingerprint !== targetKeyFingerprint) throw new Error('target device fingerprint changed');
      if (!verify(null, e2eeDeviceApprovalSignaturePayload({
        organizationId,
        accountId,
        approverDeviceId,
        targetDeviceId,
        targetKeyFingerprint,
      }), approver.identity_signing_public_key, signature)) {
        throw new Error('device approval signature is invalid');
      }
      if (target.approval_state !== 'approved') {
        await client.query(
          `UPDATE e2ee_devices SET approval_state = 'approved',
             approved_by_device_id = $4, approved_at = CURRENT_TIMESTAMP,
             last_seen_at = CURRENT_TIMESTAMP
           WHERE organization_id = $1 AND account_id = $2 AND device_id = $3`,
          [organizationId, accountId, targetDeviceId, approverDeviceId],
        );
        await appendTransparencyEntry(client, {
          organizationId,
          accountId,
          deviceId: targetDeviceId,
          event: 'approved',
          keyFingerprint: targetKeyFingerprint,
          actorDeviceId: approverDeviceId,
        });
        await logAudit('e2ee_device_approved', organizationId, null, {
          accountId,
          approverDeviceId,
          targetDeviceId,
        }, client);
      }
      const updated = await client.query<DeviceRow>(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = $1 AND account_id = $2 AND device_id = $3`,
        [organizationId, accountId, targetDeviceId],
      );
      return deviceView(updated.rows[0]!);
    });
  }

  async function revokeE2eeDevice(raw: {
    organizationId: string;
    accountId: string;
    deviceId: string;
  }): Promise<boolean> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const deviceId = requiredIdentifier(raw.deviceId, 'device id');
    return transaction(input.pool, async (client) => {
      const result = await client.query<DeviceRow>(
        `UPDATE e2ee_devices SET revoked_at = CURRENT_TIMESTAMP,
           last_seen_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1 AND account_id = $2 AND device_id = $3
           AND revoked_at IS NULL RETURNING *`,
        [organizationId, accountId, deviceId],
      );
      const row = result.rows[0];
      if (!row) return false;
      await appendTransparencyEntry(client, {
        organizationId,
        accountId,
        deviceId,
        event: 'revoked',
        keyFingerprint: row.key_fingerprint,
        actorDeviceId: deviceId,
      });
      await logAudit('e2ee_device_revoked', organizationId, null, { accountId, deviceId }, client);
      return true;
    });
  }

  async function listE2eeKeyTransparency(raw: {
    organizationId: string;
    requesterAccountId: string;
    accountId: string;
  }): Promise<E2eeKeyTransparencyView> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    requiredIdentifier(raw.requesterAccountId, 'requester account id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const result = await input.pool.query<TransparencyRow>(
      `SELECT * FROM e2ee_key_transparency_log
       WHERE organization_id = $1 AND account_id = $2 ORDER BY sequence`,
      [organizationId, accountId],
    );
    const entries = result.rows.map(transparencyEntry);
    return {
      accountId,
      headSequence: entries.at(-1)?.sequence ?? 0,
      headHash: entries.at(-1)?.entryHash ?? EMPTY_TRANSPARENCY_HASH,
      entries,
    };
  }

  async function consumePostgresMlsRateLimit(input: {
    client: PostgresClientLike;
    organizationId: string;
    accountId: string;
    deviceId: string;
    action: MlsResourceRateAction;
    nowMs: number;
    limit: number;
  }): Promise<void> {
    const bucketStartedAt = new Date(
      Math.floor(input.nowMs / (60 * 1_000)) * 60 * 1_000,
    ).toISOString();
    const consumed = await input.client.query(
      `INSERT INTO mls_resource_rate_buckets
        (organization_id, account_id, device_id, action,
         bucket_started_at, request_count)
       VALUES ($1, $2, $3, $4, $5::timestamptz, 1)
       ON CONFLICT (
         organization_id, account_id, device_id, action, bucket_started_at
       ) DO UPDATE SET request_count =
         mls_resource_rate_buckets.request_count + 1
       WHERE mls_resource_rate_buckets.request_count < $6
       RETURNING request_count`,
      [
        input.organizationId,
        input.accountId,
        input.deviceId,
        input.action,
        bucketStartedAt,
        input.limit,
      ],
    );
    if (!consumed.rows[0]) {
      throw new Error(`MLS ${input.action} rate limit exceeded`);
    }
  }

  async function enforcePostgresMlsKeyPackageInventory(input: {
    client: PostgresClientLike;
    organizationId: string;
    deviceId: string;
    now: string;
  }): Promise<void> {
    await input.client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${input.organizationId}:mls-key-package-inventory`],
    );
    const inventory = await input.client.query<
      {
        device_count: number | string;
        organization_count: number | string;
      } & Record<string, unknown>
    >(
      `SELECT
         count(*) FILTER (WHERE device_id = $2)::integer AS device_count,
         count(*)::integer AS organization_count
       FROM mls_key_packages
       WHERE organization_id = $1 AND claimed_at IS NULL
         AND expires_at > $3::timestamptz`,
      [input.organizationId, input.deviceId, input.now],
    );
    const row = inventory.rows[0];
    if (
      !row ||
      Number(row.device_count) >=
        mlsResourcePolicy.maxUnclaimedKeyPackagesPerDevice
    ) {
      throw new Error('MLS KeyPackage device inventory quota exceeded');
    }
    if (
      Number(row.organization_count) >=
      mlsResourcePolicy.maxUnclaimedKeyPackagesPerOrganization
    ) {
      throw new Error('MLS KeyPackage organization inventory quota exceeded');
    }
  }

  async function enforcePostgresMlsTransportEventInventory(input: {
    client: PostgresClientLike;
    organizationId: string;
    conversationId: string;
    payloadStorageBytes: number;
    now: string;
  }): Promise<void> {
    await input.client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${input.organizationId}:mls-event-inventory`],
    );
    const usage = await input.client.query<
      {
        organization_count: number | string;
        organization_bytes: number | string;
        conversation_count: number | string;
        conversation_bytes: number | string;
      } & Record<string, unknown>
    >(
      `SELECT
         count(*)::integer AS organization_count,
         COALESCE(sum(octet_length(payload)), 0)::bigint AS organization_bytes,
         count(*) FILTER (WHERE conversation_id = $2)::integer
           AS conversation_count,
         COALESCE(sum(octet_length(payload)) FILTER (
           WHERE conversation_id = $2
         ), 0)::bigint AS conversation_bytes
       FROM mls_transport_events
       WHERE organization_id = $1 AND expires_at > $3::timestamptz`,
      [input.organizationId, input.conversationId, input.now],
    );
    const row = usage.rows[0];
    if (
      !row ||
      Number(row.conversation_count) >=
        mlsResourcePolicy.maxTransportEventsPerConversation ||
      Number(row.conversation_bytes) + input.payloadStorageBytes >
        mlsResourcePolicy.maxTransportEventBytesPerConversation
    ) {
      throw new Error('MLS conversation event inventory quota exceeded');
    }
    if (
      Number(row.organization_count) >=
        mlsResourcePolicy.maxTransportEventsPerOrganization ||
      Number(row.organization_bytes) + input.payloadStorageBytes >
        mlsResourcePolicy.maxTransportEventBytesPerOrganization
    ) {
      throw new Error('MLS organization event inventory quota exceeded');
    }
  }

  async function requirePostgresMlsParticipants(
    queryable: Queryable,
    organizationId: string,
    accountId: string,
    peerAccountId: string,
  ): Promise<void> {
    const participants = await queryable.query<
      { id: string } & Record<string, unknown>
    >(
      `SELECT account.id FROM accounts AS account
       JOIN organizations AS organization ON organization.id = account.organization_id
       WHERE account.organization_id = $1 AND account.id = ANY($2::text[])
         AND account.status = 'active' AND account.deleted_at IS NULL
         AND organization.status = 'active'`,
      [organizationId, [accountId, peerAccountId]],
    );
    if (new Set(participants.rows.map((row) => row.id)).size !== 2) {
      throw new Error('MLS participant is not active in organization');
    }
  }

  async function requirePostgresMlsDevice(
    queryable: Queryable,
    organizationId: string,
    accountId: string,
    deviceId: string,
  ): Promise<void> {
    const device = await queryable.query(
      `SELECT 1 FROM e2ee_devices
       WHERE organization_id = $1 AND account_id = $2 AND device_id = $3
         AND approval_state = 'approved' AND revoked_at IS NULL`,
      [organizationId, accountId, deviceId],
    );
    if (!device.rows[0])
      throw new Error('MLS device is not active and approved');
  }

  async function publishMlsKeyPackage(
    raw: PublishMlsKeyPackageInput,
  ): Promise<MlsKeyPackageView> {
    const organizationId = requiredIdentifier(
      raw.organizationId,
      'organization id',
    );
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const deviceId = requiredIdentifier(raw.deviceId, 'device id');
    if (raw.ciphersuite !== MLS_CIPHERSUITE) {
      throw new Error('MLS ciphersuite is unsupported');
    }
    const keyPackage = requireMlsBase64(
      raw.keyPackage,
      'MLS KeyPackage',
      MLS_KEY_PACKAGE_MAX_BYTES,
    );
    const reference = mlsKeyPackageReference(keyPackage);
    const now = mlsNow();
    return transaction(input.pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${organizationId}:mls-key-package:${reference}`],
      );
      const account = await client.query(
        `SELECT account.id FROM accounts AS account
         JOIN organizations AS organization ON organization.id = account.organization_id
         WHERE account.organization_id = $1 AND account.id = $2
           AND account.status = 'active' AND account.deleted_at IS NULL
           AND organization.status = 'active'`,
        [organizationId, accountId],
      );
      if (!account.rows[0]) {
        throw new Error('MLS participant is not active in organization');
      }
      await requirePostgresMlsDevice(
        client,
        organizationId,
        accountId,
        deviceId,
      );
      const existing = await client.query<MlsKeyPackageRow>(
        `SELECT * FROM mls_key_packages
         WHERE organization_id = $1 AND key_package_reference = $2
         FOR UPDATE`,
        [organizationId, reference],
      );
      const row = existing.rows[0];
      if (row) {
        if (
          row.account_id !== accountId ||
          row.device_id !== deviceId ||
          row.ciphersuite !== raw.ciphersuite ||
          row.key_package !== keyPackage ||
          row.claimed_at !== null ||
          iso(row.expires_at)! <= now.iso
        ) {
          throw new Error('MLS KeyPackage reference conflict or reuse');
        }
        return mlsKeyPackageView(row);
      }
      await consumePostgresMlsRateLimit({
        client,
        organizationId,
        accountId,
        deviceId,
        action: 'key_package_publish',
        nowMs: now.milliseconds,
        limit: mlsResourcePolicy.keyPackagePublishesPerMinute,
      });
      await enforcePostgresMlsKeyPackageInventory({
        client,
        organizationId,
        deviceId,
        now: now.iso,
      });
      const inserted = await client.query<MlsKeyPackageRow>(
        `INSERT INTO mls_key_packages
          (organization_id, key_package_reference, account_id, device_id,
           ciphersuite, key_package, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         RETURNING *`,
        [
          organizationId,
          reference,
          accountId,
          deviceId,
          raw.ciphersuite,
          keyPackage,
          new Date(
            now.milliseconds + mlsResourcePolicy.keyPackageTtlMs,
          ).toISOString(),
        ],
      );
      return mlsKeyPackageView(inserted.rows[0]!);
    });
  }

  async function claimMlsKeyPackage(
    raw: ClaimMlsKeyPackageInput,
  ): Promise<MlsKeyPackageView | null> {
    const organizationId = requiredIdentifier(
      raw.organizationId,
      'organization id',
    );
    const requesterAccountId = requiredIdentifier(
      raw.requesterAccountId,
      'requester account id',
    );
    const requesterDeviceId = requiredIdentifier(
      raw.requesterDeviceId,
      'requester device id',
    );
    const recipientAccountId = requiredIdentifier(
      raw.recipientAccountId,
      'recipient account id',
    );
    mlsDirectConversation({
      organizationId,
      accountId: requesterAccountId,
      peerAccountId: recipientAccountId,
    });
    const now = mlsNow();
    return transaction(input.pool, async (client) => {
      await requirePostgresMlsParticipants(
        client,
        organizationId,
        requesterAccountId,
        recipientAccountId,
      );
      await requirePostgresMlsDevice(
        client,
        organizationId,
        requesterAccountId,
        requesterDeviceId,
      );
      const available = await client.query<MlsKeyPackageRow>(
        `SELECT package.* FROM mls_key_packages AS package
         JOIN e2ee_devices AS device
           ON device.organization_id = package.organization_id
          AND device.account_id = package.account_id
          AND device.device_id = package.device_id
         WHERE package.organization_id = $1 AND package.account_id = $2
           AND package.claimed_at IS NULL
           AND package.expires_at > $3::timestamptz
           AND device.approval_state = 'approved' AND device.revoked_at IS NULL
         ORDER BY package.created_at, package.key_package_reference
         LIMIT 1 FOR UPDATE OF package SKIP LOCKED`,
        [organizationId, recipientAccountId, now.iso],
      );
      const row = available.rows[0];
      if (!row) return null;
      const claimed = await client.query<MlsKeyPackageRow>(
        `UPDATE mls_key_packages
         SET claimed_at = CURRENT_TIMESTAMP, claimed_by_account_id = $3,
             claimed_by_device_id = $4, expires_at = $5::timestamptz
         WHERE organization_id = $1 AND key_package_reference = $2
           AND claimed_at IS NULL
         RETURNING *`,
        [
          organizationId,
          row.key_package_reference,
          requesterAccountId,
          requesterDeviceId,
          new Date(
            now.milliseconds + mlsResourcePolicy.claimedKeyPackageTtlMs,
          ).toISOString(),
        ],
      );
      return claimed.rows[0] ? mlsKeyPackageView(claimed.rows[0]) : null;
    });
  }

  async function appendMlsTransportEvent(
    raw: AppendMlsTransportEventInput,
  ): Promise<MlsTransportEventView> {
    const organizationId = requiredIdentifier(
      raw.organizationId,
      'organization id',
    );
    const senderAccountId = requiredIdentifier(
      raw.senderAccountId,
      'sender account id',
    );
    const peerAccountId = requiredIdentifier(
      raw.peerAccountId,
      'peer account id',
    );
    const senderDeviceId = requiredIdentifier(
      raw.senderDeviceId,
      'sender device id',
    );
    const eventId = requiredIdentifier(raw.eventId, 'MLS event id');
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
        ? requiredIdentifier(raw.recipientDeviceId ?? '', 'recipient device id')
        : null;
    const keyPackageReference =
      raw.eventType === 'welcome'
        ? requireMlsKeyPackageReference(raw.keyPackageReference ?? '')
        : null;
    const resetFromGroupId = raw.resetFromGroupId
      ? requireMlsBase64(
          raw.resetFromGroupId,
          'MLS reset source group id',
          255,
        )
      : null;
    if (
      raw.eventType !== 'welcome' &&
      (raw.recipientDeviceId || raw.keyPackageReference)
    ) {
      throw new Error('only MLS Welcome may target a KeyPackage device');
    }
    if (
      resetFromGroupId &&
      (raw.eventType !== 'commit' ||
        epoch !== 1 ||
        resetFromGroupId === groupId)
    ) {
      throw new Error(
        'explicit MLS session reset requires an epoch 1 Commit for a new group',
      );
    }
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
    const now = mlsNow();
    return transaction(input.pool, async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${organizationId}:mls-event:${eventId}`],
      );
      await requirePostgresMlsParticipants(
        client,
        organizationId,
        senderAccountId,
        peerAccountId,
      );
      await requirePostgresMlsDevice(
        client,
        organizationId,
        senderAccountId,
        senderDeviceId,
      );
      const existing = await client.query<MlsEventRow>(
        `SELECT * FROM mls_transport_events
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, eventId],
      );
      if (existing.rows[0]) {
        if (!postgresMlsEventMatches(existing.rows[0], normalized)) {
          throw new Error('MLS event idempotency conflict');
        }
        if (iso(existing.rows[0].expires_at)! <= now.iso) {
          throw new Error(
            'MLS event cursor expired; secure session reset required',
          );
        }
        return mlsEventView(existing.rows[0]);
      }

      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${organizationId}:mls-conversation:${direct.conversationId}`],
      );
      await consumePostgresMlsRateLimit({
        client,
        organizationId,
        accountId: senderAccountId,
        deviceId: senderDeviceId,
        action: 'transport_event_append',
        nowMs: now.milliseconds,
        limit: mlsResourcePolicy.transportEventsPerMinute,
      });
      await enforcePostgresMlsTransportEventInventory({
        client,
        organizationId,
        conversationId: direct.conversationId,
        payloadStorageBytes: Buffer.byteLength(payload, 'utf8'),
        now: now.iso,
      });

      const conversationResult = await client.query<MlsConversationRow>(
        `SELECT * FROM mls_conversations
         WHERE organization_id = $1 AND conversation_id = $2 FOR UPDATE`,
        [organizationId, direct.conversationId],
      );
      const conversation = conversationResult.rows[0];
      let sessionGeneration = 1;
      if (!conversation) {
        if (raw.eventType !== 'commit' || epoch !== 1 || resetFromGroupId) {
          throw new Error(
            'first MLS transport event must be the epoch 1 commit',
          );
        }
        await client.query(
          `INSERT INTO mls_conversations
            (organization_id, conversation_id, participant_a_account_id,
             participant_b_account_id, group_id, current_epoch,
             active_generation)
           VALUES ($1, $2, $3, $4, $5, 1, 1)`,
          [
            organizationId,
            direct.conversationId,
            direct.participantAAccountId,
            direct.participantBAccountId,
            groupId,
          ],
        );
        await client.query(
          `INSERT INTO mls_group_sessions
            (organization_id, conversation_id, generation, group_id,
             current_epoch, status, created_at)
           VALUES ($1, $2, 1, $3, 1, 'active', $4::timestamptz)`,
          [organizationId, direct.conversationId, groupId, now.iso],
        );
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
          const reused = await client.query(
            `SELECT 1 FROM mls_group_sessions
             WHERE organization_id = $1 AND conversation_id = $2
               AND group_id = $3`,
            [organizationId, direct.conversationId, groupId],
          );
          if (reused.rows[0]) {
            throw new Error('MLS reset group id was already used');
          }
          const retired = await client.query<MlsGroupSessionRow>(
            `UPDATE mls_group_sessions
             SET status = 'retired', retired_at = $4::timestamptz
             WHERE organization_id = $1 AND conversation_id = $2
               AND generation = $3 AND status = 'active'
             RETURNING *`,
            [
              organizationId,
              direct.conversationId,
              sessionGeneration,
              now.iso,
            ],
          );
          if (!retired.rows[0]) {
            throw new Error('MLS active group session state is inconsistent');
          }
          sessionGeneration += 1;
          await client.query(
            `UPDATE mls_conversations
             SET group_id = $3, current_epoch = 1,
                 active_generation = $4, updated_at = $5::timestamptz
             WHERE organization_id = $1 AND conversation_id = $2`,
            [
              organizationId,
              direct.conversationId,
              groupId,
              sessionGeneration,
              now.iso,
            ],
          );
          await client.query(
            `INSERT INTO mls_group_sessions
              (organization_id, conversation_id, generation, group_id,
               current_epoch, status, created_at, reset_by_account_id,
               reset_by_device_id, reset_event_id)
             VALUES ($1, $2, $3, $4, 1, 'active', $5::timestamptz,
                     $6, $7, $8)`,
            [
              organizationId,
              direct.conversationId,
              sessionGeneration,
              groupId,
              now.iso,
              senderAccountId,
              senderDeviceId,
              eventId,
            ],
          );
        } else {
          if (resetFromGroupId) {
            throw new Error('MLS reset target group must be new');
          }
          if (raw.eventType === 'commit') {
            if (epoch !== Number(conversation.current_epoch) + 1) {
              throw new Error('MLS commit must advance to the next epoch');
            }
            await client.query(
              `UPDATE mls_conversations
               SET current_epoch = $3, updated_at = $4::timestamptz
               WHERE organization_id = $1 AND conversation_id = $2`,
              [organizationId, direct.conversationId, epoch, now.iso],
            );
            const sessionUpdated = await client.query<MlsGroupSessionRow>(
              `UPDATE mls_group_sessions SET current_epoch = $4
               WHERE organization_id = $1 AND conversation_id = $2
                 AND generation = $3 AND status = 'active'
               RETURNING *`,
              [
                organizationId,
                direct.conversationId,
                sessionGeneration,
                epoch,
              ],
            );
            if (!sessionUpdated.rows[0]) {
              throw new Error(
                'MLS active group session state is inconsistent',
              );
            }
          } else if (epoch !== Number(conversation.current_epoch)) {
            throw new Error('MLS event must use the current epoch');
          }
        }
      }

      if (raw.eventType === 'welcome') {
        await requirePostgresMlsDevice(
          client,
          organizationId,
          peerAccountId,
          recipientDeviceId!,
        );
        const claimed = await client.query<MlsKeyPackageRow>(
          `SELECT * FROM mls_key_packages
           WHERE organization_id = $1 AND key_package_reference = $2
           FOR UPDATE`,
          [organizationId, keyPackageReference],
        );
        const packageRow = claimed.rows[0];
        if (
          !packageRow ||
          packageRow.account_id !== peerAccountId ||
          packageRow.device_id !== recipientDeviceId ||
          packageRow.claimed_by_account_id !== senderAccountId ||
          packageRow.claimed_by_device_id !== senderDeviceId ||
          !packageRow.claimed_at ||
          packageRow.welcome_event_id ||
          iso(packageRow.expires_at)! <= now.iso
        ) {
          throw new Error(
            'MLS Welcome does not match an unused KeyPackage claim for this device',
          );
        }
      }

      const inserted = await client.query<MlsEventRow>(
        `INSERT INTO mls_transport_events
          (id, organization_id, conversation_id, session_generation,
           sender_account_id,
           sender_device_id, recipient_account_id, recipient_device_id,
           event_type, epoch, group_id, payload, key_package_reference,
           expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14::timestamptz)
         RETURNING *`,
        [
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
          new Date(
            now.milliseconds + mlsResourcePolicy.transportEventTtlMs,
          ).toISOString(),
        ],
      );
      if (raw.eventType === 'welcome') {
        await client.query(
          `UPDATE mls_key_packages SET welcome_event_id = $3
           WHERE organization_id = $1 AND key_package_reference = $2`,
          [organizationId, keyPackageReference, eventId],
        );
      }
      return mlsEventView(inserted.rows[0]!);
    });
  }

  async function listMlsTransportEvents(raw: {
    organizationId: string;
    accountId: string;
    peerAccountId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<MlsTransportEventView[]> {
    const organizationId = requiredIdentifier(
      raw.organizationId,
      'organization id',
    );
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const peerAccountId = requiredIdentifier(
      raw.peerAccountId,
      'peer account id',
    );
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
    await requirePostgresMlsParticipants(
      input.pool,
      organizationId,
      accountId,
      peerAccountId,
    );
    const now = mlsNow();
    const retention = await input.pool.query<
      {
        retention_floor_sequence: number | string;
        expired_floor_sequence: number | string;
      } & Record<string, unknown>
    >(
      `SELECT conversation.retention_floor_sequence,
              COALESCE(MAX(event.sequence) FILTER (
                WHERE event.expires_at <= $3::timestamptz
              ), 0)::bigint AS expired_floor_sequence
       FROM mls_conversations AS conversation
       LEFT JOIN mls_transport_events AS event
         ON event.organization_id = conversation.organization_id
        AND event.conversation_id = conversation.conversation_id
       WHERE conversation.organization_id = $1
         AND conversation.conversation_id = $2
       GROUP BY conversation.retention_floor_sequence`,
      [organizationId, direct.conversationId, now.iso],
    );
    const retentionFloor = Math.max(
      Number(retention.rows[0]?.retention_floor_sequence ?? 0),
      Number(retention.rows[0]?.expired_floor_sequence ?? 0),
    );
    if (afterSequence < retentionFloor) {
      throw new Error('MLS event cursor expired; secure session reset required');
    }
    const events = await input.pool.query<MlsEventRow>(
      `SELECT event.* FROM mls_transport_events AS event
       JOIN mls_conversations AS conversation
         ON conversation.organization_id = event.organization_id
        AND conversation.conversation_id = event.conversation_id
       WHERE event.organization_id = $1 AND event.conversation_id = $2
         AND event.sequence > $3
         AND event.expires_at > $4::timestamptz
         AND $5 IN (
           conversation.participant_a_account_id,
           conversation.participant_b_account_id
         )
       ORDER BY event.sequence LIMIT $6`,
      [
        organizationId,
        direct.conversationId,
        afterSequence,
        now.iso,
        accountId,
        limit,
      ],
    );
    return events.rows.map(mlsEventView);
  }

  async function cleanupExpiredMlsResources(
    raw: { before?: string; limit?: number } = {},
  ): Promise<MlsResourceCleanupResult> {
    const parsedBefore = raw.before ? new Date(raw.before) : new Date(mlsNow().iso);
    if (Number.isNaN(parsedBefore.getTime())) {
      throw new Error('MLS cleanup timestamp is invalid');
    }
    const before = parsedBefore.toISOString();
    const limit = raw.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
      throw new Error('MLS cleanup limit is invalid');
    }
    return transaction(input.pool, async (client) => {
      const lease = await client.query<
        { locked: boolean } & Record<string, unknown>
      >(
        `SELECT pg_try_advisory_xact_lock(
           hashtextextended('otto:mls-resource-cleanup:v1', 0)
         ) AS locked`,
      );
      if (lease.rows[0]?.locked !== true) {
        return {
          eventsDeleted: 0,
          keyPackagesDeleted: 0,
          groupSessionsDeleted: 0,
          rateBucketsDeleted: 0,
          conversationsAdvanced: 0,
        };
      }
      const expiredEvents = await client.query<
        {
          sequence: number | string;
          organization_id: string;
          conversation_id: string;
        } & Record<string, unknown>
      >(
        `SELECT sequence, organization_id, conversation_id
         FROM mls_transport_events
         WHERE expires_at <= $1::timestamptz
         ORDER BY sequence LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [before, limit],
      );
      const floors = new Map<string, (typeof expiredEvents.rows)[number]>();
      for (const event of expiredEvents.rows) {
        const key = `${event.organization_id}\n${event.conversation_id}`;
        const current = floors.get(key);
        if (!current || Number(event.sequence) > Number(current.sequence)) {
          floors.set(key, event);
        }
      }
      for (const floor of floors.values()) {
        await client.query(
          `UPDATE mls_conversations
           SET retention_floor_sequence = GREATEST(
             retention_floor_sequence, $3::bigint
           )
           WHERE organization_id = $1 AND conversation_id = $2`,
          [floor.organization_id, floor.conversation_id, floor.sequence],
        );
      }
      let eventsDeleted = 0;
      if (expiredEvents.rows.length > 0) {
        const deleted = await client.query(
          `DELETE FROM mls_transport_events
           WHERE sequence = ANY($1::bigint[]) RETURNING sequence`,
          [expiredEvents.rows.map((event) => String(event.sequence))],
        );
        eventsDeleted = deleted.rows.length;
      }
      const deletedGroupSessions = await client.query(
        `WITH candidates AS (
           SELECT session.organization_id, session.conversation_id,
                  session.generation
           FROM mls_group_sessions AS session
           WHERE session.status = 'retired'
             AND session.retired_at <= $1::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM mls_transport_events AS event
               WHERE event.organization_id = session.organization_id
                 AND event.conversation_id = session.conversation_id
                 AND event.session_generation = session.generation
             )
           ORDER BY session.retired_at, session.generation
           LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM mls_group_sessions AS session USING candidates
         WHERE session.organization_id = candidates.organization_id
           AND session.conversation_id = candidates.conversation_id
           AND session.generation = candidates.generation
           AND session.status = 'retired'
         RETURNING session.generation`,
        [before, limit],
      );
      const deletedPackages = await client.query(
        `WITH candidates AS (
           SELECT package.organization_id, package.key_package_reference
           FROM mls_key_packages AS package
           WHERE package.expires_at <= $1::timestamptz
             AND NOT EXISTS (
               SELECT 1 FROM mls_transport_events AS event
               WHERE event.organization_id = package.organization_id
                 AND event.key_package_reference = package.key_package_reference
             )
           ORDER BY package.expires_at, package.key_package_reference
           LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM mls_key_packages AS package USING candidates
         WHERE package.organization_id = candidates.organization_id
           AND package.key_package_reference = candidates.key_package_reference
         RETURNING package.key_package_reference`,
        [before, limit],
      );
      const deletedRateBuckets = await client.query(
        `WITH candidates AS (
           SELECT ctid FROM mls_resource_rate_buckets
           WHERE bucket_started_at < $1::timestamptz - INTERVAL '2 minutes'
           ORDER BY bucket_started_at LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         DELETE FROM mls_resource_rate_buckets AS bucket USING candidates
         WHERE bucket.ctid = candidates.ctid RETURNING bucket.ctid`,
        [before, limit],
      );
      return {
        eventsDeleted,
        keyPackagesDeleted: deletedPackages.rows.length,
        groupSessionsDeleted: deletedGroupSessions.rows.length,
        rateBucketsDeleted: deletedRateBuckets.rows.length,
        conversationsAdvanced: floors.size,
      };
    });
  }

  async function sendE2eeDirectMessage(
    raw: SendPostgresE2eeDirectMessageInput,
  ): Promise<E2eeDirectMessageView> {
    if (raw.protocolVersion !== E2EE_PROTOCOL_VERSION) throw new Error('E2EE protocol version is unsupported');
    if ((raw.attachments?.length ?? 0) > E2EE_ATTACHMENT_MAX_COUNT) {
      throw new Error('a message can contain at most 6 encrypted attachments');
    }
    if ((raw.attachments?.length ?? 0) > 0) {
      throw new Error(
        'clustered E2EE attachments must be uploaded before sending the message',
      );
    }
    const attachmentReferences = (raw.attachmentReferences ?? []).map(
      normalizeAttachmentReference,
    );
    if (attachmentReferences.length > E2EE_ATTACHMENT_MAX_COUNT) {
      throw new Error('a message can contain at most 6 encrypted attachments');
    }
    if (
      new Set(attachmentReferences.map((reference) => reference.id)).size !==
      attachmentReferences.length
    ) {
      throw new Error('encrypted attachment ids must be unique');
    }
    const normalized = {
      ...raw,
      organizationId: requiredIdentifier(raw.organizationId, 'organization id'),
      senderAccountId: requiredIdentifier(raw.senderAccountId, 'sender account id'),
      recipientAccountId: requiredIdentifier(raw.recipientAccountId, 'recipient account id'),
      messageId: requiredIdentifier(raw.messageId, 'message id'),
      senderDeviceId: requiredIdentifier(raw.senderDeviceId, 'sender device id'),
      inReplyToMessageId: raw.inReplyToMessageId
        ? requiredIdentifier(raw.inReplyToMessageId, 'reply message id')
        : null,
      ciphertext: requireCanonicalBase64(
        raw.ciphertext,
        'message ciphertext',
        E2EE_MESSAGE_MAX_CIPHERTEXT_BYTES,
      ).toString('base64'),
      nonce: requireNonce(raw.nonce, 'message nonce'),
      signature: requireCanonicalBase64(raw.signature, 'message signature', 128).toString('base64'),
      envelopes: raw.envelopes.map((envelope) => ({
        accountId: requiredIdentifier(envelope.accountId, 'envelope account id'),
        deviceId: requiredIdentifier(envelope.deviceId, 'envelope device id'),
        ephemeralPublicKey: requirePublicKey(
          envelope.ephemeralPublicKey,
          'x25519',
          'envelope ephemeral public key',
        ),
        wrappedKey: requireCanonicalBase64(envelope.wrappedKey, 'wrapped key', 128).toString('base64'),
        nonce: requireNonce(envelope.nonce, 'envelope nonce'),
      })),
      attachmentReferences,
    };
    if (normalized.senderAccountId === normalized.recipientAccountId) {
      throw new Error('sender and recipient must be different');
    }
    if (!['message', 'atoa_request', 'atoa_response'].includes(normalized.contentType)) {
      throw new Error('E2EE content type is invalid');
    }
    if ((normalized.contentType === 'atoa_response') !== Boolean(normalized.inReplyToMessageId)) {
      throw new Error('A2A responses must reference exactly one request');
    }
    return transaction(input.pool, async (client) => {
      const accounts = await client.query<{ id: string } & Record<string, unknown>>(
        `SELECT a.id FROM accounts AS a JOIN organizations AS o ON o.id = a.organization_id
         WHERE a.organization_id = $1 AND a.id = ANY($2::text[])
           AND a.status = 'active' AND a.deleted_at IS NULL AND o.status = 'active'`,
        [normalized.organizationId, [normalized.senderAccountId, normalized.recipientAccountId]],
      );
      if (new Set(accounts.rows.map((row) => row.id)).size !== 2) {
        throw new Error('message participant is not active in organization');
      }
      if (normalized.attachmentReferences.length > 0) {
        const available = await client.query<
          {
            id: string;
            ciphertext_bytes: number | string;
            ciphertext_sha256: string;
          } & Record<string, unknown>
        >(
          `SELECT object.id, object.ciphertext_bytes, object.ciphertext_sha256
           FROM attachment_objects AS object
           WHERE object.organization_id = $1
             AND object.owner_account_id = $2
             AND object.state = 'available'
             AND object.migration_state <> 'orphan_cleaning'
             AND object.id = ANY($4::text[])
             AND EXISTS (
               SELECT 1 FROM attachment_object_access AS sender_access
               WHERE sender_access.attachment_id = object.id
                 AND sender_access.organization_id = object.organization_id
                 AND sender_access.account_id = $2
             )
             AND EXISTS (
               SELECT 1 FROM attachment_object_access AS recipient_access
               WHERE recipient_access.attachment_id = object.id
                 AND recipient_access.organization_id = object.organization_id
                 AND recipient_access.account_id = $3
             )`,
          [
            normalized.organizationId,
            normalized.senderAccountId,
            normalized.recipientAccountId,
            normalized.attachmentReferences.map((reference) => reference.id),
          ],
        );
        const availableById = new Map(
          available.rows.map((row) => [row.id, row] as const),
        );
        for (const reference of normalized.attachmentReferences) {
          const object = availableById.get(reference.id);
          if (
            !object ||
            Number(object.ciphertext_bytes) !== reference.ciphertextBytes ||
            object.ciphertext_sha256 !== reference.ciphertextSha256
          ) {
            throw new Error(
              'attachment is unavailable or does not match its ciphertext metadata',
            );
          }
        }
      }
      const devices = await client.query<DeviceRow>(
        `SELECT * FROM e2ee_devices
         WHERE organization_id = $1 AND account_id = ANY($2::text[])
           AND approval_state = 'approved' AND revoked_at IS NULL
         ORDER BY account_id, device_id`,
        [normalized.organizationId, [normalized.senderAccountId, normalized.recipientAccountId]],
      );
      const senderDevice = devices.rows.find(
        (device) =>
          device.account_id === normalized.senderAccountId &&
          device.device_id === normalized.senderDeviceId,
      );
      if (!senderDevice) throw new Error('sender E2EE device is not registered or was revoked');
      if (!devices.rows.some((device) => device.account_id === normalized.recipientAccountId)) {
        throw new Error('recipient has no active E2EE device');
      }
      const expectedEnvelopes = devices.rows
        .map((device) => `${device.account_id}:${device.device_id}`)
        .sort();
      const actualEnvelopes = normalized.envelopes
        .map((envelope) => `${envelope.accountId}:${envelope.deviceId}`)
        .sort();
      if (
        new Set(actualEnvelopes).size !== actualEnvelopes.length ||
        JSON.stringify(actualEnvelopes) !== JSON.stringify(expectedEnvelopes)
      ) {
        throw new Error('message key envelopes must cover every active participant device exactly once');
      }
      const {
        signature: _signature,
        attachmentReferences: _attachmentReferences,
        ...unsigned
      } = normalized;
      const signaturePayload = e2eeMessageSignaturePayload({
        ...unsigned,
        attachments: [],
      });
      if (!verify(
        null,
        signaturePayload,
        senderDevice.identity_signing_public_key,
        Buffer.from(normalized.signature, 'base64'),
      )) {
        throw new Error('message signature is invalid');
      }
      if (normalized.inReplyToMessageId) {
        const request = await client.query(
          `SELECT id FROM direct_messages
           WHERE id = $1 AND organization_id = $2
             AND sender_account_id = $3 AND recipient_account_id = $4
             AND content_type = 'atoa_request' AND e2ee_protocol_version = 1`,
          [
            normalized.inReplyToMessageId,
            normalized.organizationId,
            normalized.recipientAccountId,
            normalized.senderAccountId,
          ],
        );
        if (!request.rows[0]) throw new Error('referenced A2A request does not exist');
      }
      await client.query(
        `INSERT INTO direct_messages
          (id, organization_id, sender_account_id, recipient_account_id,
           content_type, e2ee_protocol_version, e2ee_sender_device_id,
           e2ee_ciphertext, e2ee_nonce, e2ee_signature, e2ee_envelopes,
           in_reply_to_message_id)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
          normalized.messageId,
          normalized.organizationId,
          normalized.senderAccountId,
          normalized.recipientAccountId,
          normalized.contentType,
          normalized.senderDeviceId,
          normalized.ciphertext,
          normalized.nonce,
          normalized.signature,
          JSON.stringify(normalized.envelopes),
          normalized.inReplyToMessageId,
        ],
      );
      for (const [ordinal, attachment] of normalized.attachmentReferences.entries()) {
        await client.query(
          `INSERT INTO direct_message_attachment_objects
             (attachment_id, message_id, organization_id, ordinal, e2ee_nonce,
              ciphertext_bytes, ciphertext_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            attachment.id,
            normalized.messageId,
            normalized.organizationId,
            ordinal,
            attachment.nonce,
            attachment.ciphertextBytes,
            attachment.ciphertextSha256,
          ],
        );
      }
      if (normalized.inReplyToMessageId) {
        await client.query(
          `UPDATE direct_messages SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE id = $1 AND organization_id = $2`,
          [normalized.inReplyToMessageId, normalized.organizationId],
        );
      }
      const stored = await client.query<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.id = $1`,
        [normalized.messageId],
      );
      return messageView(stored.rows[0]!);
    });
  }

  async function listE2eeDirectMessages(raw: {
    organizationId: string;
    accountId: string;
    peerAccountId: string;
    limit?: number;
  }): Promise<E2eeDirectMessageView[]> {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const peerAccountId = requiredIdentifier(raw.peerAccountId, 'peer account id');
    const limit = Math.max(1, Math.min(200, Math.floor(raw.limit ?? 100)));
    return transaction(input.pool, async (client) => {
      await client.query(
        `UPDATE direct_messages SET read_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1 AND sender_account_id = $2
           AND recipient_account_id = $3 AND read_at IS NULL`,
        [organizationId, peerAccountId, accountId],
      );
      const result = await client.query<MessageRow>(
        `${MESSAGE_SELECT}
         WHERE m.organization_id = $1
           AND m.e2ee_protocol_version = 1
           AND ((m.sender_account_id = $2 AND m.recipient_account_id = $3)
             OR (m.sender_account_id = $3 AND m.recipient_account_id = $2))
         ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
        [organizationId, accountId, peerAccountId, limit],
      );
      return result.rows.reverse().map(messageView);
    });
  }

  async function getE2eeAttachmentAuthority(raw: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
  }): Promise<PostgresE2eeAttachmentAuthority | null> {
    const organizationId = requiredIdentifier(
      raw.organizationId,
      'organization id',
    );
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const attachmentId = requiredIdentifier(raw.attachmentId, 'attachment id');
    const result = await input.pool.query<MessageRow>(
      `${MESSAGE_SELECT}
       JOIN direct_message_attachment_objects AS requested_attachment
         ON requested_attachment.message_id = m.id
        AND requested_attachment.organization_id = m.organization_id
       JOIN attachment_objects AS requested_object
         ON requested_object.id = requested_attachment.attachment_id
        AND requested_object.organization_id = requested_attachment.organization_id
       WHERE requested_attachment.attachment_id = $1
         AND m.organization_id = $2
         AND $3 IN (m.sender_account_id, m.recipient_account_id)
         AND requested_object.state = 'available'
         AND EXISTS (
           SELECT 1 FROM attachment_object_access AS requested_access
           WHERE requested_access.attachment_id = requested_object.id
             AND requested_access.organization_id = requested_object.organization_id
             AND requested_access.account_id = $3
         )`,
      [attachmentId, organizationId, accountId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const message = messageView(row);
    const reference = message.attachments.find(
      (attachment) => attachment.id === attachmentId,
    );
    if (!reference) {
      throw new Error('stored E2EE attachment reference is unavailable');
    }
    const object = await input.pool.query<
      { ciphertext_sha256: string } & Record<string, unknown>
    >(
      `SELECT ciphertext_sha256 FROM attachment_objects
       WHERE id = $1 AND organization_id = $2 AND state = 'available'`,
      [attachmentId, organizationId],
    );
    const checksum = object.rows[0]?.ciphertext_sha256;
    if (!checksum) {
      throw new Error('stored E2EE attachment object is unavailable');
    }
    return {
      message,
      attachment: {
        id: reference.id,
        nonce: reference.nonce,
        ciphertextBytes: reference.ciphertextSize,
        ciphertextSha256: checksum,
      },
    };
  }

  async function claimExpiredUnboundAttachments(raw: {
    before: string;
    limit?: number;
  }): Promise<PostgresUnboundAttachmentObject[]> {
    const before = new Date(raw.before);
    if (!Number.isFinite(before.getTime())) {
      throw new Error('attachment cleanup cutoff is invalid');
    }
    const limit = Math.max(1, Math.min(500, Math.floor(raw.limit ?? 100)));
    const result = await input.pool.query<
      {
        id: string;
        organization_id: string;
        storage_key: string;
        ciphertext_bytes: number | string;
      } & Record<string, unknown>
    >(
      `WITH candidates AS (
         SELECT object.id
         FROM attachment_objects AS object
         WHERE object.state = 'available'
           AND object.storage_backend = 's3'
           AND object.storage_key IS NOT NULL
           AND object.legal_hold = FALSE
           AND object.expires_at <= $1
           AND object.migration_state IN ('none', 'orphan_cleaning')
           AND NOT EXISTS (
             SELECT 1 FROM direct_message_attachment_objects AS reference
             WHERE reference.attachment_id = object.id
           )
         ORDER BY object.expires_at, object.id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE attachment_objects AS object
       SET migration_state = 'orphan_cleaning',
           updated_at = CURRENT_TIMESTAMP,
           version = version + 1
       FROM candidates
       WHERE object.id = candidates.id
       RETURNING object.id, object.organization_id, object.storage_key,
                 object.ciphertext_bytes`,
      [before.toISOString(), limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      key: row.storage_key,
      ciphertextBytes: Number(row.ciphertext_bytes),
    }));
  }

  async function completeExpiredUnboundAttachment(
    attachment: PostgresUnboundAttachmentObject,
  ): Promise<void> {
    await transaction(input.pool, async (client) => {
      const failed = await client.query<
        { organization_id: string; ciphertext_bytes: number | string } &
          Record<string, unknown>
      >(
        `UPDATE attachment_objects
         SET state = 'failed',
             storage_backend = NULL,
             storage_key = NULL,
             migration_state = 'none',
             failure_code = 'unbound_upload_expired',
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1 AND organization_id = $2 AND state = 'available'
           AND migration_state = 'orphan_cleaning'
           AND storage_backend = 's3' AND storage_key = $3
           AND NOT EXISTS (
             SELECT 1 FROM direct_message_attachment_objects AS reference
             WHERE reference.attachment_id = attachment_objects.id
           )
         RETURNING organization_id, ciphertext_bytes`,
        [attachment.id, attachment.organizationId, attachment.key],
      );
      const row = failed.rows[0];
      if (!row) throw new Error('unbound attachment cleanup claim was lost');
      const quota = await client.query(
        `UPDATE attachment_storage_quotas
         SET stored_bytes = stored_bytes - $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $1 AND stored_bytes >= $2
         RETURNING organization_id`,
        [row.organization_id, Number(row.ciphertext_bytes)],
      );
      if (!quota.rows[0]) {
        throw new Error('unbound attachment quota cleanup is inconsistent');
      }
    });
  }

  async function listUnreadE2eeNotifications(raw: {
    organizationId: string;
    accountId: string;
    limit?: number;
  }) {
    const organizationId = requiredIdentifier(raw.organizationId, 'organization id');
    const accountId = requiredIdentifier(raw.accountId, 'account id');
    const limit = Math.max(1, Math.min(200, Math.floor(raw.limit ?? 50)));
    const result = await input.pool.query<
      {
        id: string;
        sender_account_id: string;
        content_type: 'message' | 'atoa_request' | 'atoa_response';
        created_at: Date | string;
      } & Record<string, unknown>
    >(
      `SELECT id, sender_account_id, content_type, created_at
       FROM direct_messages
       WHERE organization_id = $1 AND recipient_account_id = $2
         AND e2ee_protocol_version = 1 AND read_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [organizationId, accountId, limit],
    );
    return result.rows.map((row) => ({
      messageId: row.id,
      peerAccountId: row.sender_account_id,
      contentType: row.content_type,
      createdAt: iso(row.created_at)!,
    }));
  }

  async function readiness() {
    const result = await input.pool.query<{
      schema_version: number | string;
      organizations: number | string;
      accounts: number | string;
    } & Record<string, unknown>>(
      `SELECT
         COALESCE((SELECT max(version) FROM otto_schema_migrations), 0)::integer AS schema_version,
         (SELECT count(*) FROM organizations)::integer AS organizations,
         (SELECT count(*) FROM accounts WHERE deleted_at IS NULL)::integer AS accounts`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('PostgreSQL enterprise repository readiness failed');
    return {
      ready: true as const,
      backend: 'postgresql' as const,
      schemaVersion: Number(row.schema_version),
      organizations: Number(row.organizations),
      accounts: Number(row.accounts),
    };
  }

  const registration = createPostgresRegistrationRepository({
    pool: input.pool,
    defaultOrganizationId,
    normalizePhone: normalizePostgresEnterprisePhone,
    getAccount,
    logAudit,
  });

  return {
    defaultOrganizationId,
    readiness,
    getOrganization,
    getOrganizationFeatures,
    updateOrganizationFeatures,
    listOrganizationStructure,
    createOrganizationDepartment,
    updateOrganizationDepartment,
    deleteOrganizationDepartment,
    createOrganizationPosition,
    updateOrganizationPosition,
    deleteOrganizationPosition,
    getAccount,
    listAccounts,
    createAccount,
    updateAccount,
    deleteAccount,
    authenticateAccount,
    getLoginRetryAfter,
    recordLoginFailure,
    clearLoginFailures,
    createAuthSession,
    getAccountBySession,
    revokeAuthSession,
    logAudit,
    listAuditLogs,
    registerE2eeDevice,
    listE2eeDevices,
    approveE2eeDevice,
    revokeE2eeDevice,
    listE2eeKeyTransparency,
    publishMlsKeyPackage,
    claimMlsKeyPackage,
    appendMlsTransportEvent,
    listMlsTransportEvents,
    cleanupExpiredMlsResources,
    sendE2eeDirectMessage,
    listE2eeDirectMessages,
    getE2eeAttachmentAuthority,
    claimExpiredUnboundAttachments,
    completeExpiredUnboundAttachment,
    listUnreadE2eeNotifications,
    ...registration,
  };
}

export type PostgresEnterpriseCoreRepository = ReturnType<
  typeof createPostgresEnterpriseCoreRepository
>;
