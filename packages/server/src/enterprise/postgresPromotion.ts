/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Atomically promotes a verified SQLite staging run into the PostgreSQL core
 * domain. The target must be unused; retries are idempotent through the
 * promotion receipt and no partial domain state can commit.
 */

import { createHash, createHmac } from 'node:crypto';

import type {
  EncryptedFieldCipher,
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/index.js';
import {
  loadVerifiedSqliteImportTable,
  type DecodedSqliteImportRow,
} from './postgresImportStaging.js';

const PROMOTION_LOCK_KEY = 0x4f545450;
const MLS_CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const MLS_KEY_PACKAGE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MLS_TRANSPORT_EVENT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const INVITE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const COMMERCIAL_SECRET_FIELDS = new Set([
  'telemetryToken',
  'leaseToken',
  'billingHoldToken',
  'billingFinalizeToken',
  'privateKey',
  'privateKeyPem',
]);

function sanitizeCommercialPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(
      ([key]) => !COMMERCIAL_SECRET_FIELDS.has(key),
    ),
  );
}

interface ImportRunRow extends Record<string, unknown> {
  id: string;
  state: string;
}

interface PromotionReceiptRow extends Record<string, unknown> {
  run_id: string;
  promoted_counts: Record<string, number> | string;
  promoted_at: Date | string;
}

interface PreparedAttachmentRow extends Record<string, unknown> {
  attachment_id: string;
  message_id: string;
  organization_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  ordinal: number | string;
  ciphertext_bytes: number | string;
  ciphertext_sha256: string;
  e2ee_nonce: string;
  source_backend: string;
  source_storage_key: string | null;
  s3_storage_key: string | null;
  state: string;
  source_created_at: Date | string;
}

interface PreparedPromotionAttachment {
  id: string;
  messageId: string;
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  ordinal: number;
  ciphertextBytes: number;
  ciphertextSha256: string;
  nonce: string;
  sourceBackend: 'sqlite' | 'encrypted-filesystem';
  sourceStorageKey: string | null;
  s3StorageKey: string;
  sourceCreatedAt: string;
}

export interface PostgresEnterprisePromotionResult {
  runId: string;
  state: 'promoted' | 'already-promoted' | 'planned';
  promotedCounts: Record<string, number>;
  promotedAt: string | null;
}

type DecodedRow = DecodedSqliteImportRow;

const PROMOTION_ORDER = [
  'organizations',
  'organization_features',
  'organization_departments',
  'organization_positions',
  'accounts',
  'organization_invites',
  'account_tags',
  'auth_sessions',
  'audit_logs',
  'e2ee_devices',
  'e2ee_key_transparency_log',
  'direct_messages',
  'mls_key_packages',
  'mls_conversations',
  'mls_group_sessions',
  'mls_transport_events',
  'mls_resource_rate_buckets',
] as const;

const BUSINESS_PROMOTION_ORDER = [
  'legal_consents',
  'privacy_requests',
  'account_sync_snapshots',
  'knowledge',
  'knowledge_revisions',
  'knowledge_retention_evidence',
  'enterprise_skills',
  'enterprise_skill_versions',
  'enterprise_skill_installs',
  'enterprise_skill_ratings',
  'enterprise_skill_usage_events',
  'parks',
  'park_invites',
  'park_services',
  'park_tenant_profiles',
  'park_service_specialists',
  'park_settings',
  'park_meeting_rooms',
  'park_meeting_slots',
  'park_meeting_bookings',
  'park_meeting_slot_overrides',
  'park_publications',
  'park_publication_recipients',
  'park_data_statistics_tasks',
  'park_data_statistics_assignments',
  'it_tickets',
  'park_application_sequences',
  'ticket_events',
  'ticket_deliveries',
  'ticket_notifications',
  'deployment_settings',
  'deployment_license',
  'deployment_license_leases',
  'telemetry_events',
  'telemetry_ingest_events',
  'telemetry_ingest_nonces',
  'billing_usage_outbox',
  'billing_execution_receipt_keys',
  'billing_execution_receipt_sequences',
  'billing_admission_outbox',
] as const;

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SQLite promotion ${label} is invalid`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestamp(value: unknown, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`SQLite promotion ${label} is invalid`);
    }
    return value.toISOString();
  }
  const raw = stringValue(value, label);
  const date = new Date(
    raw.endsWith('Z') || /[+-]\d\d:\d\d$/.test(raw)
      ? raw
      : `${raw.replace(' ', 'T')}Z`,
  );
  if (Number.isNaN(date.getTime()))
    throw new Error(`SQLite promotion ${label} is invalid`);
  return date.toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : timestamp(value, label);
}

function expirationTimestamp(
  value: unknown,
  createdAt: unknown,
  ttlMs: number,
  label: string,
): string {
  if (value !== null && value !== undefined && value !== '') {
    return timestamp(value, label);
  }
  const created = new Date(timestamp(createdAt, `${label} source created_at`));
  return new Date(created.getTime() + ttlMs).toISOString();
}

function millisecondTimestamp(value: unknown, label: string): string {
  const milliseconds = integerValue(value, label);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`SQLite promotion ${label} is invalid`);
  }
  return date.toISOString();
}

function optionalMillisecondTimestamp(
  value: unknown,
  label: string,
): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : millisecondTimestamp(value, label);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function integerValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`SQLite promotion ${label} is invalid`);
  return parsed;
}

function positiveIntegerValue(value: unknown, label: string): number {
  const parsed = integerValue(value, label);
  if (parsed <= 0) throw new Error(`SQLite promotion ${label} is invalid`);
  return parsed;
}

function nonNegativeIntegerValue(value: unknown, label: string): number {
  const parsed = integerValue(value, label);
  if (parsed < 0) throw new Error(`SQLite promotion ${label} is invalid`);
  return parsed;
}

function sha256Value(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(`SQLite promotion ${label} is invalid`);
  }
  return parsed;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve legacy free text in a structured audit field.
  }
  return { legacyDetail: value };
}

function receipt(row: PromotionReceiptRow): PostgresEnterprisePromotionResult {
  const counts =
    typeof row.promoted_counts === 'string'
      ? (JSON.parse(row.promoted_counts) as Record<string, number>)
      : row.promoted_counts;
  return {
    runId: row.run_id,
    state: 'already-promoted',
    promotedCounts: counts,
    promotedAt:
      row.promoted_at instanceof Date
        ? row.promoted_at.toISOString()
        : new Date(row.promoted_at).toISOString(),
  };
}

async function assertUnusedTarget(client: PostgresClientLike): Promise<void> {
  const result = await client.query<
    {
      accounts: number | string;
      messages: number | string;
      mls_key_packages: number | string;
      mls_conversations: number | string;
      mls_group_sessions: number | string;
      mls_transport_events: number | string;
      account_sync_snapshots: number | string;
      business_records: number | string;
      non_default_organizations: number | string;
    } & Record<string, unknown>
  >(
    `SELECT
       (SELECT count(*) FROM accounts)::integer AS accounts,
       (SELECT count(*) FROM direct_messages)::integer AS messages,
       (SELECT count(*) FROM mls_key_packages)::integer AS mls_key_packages,
       (SELECT count(*) FROM mls_conversations)::integer AS mls_conversations,
       (SELECT count(*) FROM mls_group_sessions)::integer AS mls_group_sessions,
       (SELECT count(*) FROM mls_transport_events)::integer AS mls_transport_events,
       (SELECT count(*) FROM account_sync_snapshots)::integer AS account_sync_snapshots,
       (SELECT count(*) FROM enterprise_business_records)::integer AS business_records,
       (SELECT count(*) FROM organizations WHERE id <> 'org_default')::integer
         AS non_default_organizations`,
  );
  const row = result.rows[0];
  if (
    !row ||
    Number(row.accounts) !== 0 ||
    Number(row.messages) !== 0 ||
    Number(row.mls_key_packages) !== 0 ||
    Number(row.mls_conversations) !== 0 ||
    Number(row.mls_group_sessions) !== 0 ||
    Number(row.mls_transport_events) !== 0 ||
    Number(row.account_sync_snapshots) !== 0 ||
    Number(row.business_records) !== 0 ||
    Number(row.non_default_organizations) !== 0
  ) {
    throw new Error(
      'PostgreSQL promotion target is not empty; refusing to overwrite authoritative data',
    );
  }
}

async function insertOrganizations(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const id = stringValue(row.id, 'organization id');
    await client.query(
      `INSERT INTO organizations
        (id, name, slug, type, status, park_id, invite_secret, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, slug = EXCLUDED.slug, type = EXCLUDED.type,
         status = EXCLUDED.status, park_id = EXCLUDED.park_id,
         invite_secret = COALESCE(EXCLUDED.invite_secret, organizations.invite_secret),
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        id,
        stringValue(row.name, 'organization name'),
        stringValue(row.slug, 'organization slug'),
        id.startsWith('personal_') ? 'personal' : 'enterprise',
        row.status === 'disabled' ? 'disabled' : 'active',
        optionalString(row.park_id),
        optionalString(row.invite_secret),
        timestamp(row.created_at, 'organization created_at'),
        timestamp(row.updated_at, 'organization updated_at'),
      ],
    );
    await client.query(
      `INSERT INTO organization_features (organization_id)
       VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`,
      [id],
    );
  }
}

function deriveImportedInviteCode(input: {
  organizationId: string;
  inviteSecret: string;
  nonce: string;
}): string {
  if (!/^[0-9a-f]{64}$/u.test(input.inviteSecret)) {
    throw new Error('SQLite promotion organization invite secret is invalid');
  }
  const digest = createHmac('sha256', input.inviteSecret)
    .update(`${input.organizationId}:${input.nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < 12; index += 1) {
    code += INVITE_ALPHABET[digest[index]! % INVITE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

async function insertOrganizationInvites(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const organizationId = stringValue(
      row.organization_id,
      'invite organization id',
    );
    const secretResult = await client.query<
      { invite_secret: string | null } & Record<string, unknown>
    >('SELECT invite_secret FROM organizations WHERE id = $1', [
      organizationId,
    ]);
    const inviteSecret = secretResult.rows[0]?.invite_secret;
    if (!inviteSecret) {
      throw new Error(
        `SQLite promotion organization ${organizationId} has invitations but no invite secret`,
      );
    }
    const nonce = stringValue(row.nonce, 'invite nonce');
    const code = deriveImportedInviteCode({
      organizationId,
      inviteSecret,
      nonce,
    });
    const normalizedCode = code.replaceAll('-', '');
    await client.query(
      `INSERT INTO organization_invites
        (id, organization_id, nonce, code_hash, issued_at, expires_at,
         revoked_at, created_by_account_id, default_department, department_id,
         position_id, position_title, default_role, max_uses, used_count)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
               $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        stringValue(row.id, 'invite id'),
        organizationId,
        nonce,
        createHash('sha256').update(normalizedCode).digest('hex'),
        millisecondTimestamp(row.issued_at_ms, 'invite issued_at_ms'),
        millisecondTimestamp(row.expires_at_ms, 'invite expires_at_ms'),
        optionalMillisecondTimestamp(row.revoked_at_ms, 'invite revoked_at_ms'),
        optionalString(row.created_by_account_id),
        optionalString(row.default_department),
        optionalString(row.department_id),
        optionalString(row.position_id),
        optionalString(row.position_title),
        optionalString(row.default_role),
        row.max_uses == null
          ? null
          : integerValue(row.max_uses, 'invite max_uses'),
        row.used_count == null
          ? 0
          : integerValue(row.used_count, 'invite used_count'),
      ],
    );
  }
}

async function insertOrganizationFeatures(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  const features = new Map<string, Record<string, boolean>>();
  for (const row of rows) {
    const organizationId = stringValue(
      row.organization_id,
      'feature organization id',
    );
    const feature = stringValue(row.feature_key, 'feature key');
    if (
      ![
        'enterprise_tree',
        'direct_messages',
        'atoa',
        'park_services',
        'park_service',
        'knowledge',
        'skill_market',
      ].includes(feature)
    ) {
      continue;
    }
    const current = features.get(organizationId) ?? {};
    current[feature === 'park_service' ? 'park_services' : feature] =
      booleanValue(row.enabled);
    features.set(organizationId, current);
  }
  for (const [organizationId, patch] of features) {
    await client.query(
      `UPDATE organization_features SET
         enterprise_tree = COALESCE($2, enterprise_tree),
         direct_messages = COALESCE($3, direct_messages),
         atoa = COALESCE($4, atoa),
         park_services = COALESCE($5, park_services),
         knowledge = COALESCE($6, knowledge),
         skill_market = COALESCE($7, skill_market),
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1`,
      [
        organizationId,
        patch.enterprise_tree ?? null,
        patch.direct_messages ?? null,
        patch.atoa ?? null,
        patch.park_services ?? null,
        patch.knowledge ?? null,
        patch.skill_market ?? null,
      ],
    );
  }
}

async function insertDepartments(
  client: PostgresClientLike,
  rows: DecodedRow[],
) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO organization_departments
        (id, organization_id, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [
        stringValue(row.id, 'department id'),
        stringValue(row.organization_id, 'department organization id'),
        stringValue(row.name, 'department name'),
        timestamp(row.created_at, 'department created_at'),
        timestamp(row.updated_at, 'department updated_at'),
      ],
    );
  }
}

async function insertPositions(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO organization_positions
        (id, organization_id, department_id, title, role_mapping, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        stringValue(row.id, 'position id'),
        stringValue(row.organization_id, 'position organization id'),
        stringValue(row.department_id, 'position department id'),
        stringValue(row.title, 'position title'),
        optionalString(row.role_mapping),
        timestamp(row.created_at, 'position created_at'),
        timestamp(row.updated_at, 'position updated_at'),
      ],
    );
  }
}

async function insertAccounts(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO accounts
        (id, organization_id, account_type, employee_id, username, phone,
         feishu_open_id, password_hash, name, role, department, department_id,
         position_id, position_title, avatar_url, is_admin, status, deleted_at,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18::timestamptz,
               $19::timestamptz, $20::timestamptz)`,
      [
        stringValue(row.id, 'account id'),
        stringValue(row.organization_id, 'account organization id'),
        row.account_type === 'personal' ? 'personal' : 'enterprise',
        optionalString(row.employee_id),
        stringValue(row.username, 'account username'),
        optionalString(row.phone),
        optionalString(row.feishu_open_id),
        stringValue(row.password_hash, 'account password hash'),
        stringValue(row.name, 'account name'),
        optionalString(row.role),
        optionalString(row.department),
        optionalString(row.department_id),
        optionalString(row.position_id),
        optionalString(row.position_title),
        optionalString(row.avatar_url),
        booleanValue(row.is_admin),
        row.status === 'disabled' ? 'disabled' : 'active',
        optionalTimestamp(row.deleted_at, 'account deleted_at'),
        timestamp(row.created_at, 'account created_at'),
        timestamp(row.updated_at, 'account updated_at'),
      ],
    );
  }
}

async function insertTags(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO account_tags (account_id, organization_id, tag)
       VALUES ($1, $2, $3)`,
      [
        stringValue(row.account_id, 'tag account id'),
        stringValue(row.organization_id, 'tag organization id'),
        stringValue(row.tag, 'account tag'),
      ],
    );
  }
}

async function insertSessions(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO auth_sessions
        (token_hash, account_id, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::timestamptz)`,
      [
        stringValue(row.token_hash, 'session token hash'),
        stringValue(row.account_id, 'session account id'),
        timestamp(row.created_at, 'session created_at'),
        timestamp(row.expires_at, 'session expires_at'),
        optionalTimestamp(row.revoked_at, 'session revoked_at'),
      ],
    );
  }
}

async function insertAudits(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO audit_logs
        (organization_id, action, actor_employee_id, detail, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [
        stringValue(row.organization_id, 'audit organization id'),
        stringValue(row.event, 'audit event'),
        optionalString(row.employee_id),
        JSON.stringify(jsonObject(row.detail)),
        timestamp(row.created_at, 'audit created_at'),
      ],
    );
  }
}

async function insertDevices(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO e2ee_devices
        (organization_id, account_id, device_id, device_name,
         identity_signing_public_key, device_exchange_public_key,
         key_fingerprint, approval_state, approved_by_device_id, approved_at,
         created_at, last_seen_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz,
               $11::timestamptz, $12::timestamptz, $13::timestamptz)`,
      [
        stringValue(row.organization_id, 'device organization id'),
        stringValue(row.account_id, 'device account id'),
        stringValue(row.device_id, 'device id'),
        stringValue(row.device_name, 'device name'),
        stringValue(row.identity_signing_public_key, 'device signing key'),
        stringValue(row.device_exchange_public_key, 'device exchange key'),
        stringValue(row.key_fingerprint, 'device fingerprint'),
        row.approval_state === 'pending' ? 'pending' : 'approved',
        optionalString(row.approved_by_device_id),
        optionalTimestamp(row.approved_at, 'device approved_at'),
        timestamp(row.created_at, 'device created_at'),
        timestamp(row.last_seen_at, 'device last_seen_at'),
        optionalTimestamp(row.revoked_at, 'device revoked_at'),
      ],
    );
  }
}

async function insertTransparency(
  client: PostgresClientLike,
  rows: DecodedRow[],
) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO e2ee_key_transparency_log
        (organization_id, sequence, account_id, device_id, event,
         key_fingerprint, actor_device_id, previous_hash, entry_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
      [
        stringValue(row.organization_id, 'transparency organization id'),
        integerValue(row.sequence, 'transparency sequence'),
        stringValue(row.account_id, 'transparency account id'),
        stringValue(row.device_id, 'transparency device id'),
        stringValue(row.event, 'transparency event'),
        stringValue(row.key_fingerprint, 'transparency fingerprint'),
        optionalString(row.actor_device_id),
        stringValue(row.previous_hash, 'transparency previous hash'),
        stringValue(row.entry_hash, 'transparency entry hash'),
        timestamp(row.created_at, 'transparency created_at'),
      ],
    );
  }
}

async function insertMessages(client: PostgresClientLike, rows: DecodedRow[]) {
  for (const row of rows) {
    const e2ee = Number(row.e2ee_protocol_version) === 1;
    if (
      !e2ee &&
      (!optionalString(row.content_ciphertext) ||
        !optionalString(row.content_iv) ||
        !optionalString(row.content_auth_tag) ||
        row.content_key_version == null)
    ) {
      throw new Error(
        `SQLite message ${String(row.id)} is not encrypted; promotion refuses plaintext data`,
      );
    }
    const envelopes = e2ee
      ? JSON.parse(stringValue(row.e2ee_envelopes_json, 'message envelopes'))
      : null;
    await client.query(
      `INSERT INTO direct_messages
        (id, organization_id, sender_account_id, recipient_account_id,
         content_type, content_ciphertext, content_iv, content_auth_tag,
         content_key_version, e2ee_protocol_version, e2ee_sender_device_id,
         e2ee_ciphertext, e2ee_nonce, e2ee_signature, e2ee_envelopes,
         in_reply_to_message_id, created_at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15::jsonb, $16, $17::timestamptz, $18::timestamptz)`,
      [
        stringValue(row.id, 'message id'),
        stringValue(row.organization_id, 'message organization id'),
        stringValue(row.sender_account_id, 'message sender account id'),
        stringValue(row.recipient_account_id, 'message recipient account id'),
        ['atoa_request', 'atoa_response'].includes(String(row.content_type))
          ? row.content_type
          : 'message',
        e2ee ? null : optionalString(row.content_ciphertext),
        e2ee ? null : optionalString(row.content_iv),
        e2ee ? null : optionalString(row.content_auth_tag),
        e2ee
          ? null
          : integerValue(row.content_key_version, 'message key version'),
        e2ee ? 1 : null,
        e2ee
          ? stringValue(row.e2ee_sender_device_id, 'message sender device id')
          : null,
        e2ee ? stringValue(row.e2ee_ciphertext, 'message ciphertext') : null,
        e2ee ? stringValue(row.e2ee_nonce, 'message nonce') : null,
        e2ee ? stringValue(row.e2ee_signature, 'message signature') : null,
        e2ee ? JSON.stringify(envelopes) : null,
        optionalString(row.in_reply_to_message_id),
        timestamp(row.created_at, 'message created_at'),
        optionalTimestamp(row.read_at, 'message read_at'),
      ],
    );
  }
}

async function insertMlsKeyPackages(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const ciphersuite = stringValue(
      row.ciphersuite,
      'MLS KeyPackage ciphersuite',
    );
    if (ciphersuite !== MLS_CIPHERSUITE) {
      throw new Error('SQLite promotion MLS KeyPackage ciphersuite is invalid');
    }
    await client.query(
      `INSERT INTO mls_key_packages
        (organization_id, key_package_reference, account_id, device_id,
         ciphersuite, key_package, created_at, claimed_at,
         claimed_by_account_id, claimed_by_device_id, welcome_event_id,
         expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               $9, $10, $11, $12::timestamptz)`,
      [
        stringValue(row.organization_id, 'MLS KeyPackage organization id'),
        sha256Value(row.key_package_reference, 'MLS KeyPackage reference'),
        stringValue(row.account_id, 'MLS KeyPackage account id'),
        stringValue(row.device_id, 'MLS KeyPackage device id'),
        ciphersuite,
        stringValue(row.key_package, 'MLS KeyPackage payload'),
        timestamp(row.created_at, 'MLS KeyPackage created_at'),
        optionalTimestamp(row.claimed_at, 'MLS KeyPackage claimed_at'),
        optionalString(row.claimed_by_account_id),
        optionalString(row.claimed_by_device_id),
        optionalString(row.welcome_event_id),
        expirationTimestamp(
          row.expires_at,
          row.created_at,
          MLS_KEY_PACKAGE_TTL_MS,
          'MLS KeyPackage expires_at',
        ),
      ],
    );
  }
}

async function insertMlsConversations(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO mls_conversations
        (organization_id, conversation_id, participant_a_account_id,
         participant_b_account_id, group_id, current_epoch, created_at,
         updated_at, retention_floor_sequence, active_generation)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               $9, $10)`,
      [
        stringValue(row.organization_id, 'MLS conversation organization id'),
        sha256Value(row.conversation_id, 'MLS conversation id'),
        stringValue(
          row.participant_a_account_id,
          'MLS conversation participant A',
        ),
        stringValue(
          row.participant_b_account_id,
          'MLS conversation participant B',
        ),
        stringValue(row.group_id, 'MLS conversation group id'),
        positiveIntegerValue(row.current_epoch, 'MLS conversation epoch'),
        timestamp(row.created_at, 'MLS conversation created_at'),
        timestamp(row.updated_at, 'MLS conversation updated_at'),
        row.retention_floor_sequence == null
          ? 0
          : nonNegativeIntegerValue(
              row.retention_floor_sequence,
              'MLS conversation retention floor',
            ),
        row.active_generation == null
          ? 1
          : positiveIntegerValue(
              row.active_generation,
              'MLS conversation active generation',
            ),
      ],
    );
    if (row.active_generation == null) {
      await client.query(
        `INSERT INTO mls_group_sessions
          (organization_id, conversation_id, generation, group_id,
           current_epoch, status, created_at)
         VALUES ($1, $2, 1, $3, $4, 'active', $5::timestamptz)`,
        [
          stringValue(row.organization_id, 'MLS conversation organization id'),
          sha256Value(row.conversation_id, 'MLS conversation id'),
          stringValue(row.group_id, 'MLS conversation group id'),
          positiveIntegerValue(row.current_epoch, 'MLS conversation epoch'),
          timestamp(row.created_at, 'MLS conversation created_at'),
        ],
      );
    }
  }
}

async function insertMlsGroupSessions(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const status = stringValue(row.status, 'MLS group session status');
    if (!['active', 'retired'].includes(status)) {
      throw new Error('SQLite promotion MLS group session status is invalid');
    }
    const generation = positiveIntegerValue(
      row.generation,
      'MLS group session generation',
    );
    await client.query(
      `INSERT INTO mls_group_sessions
        (organization_id, conversation_id, generation, group_id,
         current_epoch, status, created_at, retired_at, reset_by_account_id,
         reset_by_device_id, reset_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
               $9, $10, $11)`,
      [
        stringValue(row.organization_id, 'MLS group session organization id'),
        sha256Value(row.conversation_id, 'MLS group session conversation id'),
        generation,
        stringValue(row.group_id, 'MLS group session group id'),
        positiveIntegerValue(row.current_epoch, 'MLS group session epoch'),
        status,
        timestamp(row.created_at, 'MLS group session created_at'),
        optionalTimestamp(row.retired_at, 'MLS group session retired_at'),
        optionalString(row.reset_by_account_id),
        optionalString(row.reset_by_device_id),
        optionalString(row.reset_event_id),
      ],
    );
  }
}

async function insertMlsTransportEvents(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const eventType = stringValue(row.event_type, 'MLS event type');
    if (!['welcome', 'commit', 'application'].includes(eventType)) {
      throw new Error('SQLite promotion MLS event type is invalid');
    }
    await client.query(
      `INSERT INTO mls_transport_events
        (sequence, id, organization_id, conversation_id, session_generation,
         sender_account_id,
         sender_device_id, recipient_account_id, recipient_device_id,
         event_type, epoch, group_id, payload, key_package_reference, created_at,
         expires_at)
       OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15::timestamptz, $16::timestamptz)`,
      [
        positiveIntegerValue(row.sequence, 'MLS event sequence'),
        stringValue(row.id, 'MLS event id'),
        stringValue(row.organization_id, 'MLS event organization id'),
        sha256Value(row.conversation_id, 'MLS event conversation id'),
        row.session_generation == null
          ? 1
          : positiveIntegerValue(
              row.session_generation,
              'MLS event session generation',
            ),
        stringValue(row.sender_account_id, 'MLS event sender account id'),
        stringValue(row.sender_device_id, 'MLS event sender device id'),
        optionalString(row.recipient_account_id),
        optionalString(row.recipient_device_id),
        eventType,
        positiveIntegerValue(row.epoch, 'MLS event epoch'),
        stringValue(row.group_id, 'MLS event group id'),
        stringValue(row.payload, 'MLS event payload'),
        row.key_package_reference == null
          ? null
          : sha256Value(
              row.key_package_reference,
              'MLS event KeyPackage reference',
            ),
        timestamp(row.created_at, 'MLS event created_at'),
        expirationTimestamp(
          row.expires_at,
          row.created_at,
          MLS_TRANSPORT_EVENT_TTL_MS,
          'MLS event expires_at',
        ),
      ],
    );
  }
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence('mls_transport_events', 'sequence'),
       COALESCE((SELECT max(sequence) FROM mls_transport_events), 1),
       EXISTS (SELECT 1 FROM mls_transport_events)
     )`,
  );
}

async function insertMlsResourceRateBuckets(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  for (const row of rows) {
    const action = stringValue(row.action, 'MLS rate bucket action');
    if (!['key_package_publish', 'transport_event_append'].includes(action)) {
      throw new Error('SQLite promotion MLS rate bucket action is invalid');
    }
    await client.query(
      `INSERT INTO mls_resource_rate_buckets
        (organization_id, account_id, device_id, action, bucket_started_at,
         request_count)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6)`,
      [
        stringValue(row.organization_id, 'MLS rate bucket organization id'),
        stringValue(row.account_id, 'MLS rate bucket account id'),
        stringValue(row.device_id, 'MLS rate bucket device id'),
        action,
        millisecondTimestamp(
          row.bucket_started_at_ms,
          'MLS rate bucket started_at_ms',
        ),
        positiveIntegerValue(
          row.request_count,
          'MLS rate bucket request count',
        ),
      ],
    );
  }
}

async function verifiedPreparedAttachments(input: {
  client: PostgresClientLike;
  runId: string;
  attachmentRows: DecodedRow[];
  messageRows: DecodedRow[];
}): Promise<PreparedPromotionAttachment[]> {
  const result = await input.client.query<PreparedAttachmentRow>(
    `SELECT attachment_id, message_id, organization_id, sender_account_id,
            recipient_account_id, ordinal, ciphertext_bytes,
            ciphertext_sha256, e2ee_nonce, source_backend,
            source_storage_key, s3_storage_key, state, source_created_at
     FROM otto_sqlite_import_attachment_objects
     WHERE run_id = $1 ORDER BY attachment_id`,
    [input.runId],
  );
  if (result.rows.length !== input.attachmentRows.length) {
    throw new Error(
      'every SQLite message attachment requires a verified S3 preparation',
    );
  }
  const messages = new Map(
    input.messageRows.map((row) => [String(row.id), row]),
  );
  const preparedById = new Map(
    result.rows.map((row) => [row.attachment_id, row] as const),
  );
  return input.attachmentRows.map((source) => {
    const id = stringValue(source.id, 'attachment id');
    const messageId = stringValue(source.message_id, 'attachment message id');
    const organizationId = stringValue(
      source.organization_id,
      'attachment organization id',
    );
    const message = messages.get(messageId);
    if (
      !message ||
      Number(message.e2ee_protocol_version) !== 1 ||
      stringValue(message.organization_id, 'message organization id') !==
        organizationId
    ) {
      throw new Error(
        'SQLite attachment promotion only supports tenant-matched E2EE messages',
      );
    }
    const senderAccountId = stringValue(
      message.sender_account_id,
      'message sender account id',
    );
    const recipientAccountId = stringValue(
      message.recipient_account_id,
      'message recipient account id',
    );
    const ordinal = integerValue(source.ordinal, 'attachment ordinal');
    const expectedBytes =
      integerValue(source.byte_size, 'attachment byte size') + 16;
    const sourceCreatedAt = timestamp(
      source.created_at,
      'attachment created_at',
    );
    const nonce = stringValue(source.e2ee_nonce, 'attachment nonce');
    const sourceBackend = source.storage_backend;
    const sourceStorageKey = optionalString(source.storage_key);
    const prepared = preparedById.get(id);
    if (
      !prepared ||
      prepared.state !== 'verified' ||
      prepared.message_id !== messageId ||
      prepared.organization_id !== organizationId ||
      prepared.sender_account_id !== senderAccountId ||
      prepared.recipient_account_id !== recipientAccountId ||
      Number(prepared.ordinal) !== ordinal ||
      Number(prepared.ciphertext_bytes) !== expectedBytes ||
      prepared.e2ee_nonce !== nonce ||
      prepared.source_backend !== sourceBackend ||
      prepared.source_storage_key !== sourceStorageKey ||
      timestamp(
        prepared.source_created_at,
        'prepared attachment created_at',
      ) !== sourceCreatedAt ||
      !/^[0-9a-f]{64}$/u.test(prepared.ciphertext_sha256) ||
      !prepared.s3_storage_key ||
      !/^attachments\/v1\/[0-9a-f]{2}\/[0-9a-f]{32}\.bin$/u.test(
        prepared.s3_storage_key,
      )
    ) {
      throw new Error(
        `SQLite attachment ${id} has no matching verified S3 preparation`,
      );
    }
    if (
      (sourceBackend !== 'sqlite' &&
        sourceBackend !== 'encrypted-filesystem') ||
      (sourceBackend === 'sqlite' && sourceStorageKey !== null) ||
      (sourceBackend === 'encrypted-filesystem' && !sourceStorageKey)
    ) {
      throw new Error(`SQLite attachment ${id} source metadata is invalid`);
    }
    return {
      id,
      messageId,
      organizationId,
      senderAccountId,
      recipientAccountId,
      ordinal,
      ciphertextBytes: expectedBytes,
      ciphertextSha256: prepared.ciphertext_sha256,
      nonce,
      sourceBackend,
      sourceStorageKey,
      s3StorageKey: prepared.s3_storage_key,
      sourceCreatedAt,
    };
  });
}

async function insertPreparedAttachments(input: {
  client: PostgresClientLike;
  attachments: PreparedPromotionAttachment[];
  defaultQuotaBytes: number;
  legacyGraceMs: number;
}): Promise<void> {
  const bytesByOrganization = new Map<string, number>();
  for (const attachment of input.attachments) {
    const next =
      (bytesByOrganization.get(attachment.organizationId) ?? 0) +
      attachment.ciphertextBytes;
    if (!Number.isSafeInteger(next) || next > input.defaultQuotaBytes) {
      throw new Error(
        `SQLite attachment import exceeds the configured quota for ${attachment.organizationId}`,
      );
    }
    bytesByOrganization.set(attachment.organizationId, next);
  }
  for (const [organizationId, storedBytes] of bytesByOrganization) {
    await input.client.query(
      `INSERT INTO attachment_storage_quotas
        (organization_id, max_bytes, reserved_bytes, stored_bytes)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (organization_id) DO UPDATE SET
         max_bytes = GREATEST(attachment_storage_quotas.max_bytes, EXCLUDED.max_bytes),
         stored_bytes = attachment_storage_quotas.stored_bytes + EXCLUDED.stored_bytes,
         updated_at = CURRENT_TIMESTAMP`,
      [organizationId, input.defaultQuotaBytes, storedBytes],
    );
  }
  for (const attachment of input.attachments) {
    const retainsLegacy = attachment.sourceBackend === 'encrypted-filesystem';
    await input.client.query(
      `INSERT INTO attachment_objects
        (id, organization_id, owner_account_id, state, encryption,
         ciphertext_bytes, ciphertext_sha256, storage_backend, storage_key,
         legacy_storage_backend, legacy_storage_key, legacy_delete_after,
         migration_state, expires_at, available_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'available', 'e2ee-client-v1', $4, $5, 's3', $6,
               $7, $8,
               CASE WHEN $7::text IS NULL THEN NULL
                    ELSE CURRENT_TIMESTAMP + ($9::bigint * INTERVAL '1 millisecond') END,
               CASE WHEN $7::text IS NULL THEN 'none' ELSE 'verified' END,
               CURRENT_TIMESTAMP + INTERVAL '1 day', $10::timestamptz,
               $10::timestamptz, CURRENT_TIMESTAMP)`,
      [
        attachment.id,
        attachment.organizationId,
        attachment.senderAccountId,
        attachment.ciphertextBytes,
        attachment.ciphertextSha256,
        attachment.s3StorageKey,
        retainsLegacy ? 'encrypted-filesystem' : null,
        retainsLegacy ? attachment.sourceStorageKey : null,
        input.legacyGraceMs,
        attachment.sourceCreatedAt,
      ],
    );
    for (const accountId of new Set([
      attachment.senderAccountId,
      attachment.recipientAccountId,
    ])) {
      await input.client.query(
        `INSERT INTO attachment_object_access
          (attachment_id, organization_id, account_id)
         VALUES ($1, $2, $3)`,
        [attachment.id, attachment.organizationId, accountId],
      );
    }
    await input.client.query(
      `INSERT INTO direct_message_attachment_objects
        (attachment_id, message_id, organization_id, ordinal, e2ee_nonce,
         ciphertext_bytes, ciphertext_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        attachment.id,
        attachment.messageId,
        attachment.organizationId,
        attachment.ordinal,
        attachment.nonce,
        attachment.ciphertextBytes,
        attachment.ciphertextSha256,
      ],
    );
  }
}

function jsonValue(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

function legacyTimestamp(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return new Date(0).toISOString();
  }
  return timestamp(value, 'business record timestamp');
}

async function insertBusinessRecord(input: {
  client: PostgresClientLike;
  organizationId: string;
  domain:
    | 'knowledge'
    | 'skills'
    | 'park'
    | 'ticketing'
    | 'commercial_control'
    | 'data_governance';
  resourceType: string;
  resourceId: string;
  ownerAccountId?: string | null;
  status?: string;
  version?: number;
  payload: Record<string, unknown>;
  createdAt?: unknown;
  updatedAt?: unknown;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO enterprise_business_records
       (organization_id, domain, resource_type, resource_id, owner_account_id,
        status, version, payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
             $9::timestamptz, $10::timestamptz)`,
    [
      input.organizationId,
      input.domain,
      input.resourceType,
      input.resourceId,
      input.ownerAccountId ?? null,
      input.status ?? 'active',
      input.version ?? 1,
      JSON.stringify(input.payload),
      legacyTimestamp(input.createdAt),
      legacyTimestamp(input.updatedAt ?? input.createdAt),
    ],
  );
}

async function insertBusinessEvent(input: {
  client: PostgresClientLike;
  organizationId: string;
  domain:
    | 'knowledge'
    | 'skills'
    | 'park'
    | 'ticketing'
    | 'commercial_control'
    | 'data_governance';
  eventId: string;
  resourceType: string;
  resourceId: string;
  actorAccountId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt?: unknown;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO enterprise_business_events
       (organization_id, domain, event_id, resource_type, resource_id,
        actor_account_id, event_type, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
    [
      input.organizationId,
      input.domain,
      input.eventId,
      input.resourceType,
      input.resourceId,
      input.actorAccountId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
      legacyTimestamp(input.createdAt),
    ],
  );
}

function importedSkillContent(
  row: DecodedRow,
  fieldCipher: EncryptedFieldCipher | undefined,
): string {
  const plaintext = optionalString(row.content);
  if (plaintext && plaintext !== '[encrypted:v1]') return plaintext;
  if (
    !fieldCipher ||
    !optionalString(row.content_ciphertext) ||
    !optionalString(row.content_iv) ||
    !optionalString(row.content_auth_tag)
  ) {
    throw new Error(
      'SQLite promotion requires the enterprise field key to decrypt Skill content',
    );
  }
  const organizationId = stringValue(
    row.organization_id,
    'skill organization id',
  );
  const skillId = stringValue(row.id, 'skill id');
  const version = positiveIntegerValue(row.version ?? 1, 'skill version');
  return fieldCipher.decryptText(
    {
      ciphertext: stringValue(row.content_ciphertext, 'skill ciphertext'),
      iv: stringValue(row.content_iv, 'skill IV'),
      authTag: stringValue(row.content_auth_tag, 'skill authentication tag'),
      keyVersion: positiveIntegerValue(
        row.content_key_version,
        'skill key version',
      ),
    },
    `enterprise-skill:${organizationId}:${skillId}:v${version}`,
  );
}

async function promoteBusinessTables(input: {
  client: PostgresClientLike;
  loaded: ReadonlyMap<string, DecodedRow[]>;
  fieldCipher?: EncryptedFieldCipher;
}): Promise<void> {
  for (const row of input.loaded.get('legal_consents') ?? []) {
    await input.client.query(
      `INSERT INTO legal_consents
         (account_id, organization_id, document_id, document_version,
          policy_hash, source, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (account_id, document_id, document_version) DO NOTHING`,
      [
        stringValue(row.account_id, 'legal consent account id'),
        stringValue(row.organization_id, 'legal consent organization id'),
        stringValue(row.document_id, 'legal consent document id'),
        stringValue(row.document_version, 'legal consent version'),
        sha256Value(row.policy_hash, 'legal consent policy hash'),
        optionalString(row.source) ?? 'migration',
        timestamp(row.accepted_at, 'legal consent accepted_at'),
      ],
    );
  }

  for (const row of input.loaded.get('account_sync_snapshots') ?? []) {
    await input.client.query(
      `INSERT INTO account_sync_snapshots
         (organization_id, account_id, scope, version, payload_ciphertext,
          payload_iv, payload_auth_tag, payload_hash, device_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
      [
        stringValue(row.organization_id, 'account sync organization id'),
        stringValue(row.account_id, 'account sync account id'),
        stringValue(row.scope, 'account sync scope'),
        positiveIntegerValue(row.version, 'account sync version'),
        stringValue(row.payload_ciphertext, 'account sync ciphertext'),
        stringValue(row.payload_iv, 'account sync IV'),
        stringValue(row.payload_auth_tag, 'account sync authentication tag'),
        sha256Value(row.payload_hash, 'account sync payload hash'),
        optionalString(row.device_id),
        row.updated_at_ms == null
          ? timestamp(row.updated_at, 'account sync updated_at')
          : millisecondTimestamp(
              row.updated_at_ms,
              'account sync updated_at_ms',
            ),
      ],
    );
  }

  for (const row of input.loaded.get('knowledge') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'knowledge organization id',
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'knowledge',
      resourceType: 'entry',
      resourceId: String(row.id),
      ownerAccountId: optionalString(row.contributor_account_id),
      status: optionalString(row.status) ?? 'active',
      version: positiveIntegerValue(row.version ?? 1, 'knowledge version'),
      payload: {
        title: optionalString(row.title),
        department: optionalString(row.department),
        category: optionalString(row.category) ?? 'general',
        content: stringValue(row.content, 'knowledge content'),
        tags: [],
        contributor: optionalString(row.contributor) ?? 'Unknown',
        contributorAccountId: optionalString(row.contributor_account_id) ?? '',
        confidence: Number(row.confidence ?? 0.5),
        sourceType: optionalString(row.source_type) ?? 'manual',
        sourceId: optionalString(row.source_id),
        sourceLabel: optionalString(row.source_label),
        reviewedBy: optionalString(row.reviewed_by),
        reviewedAt: optionalString(row.reviewed_at),
        reviewNote: null,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('knowledge_revisions') ?? []) {
    await insertBusinessEvent({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'knowledge revision organization id',
      ),
      domain: 'knowledge',
      eventId: `revision_${String(row.id)}`,
      resourceType: 'entry',
      resourceId: String(row.knowledge_id),
      eventType: 'revised',
      payload: {
        version: Number(row.version),
        title: row.title,
        department: row.department,
        category: row.category,
        content: row.content,
        confidence: row.confidence,
        sourceType: row.source_type,
        sourceLabel: row.source_label,
        status: row.status,
        changedBy: row.changed_by,
        changeNote: row.change_note,
      },
      createdAt: row.created_at,
    });
  }
  for (const row of input.loaded.get('knowledge_retention_evidence') ?? []) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'knowledge evidence organization id',
      ),
      domain: 'knowledge',
      resourceType: 'retention_evidence',
      resourceId: String(row.id),
      ownerAccountId: optionalString(row.contributor_account_id),
      status: booleanValue(row.verified ?? 0) ? 'verified' : 'observed',
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'organization_id'].includes(key),
        ),
      ),
      createdAt: row.created_at,
      updatedAt: row.created_at,
    });
  }

  for (const row of input.loaded.get('enterprise_skills') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'skill organization id',
    );
    const content = importedSkillContent(row, input.fieldCipher);
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'skills',
      resourceType: 'skill',
      resourceId: stringValue(row.id, 'skill id'),
      ownerAccountId: optionalString(row.author_account_id),
      status: optionalString(row.status) ?? 'pending_review',
      version: positiveIntegerValue(row.version ?? 1, 'skill version'),
      payload: {
        slug: stringValue(row.slug, 'skill slug'),
        name: stringValue(row.name, 'skill name'),
        description: stringValue(row.description, 'skill description'),
        department: optionalString(row.department),
        visibility: row.visibility === 'company' ? 'company' : 'department',
        authorAccountId: optionalString(row.author_account_id) ?? '',
        authorName: optionalString(row.author_name) ?? 'Unknown',
        content,
        contentHash: sha256Value(row.content_hash, 'skill content hash'),
        installCount: nonNegativeIntegerValue(
          row.install_count ?? 0,
          'skill install count',
        ),
        usageCount: nonNegativeIntegerValue(
          row.usage_count ?? 0,
          'skill usage count',
        ),
        successCount: nonNegativeIntegerValue(
          row.success_count ?? 0,
          'skill success count',
        ),
        failureCount: nonNegativeIntegerValue(
          row.failure_count ?? 0,
          'skill failure count',
        ),
        ratingTotal: nonNegativeIntegerValue(
          row.rating_total ?? 0,
          'skill rating total',
        ),
        ratingCount: nonNegativeIntegerValue(
          row.rating_count ?? 0,
          'skill rating count',
        ),
        reviewedBy: optionalString(row.reviewed_by),
        reviewedAt: optionalString(row.reviewed_at),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('enterprise_skill_versions') ?? []) {
    await insertBusinessEvent({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'skill version organization id',
      ),
      domain: 'skills',
      eventId: `version:${String(row.skill_id)}:${String(row.version)}`,
      resourceType: 'skill',
      resourceId: stringValue(row.skill_id, 'skill version skill id'),
      actorAccountId: optionalString(row.created_by),
      eventType: 'versioned',
      payload: {
        version: positiveIntegerValue(row.version, 'skill version'),
        content: importedSkillContent(row, input.fieldCipher),
        contentHash: sha256Value(
          row.content_hash,
          'skill version content hash',
        ),
        description: stringValue(row.description, 'skill version description'),
      },
      createdAt: row.created_at,
    });
  }
  for (const [table, eventType] of [
    ['enterprise_skill_installs', 'installed'],
    ['enterprise_skill_ratings', 'rated'],
    ['enterprise_skill_usage_events', 'used'],
  ] as const) {
    for (const row of input.loaded.get(table) ?? []) {
      await insertBusinessEvent({
        client: input.client,
        organizationId: stringValue(
          row.organization_id,
          `${table} organization id`,
        ),
        domain: 'skills',
        eventId:
          optionalString(row.event_id) ??
          `${eventType}:${String(row.account_id)}:${String(row.skill_id)}`,
        resourceType: 'skill',
        resourceId: stringValue(row.skill_id, `${table} skill id`),
        actorAccountId: optionalString(row.account_id),
        eventType,
        payload: {
          installedVersion: row.installed_version,
          score: row.score,
          success: row.success == null ? undefined : booleanValue(row.success),
        },
        createdAt: row.created_at ?? row.installed_at,
      });
    }
  }

  const parkOrganizations = new Map<string, string>();
  const parkInviteSecrets = new Map<string, string>();
  for (const row of input.loaded.get('parks') ?? []) {
    const organizationId = stringValue(
      row.admin_organization_id,
      'park admin organization id',
    );
    const parkId = stringValue(row.id, 'park id');
    parkOrganizations.set(parkId, organizationId);
    parkInviteSecrets.set(
      parkId,
      stringValue(row.invite_secret, 'park invite secret'),
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'park',
      resourceId: parkId,
      status: optionalString(row.status) ?? 'active',
      payload: {
        name: stringValue(row.name, 'park name'),
        address: optionalString(row.address),
        adminOrganizationId: organizationId,
        brandName: optionalString(row.brand_name),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_invites') ?? []) {
    const parkId = stringValue(row.park_id, 'park invite park id');
    const organizationId = parkOrganizations.get(parkId);
    const inviteSecret = parkInviteSecrets.get(parkId);
    if (!organizationId || !inviteSecret) {
      throw new Error('SQLite promotion park invitation has no park');
    }
    const nonce = stringValue(row.nonce, 'park invite nonce');
    const digest = createHmac('sha256', inviteSecret)
      .update(`${parkId}:${nonce}`)
      .digest();
    let code = '';
    for (let index = 0; index < 12; index += 1) {
      code += INVITE_ALPHABET[digest[index]! % INVITE_ALPHABET.length];
    }
    const formatted = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
    const expiresAt = millisecondTimestamp(
      row.expires_at_ms,
      'park invite expires_at_ms',
    );
    const usedCount = nonNegativeIntegerValue(
      row.used_count ?? 0,
      'park invite used count',
    );
    const maxUses =
      row.max_uses == null
        ? 1_000_000
        : positiveIntegerValue(row.max_uses, 'park invite max uses');
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'invite',
      resourceId: stringValue(row.id, 'park invite id'),
      ownerAccountId: optionalString(row.created_by_account_id),
      status:
        row.revoked_at_ms != null
          ? 'revoked'
          : usedCount >= maxUses
            ? 'consumed'
            : 'active',
      payload: {
        parkId,
        adminOrganizationId: organizationId,
        codeSha256: createHash('sha256').update(formatted).digest('hex'),
        maxUses,
        usedCount,
        expiresAt,
      },
      createdAt: row.created_at,
      updatedAt: row.created_at,
    });
  }
  for (const row of input.loaded.get('park_services') ?? []) {
    const parkId = stringValue(row.park_id, 'park service park id');
    const organizationId = parkOrganizations.get(parkId);
    if (!organizationId)
      throw new Error('SQLite promotion park service has no park');
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'service',
      resourceId: stringValue(row.id, 'park service id'),
      status: booleanValue(row.enabled) ? 'active' : 'disabled',
      payload: {
        name: stringValue(row.name, 'park service name'),
        enabled: booleanValue(row.enabled),
        formSchema: jsonValue(row.config_json, {}),
      },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_tenant_profiles') ?? []) {
    const parkId = stringValue(row.park_id, 'park membership park id');
    const adminOrganizationId = parkOrganizations.get(parkId);
    if (!adminOrganizationId)
      throw new Error('SQLite promotion park membership has no park');
    const organizationId = stringValue(
      row.organization_id,
      'park membership organization id',
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'membership',
      resourceId: `membership_${organizationId}`,
      payload: {
        parkId,
        adminOrganizationId,
        address: optionalString(row.address),
        roomNumber: optionalString(row.room_number),
        joinedAt: legacyTimestamp(row.updated_at),
      },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_service_specialists') ?? []) {
    const parkId = stringValue(row.park_id, 'park specialist park id');
    const organizationId = parkOrganizations.get(parkId);
    if (!organizationId)
      throw new Error('SQLite promotion park specialist has no park');
    const accountId = stringValue(row.account_id, 'park specialist account id');
    const serviceId = stringValue(row.service_id, 'park specialist service id');
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'specialist',
      resourceId: `${accountId}_${serviceId}`,
      ownerAccountId: accountId,
      payload: { accountId, serviceIds: [serviceId] },
      createdAt: row.created_at,
      updatedAt: row.created_at,
    });
  }
  for (const row of input.loaded.get('park_settings') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'park settings organization id',
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'settings',
      resourceId: 'default',
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['organization_id', 'updated_at'].includes(key),
        ),
      ),
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_meeting_rooms') ?? []) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'meeting room organization id',
      ),
      domain: 'park',
      resourceType: 'meeting_room',
      resourceId: stringValue(row.id, 'meeting room id'),
      status: booleanValue(row.enabled ?? 1) ? 'active' : 'disabled',
      payload: {
        name: row.name,
        capacity: row.capacity,
        location: row.location,
        priceHalfDay: row.price_half_day,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_meeting_slots') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'meeting slot organization id',
    );
    const resourceId =
      optionalString(row.id) ??
      `${String(row.room_id)}:${String(row.date)}:${String(row.start_time ?? row.slot_key)}`;
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'meeting_slot',
      resourceId,
      status: booleanValue(row.available ?? 1) ? 'active' : 'unavailable',
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['organization_id', 'id'].includes(key),
        ),
      ),
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('park_meeting_bookings') ?? []) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'meeting booking organization id',
      ),
      domain: 'park',
      resourceType: 'meeting_booking',
      resourceId: stringValue(row.id, 'meeting booking id'),
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'organization_id'].includes(key),
        ),
      ),
      createdAt: row.created_at,
      updatedAt: row.created_at,
    });
  }
  for (const row of input.loaded.get('park_meeting_slot_overrides') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'meeting slot override organization id',
    );
    const resourceId = [row.meeting_room_id, row.use_date, row.slot_key]
      .map(String)
      .join(':');
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'meeting_slot_override',
      resourceId,
      status: booleanValue(row.enabled ?? 1) ? 'active' : 'disabled',
      payload: Object.fromEntries(
        Object.entries(row).filter(([key]) => key !== 'organization_id'),
      ),
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }

  const publicationRecipients = new Map<string, DecodedRow[]>();
  for (const row of input.loaded.get('park_publication_recipients') ?? []) {
    const publicationId = stringValue(
      row.publication_id,
      'publication recipient id',
    );
    publicationRecipients.set(publicationId, [
      ...(publicationRecipients.get(publicationId) ?? []),
      row,
    ]);
  }
  for (const row of input.loaded.get('park_publications') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'publication organization id',
    );
    const publicationId = stringValue(row.id, 'publication id');
    const recipients = publicationRecipients.get(publicationId) ?? [];
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'publication',
      resourceId: publicationId,
      ownerAccountId: optionalString(row.created_by_account_id),
      status: 'published',
      payload: {
        kind: row.kind === 'satisfaction' ? 'survey' : 'announcement',
        title: row.title,
        content: row.body,
        targetOrganizationId: null,
        recipientAccountIds: recipients.map(
          (recipient) => recipient.account_id,
        ),
        options: [],
      },
      createdAt: row.created_at,
      updatedAt: row.created_at,
    });
    for (const recipient of recipients) {
      if (recipient.read_at == null && recipient.submitted_at == null) continue;
      await insertBusinessEvent({
        client: input.client,
        organizationId,
        domain: 'park',
        eventId: `${recipient.submitted_at == null ? 'read' : 'survey'}:${String(recipient.account_id)}:${publicationId}`,
        resourceType: 'publication',
        resourceId: publicationId,
        actorAccountId: optionalString(recipient.account_id),
        eventType: recipient.submitted_at == null ? 'read' : 'survey',
        payload: {
          response: jsonValue(recipient.response_data, null),
        },
        createdAt: recipient.submitted_at ?? recipient.read_at,
      });
    }
  }

  const statisticsAssignments = new Map<string, DecodedRow[]>();
  for (const row of input.loaded.get('park_data_statistics_assignments') ??
    []) {
    const taskId = stringValue(row.task_id, 'statistics assignment task id');
    statisticsAssignments.set(taskId, [
      ...(statisticsAssignments.get(taskId) ?? []),
      row,
    ]);
  }
  for (const row of input.loaded.get('park_data_statistics_tasks') ?? []) {
    const organizationId = stringValue(
      row.admin_organization_id,
      'statistics task organization id',
    );
    const taskId = stringValue(row.id, 'statistics task id');
    const assignments = statisticsAssignments.get(taskId) ?? [];
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'park',
      resourceType: 'statistics_task',
      resourceId: taskId,
      ownerAccountId: optionalString(row.created_by_account_id),
      status: optionalString(row.status) ?? 'open',
      payload: {
        parkId: row.park_id,
        title: row.title,
        description: row.description,
        deadline: row.deadline,
        template: jsonValue(row.template_data ?? row.fields_json, {}),
        targetOrganizationId: null,
        recipientAccountIds: assignments.flatMap((assignment) =>
          [assignment.ceo_account_id, assignment.assignee_account_id].filter(
            (value): value is string =>
              typeof value === 'string' && value.length > 0,
          ),
        ),
        assignments,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  const ticketDeliveries = new Map<string, string[]>();
  for (const row of input.loaded.get('ticket_deliveries') ?? []) {
    const ticketId = stringValue(row.ticket_id, 'ticket delivery ticket id');
    const recipients = ticketDeliveries.get(ticketId) ?? [];
    recipients.push(stringValue(row.account_id, 'ticket delivery account id'));
    ticketDeliveries.set(ticketId, recipients);
  }
  for (const row of input.loaded.get('park_application_sequences') ?? []) {
    const parkId = stringValue(row.park_id, 'park sequence park id');
    const organizationId = parkOrganizations.get(parkId);
    if (!organizationId) {
      throw new Error('SQLite promotion park sequence has no park');
    }
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'ticketing',
      resourceType: 'application_sequence',
      resourceId: `${parkId}:${stringValue(row.date_key, 'park sequence date')}`,
      payload: {
        parkId,
        dateKey: row.date_key,
        lastSequence: row.last_sequence,
      },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('it_tickets') ?? []) {
    const organizationId = stringValue(
      row.organization_id,
      'ticket organization id',
    );
    const parkId = optionalString(row.park_id);
    const assigneeAccountIds = ticketDeliveries.get(String(row.id)) ?? [];
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'ticketing',
      resourceType: 'ticket',
      resourceId: stringValue(row.id, 'ticket id'),
      ownerAccountId: stringValue(
        row.created_by_account_id,
        'ticket creator account id',
      ),
      status: optionalString(row.status) ?? 'open',
      payload: {
        createdByAccountId: row.created_by_account_id,
        createdByName: optionalString(row.contact) ?? 'Unknown',
        sourceOrganizationId: organizationId,
        targetOrganizationId: parkId
          ? (parkOrganizations.get(parkId) ?? organizationId)
          : organizationId,
        parkId,
        serviceId: optionalString(row.service_id) ?? 'it',
        title: stringValue(row.title, 'ticket title'),
        description: stringValue(row.description, 'ticket description'),
        targetTags: jsonValue(row.target_tags, []),
        formData: jsonValue(row.form_data, {}),
        assigneeAccountIds,
        participantAccountIds: [
          row.created_by_account_id,
          ...assigneeAccountIds,
        ],
        unreadAccountIds: assigneeAccountIds,
        responseType: optionalString(row.response_type),
        responseText: optionalString(row.response_text),
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('ticket_events') ?? []) {
    const ticket = (input.loaded.get('it_tickets') ?? []).find(
      (candidate) => candidate.id === row.ticket_id,
    );
    if (!ticket) continue;
    await insertBusinessEvent({
      client: input.client,
      organizationId: stringValue(
        ticket.organization_id,
        'ticket event organization id',
      ),
      domain: 'ticketing',
      eventId:
        optionalString(row.id) ??
        `ticket_event_${String(row.ticket_id)}_${String(row.created_at)}`,
      resourceType: 'ticket',
      resourceId: stringValue(row.ticket_id, 'ticket event ticket id'),
      actorAccountId: optionalString(row.account_id ?? row.actor_account_id),
      eventType: optionalString(row.action) ?? 'updated',
      payload: jsonObject(
        optionalString(row.detail) ?? optionalString(row.response_text) ?? '',
      ),
      createdAt: row.created_at,
    });
  }
  for (const row of input.loaded.get('ticket_notifications') ?? []) {
    const ticket = (input.loaded.get('it_tickets') ?? []).find(
      (candidate) => candidate.id === row.ticket_id,
    );
    if (!ticket) continue;
    await insertBusinessEvent({
      client: input.client,
      organizationId: stringValue(
        row.organization_id ?? ticket.organization_id,
        'ticket notification organization id',
      ),
      domain: 'ticketing',
      eventId: `notification:${stringValue(row.id, 'ticket notification id')}`,
      resourceType: 'ticket',
      resourceId: stringValue(row.ticket_id, 'ticket notification ticket id'),
      eventType: 'notification',
      payload: {
        recipientAccountId: row.recipient_account_id,
        channel: row.channel,
        event: row.event,
        status: row.status,
        detail: row.detail,
      },
      createdAt: row.created_at,
    });
  }

  for (const row of input.loaded.get('deployment_license') ?? []) {
    const organizationId = optionalString(row.organization_id) ?? 'org_default';
    const raw = jsonValue(row.raw_json, {}) as Record<string, unknown>;
    const sanitized = sanitizeCommercialPayload(raw);
    await insertBusinessRecord({
      client: input.client,
      organizationId,
      domain: 'commercial_control',
      resourceType: 'license',
      resourceId: 'current',
      status: row.revoked_at_ms == null ? 'active' : 'revoked',
      version: positiveIntegerValue(row.revision ?? 1, 'license revision'),
      payload: {
        ...sanitized,
        id: row.id,
        deploymentId: row.deployment_id,
        organizationId,
        customerName: row.customer_name,
        plan: row.plan,
        expiresAt: millisecondTimestamp(
          row.expires_at_ms,
          'license expires_at_ms',
        ),
        seatLimit: row.seat_limit,
        modules: jsonValue(row.modules_json, []),
        offline: booleanValue(row.offline),
        telemetryAllowed: booleanValue(row.telemetry_allowed),
        signatureAlgorithm: row.signature_algorithm,
        signingKeyId: row.signing_key_id,
      },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const row of input.loaded.get('deployment_license_leases') ?? []) {
    const raw = jsonValue(row.raw_json, {}) as Record<string, unknown>;
    await insertBusinessRecord({
      client: input.client,
      organizationId: optionalString(raw.organizationId) ?? 'org_default',
      domain: 'commercial_control',
      resourceType: 'license_lease',
      resourceId: stringValue(row.license_id, 'license lease id'),
      status: row.revoked_at_ms == null ? 'active' : 'revoked',
      payload: {
        ...sanitizeCommercialPayload(raw),
        leaseId: row.lease_id,
        deploymentId: row.deployment_id,
        issuedAt: millisecondTimestamp(
          row.issued_at_ms,
          'license lease issued_at_ms',
        ),
        expiresAt: millisecondTimestamp(
          row.expires_at_ms,
          'license lease expires_at_ms',
        ),
        revokedAt:
          row.revoked_at_ms == null
            ? null
            : millisecondTimestamp(
                row.revoked_at_ms,
                'license lease revoked_at_ms',
              ),
        signingKeyId: row.signing_key_id,
      },
      createdAt: millisecondTimestamp(
        row.last_refresh_at_ms,
        'license lease refresh time',
      ),
      updatedAt: row.updated_at,
    });
  }
  const deploymentSettings = new Map(
    (input.loaded.get('deployment_settings') ?? []).map((row) => [
      stringValue(row.key, 'deployment setting key'),
      String(row.value ?? ''),
    ]),
  );
  if (
    deploymentSettings.has('telemetry_enabled') ||
    deploymentSettings.has('telemetry_content_mode') ||
    deploymentSettings.has('telemetry_endpoint')
  ) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: 'org_default',
      domain: 'commercial_control',
      resourceType: 'telemetry_settings',
      resourceId: 'current',
      payload: {
        enabled: deploymentSettings.get('telemetry_enabled') !== 'false',
        contentMode:
          deploymentSettings.get('telemetry_content_mode') ===
          'diagnostic_redacted'
            ? 'diagnostic_redacted'
            : 'operational_only',
        endpoint: deploymentSettings.get('telemetry_endpoint') || null,
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
  }
  const moduleUpdates = jsonValue(
    deploymentSettings.get('module_update_manifest'),
    [],
  );
  if (Array.isArray(moduleUpdates)) {
    for (const candidate of moduleUpdates) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        Array.isArray(candidate)
      )
        continue;
      const descriptor = candidate as Record<string, unknown>;
      const moduleName = optionalString(descriptor.module);
      if (!moduleName) continue;
      await insertBusinessRecord({
        client: input.client,
        organizationId: 'org_default',
        domain: 'commercial_control',
        resourceType: 'module_update',
        resourceId: moduleName,
        status: descriptor.rollout === 'off' ? 'disabled' : 'active',
        payload: descriptor,
        createdAt: descriptor.updatedAt,
        updatedAt: descriptor.updatedAt,
      });
    }
  }
  for (const row of input.loaded.get('deployment_settings') ?? []) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: 'org_default',
      domain: 'commercial_control',
      resourceType: 'legacy_setting',
      resourceId: stringValue(row.key, 'deployment setting key'),
      payload: { value: row.value },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }
  for (const table of [
    'telemetry_events',
    'telemetry_ingest_events',
  ] as const) {
    for (const row of input.loaded.get(table) ?? []) {
      const organizationId =
        optionalString(row.organization_id) ?? 'org_default';
      await insertBusinessRecord({
        client: input.client,
        organizationId,
        domain: 'commercial_control',
        resourceType: 'telemetry_batch',
        resourceId: stringValue(row.id ?? row.event_id, 'telemetry event id'),
        status: optionalString(row.status) ?? 'received',
        payload: jsonValue(row.payload_json, {}) as Record<string, unknown>,
        createdAt:
          row.created_at_ms == null
            ? row.updated_at
            : millisecondTimestamp(
                row.created_at_ms,
                'telemetry created_at_ms',
              ),
        updatedAt: row.updated_at,
      });
    }
  }
  for (const row of input.loaded.get('telemetry_ingest_nonces') ?? []) {
    const deploymentId = stringValue(
      row.deployment_id,
      'telemetry nonce deployment id',
    );
    const nonce = stringValue(row.nonce, 'telemetry nonce');
    await insertBusinessRecord({
      client: input.client,
      organizationId: 'org_default',
      domain: 'commercial_control',
      resourceType: 'telemetry_nonce',
      resourceId: createHash('sha256')
        .update(`${deploymentId}\0${nonce}`, 'utf8')
        .digest('hex'),
      status: 'received',
      payload: {
        deploymentId,
        nonceSha256: createHash('sha256').update(nonce, 'utf8').digest('hex'),
        receivedAtMs: row.received_at_ms,
      },
      createdAt: millisecondTimestamp(
        row.received_at_ms,
        'telemetry nonce received_at_ms',
      ),
      updatedAt: millisecondTimestamp(
        row.received_at_ms,
        'telemetry nonce received_at_ms',
      ),
    });
  }
  for (const [table, resourceType] of [
    ['billing_usage_outbox', 'billing_usage'],
    ['billing_admission_outbox', 'billing_admission'],
  ] as const) {
    for (const row of input.loaded.get(table) ?? []) {
      await insertBusinessRecord({
        client: input.client,
        organizationId: optionalString(row.organization_id) ?? 'org_default',
        domain: 'commercial_control',
        resourceType,
        resourceId: stringValue(row.id, `${table} id`),
        status: optionalString(row.status) ?? 'queued',
        payload: Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !['id', 'organization_id', 'status'].includes(key),
          ),
        ),
        createdAt:
          row.created_at_ms == null
            ? row.updated_at
            : millisecondTimestamp(row.created_at_ms, `${table} created_at_ms`),
        updatedAt: row.updated_at,
      });
    }
  }
  for (const row of input.loaded.get('billing_execution_receipt_keys') ?? []) {
    const deploymentId = stringValue(
      row.deployment_id,
      'billing receipt deployment id',
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId: 'org_default',
      domain: 'commercial_control',
      resourceType: 'billing_receipt_key',
      resourceId: `${deploymentId}:${stringValue(row.key_id, 'billing receipt key id')}`,
      status: optionalString(row.status) ?? 'active',
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['deployment_id', 'key_id', 'status'].includes(key),
        ),
      ),
      createdAt: millisecondTimestamp(
        row.created_at_ms,
        'billing receipt key created_at_ms',
      ),
      updatedAt:
        row.retired_at_ms == null
          ? millisecondTimestamp(
              row.created_at_ms,
              'billing receipt key created_at_ms',
            )
          : millisecondTimestamp(
              row.retired_at_ms,
              'billing receipt key retired_at_ms',
            ),
    });
  }
  for (const row of input.loaded.get('billing_execution_receipt_sequences') ??
    []) {
    const deploymentId = stringValue(
      row.deployment_id,
      'billing sequence deployment id',
    );
    await insertBusinessRecord({
      client: input.client,
      organizationId: 'org_default',
      domain: 'commercial_control',
      resourceType: 'billing_receipt_sequence',
      resourceId: deploymentId,
      payload: { lastSequence: row.last_sequence },
      createdAt: row.updated_at,
      updatedAt: row.updated_at,
    });
  }

  for (const row of input.loaded.get('privacy_requests') ?? []) {
    await insertBusinessRecord({
      client: input.client,
      organizationId: stringValue(
        row.organization_id,
        'privacy request organization id',
      ),
      domain: 'data_governance',
      resourceType: 'privacy_request',
      resourceId: String(row.id),
      ownerAccountId: optionalString(row.account_id),
      status: optionalString(row.status) ?? 'completed',
      payload: Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'organization_id'].includes(key),
        ),
      ),
      createdAt: row.created_at,
      updatedAt: row.completed_at ?? row.created_at,
    });
  }
}

const INSERTS: Record<
  (typeof PROMOTION_ORDER)[number],
  (client: PostgresClientLike, rows: DecodedRow[]) => Promise<void>
> = {
  organizations: insertOrganizations,
  organization_features: insertOrganizationFeatures,
  organization_departments: insertDepartments,
  organization_positions: insertPositions,
  accounts: insertAccounts,
  organization_invites: insertOrganizationInvites,
  account_tags: insertTags,
  auth_sessions: insertSessions,
  audit_logs: insertAudits,
  e2ee_devices: insertDevices,
  e2ee_key_transparency_log: insertTransparency,
  direct_messages: insertMessages,
  mls_key_packages: insertMlsKeyPackages,
  mls_conversations: insertMlsConversations,
  mls_group_sessions: insertMlsGroupSessions,
  mls_transport_events: insertMlsTransportEvents,
  mls_resource_rate_buckets: insertMlsResourceRateBuckets,
};

export async function promoteVerifiedSqliteImport(input: {
  pool: PostgresPoolLike;
  runId: string;
  dryRun?: boolean;
  defaultAttachmentQuotaBytes?: number;
  legacyAttachmentGraceMs?: number;
  fieldCipher?: EncryptedFieldCipher;
}): Promise<PostgresEnterprisePromotionResult> {
  const runId = input.runId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(runId)) {
    throw new Error('SQLite import run id is invalid');
  }
  const client = await input.pool.connect();
  let active = false;
  try {
    await client.query('BEGIN');
    active = true;
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      PROMOTION_LOCK_KEY,
    ]);
    const previous = await client.query<PromotionReceiptRow>(
      `SELECT run_id, promoted_counts, promoted_at
       FROM otto_sqlite_import_promotions WHERE run_id = $1`,
      [runId],
    );
    if (previous.rows[0]) {
      await client.query('ROLLBACK');
      active = false;
      return receipt(previous.rows[0]);
    }
    const runResult = await client.query<ImportRunRow>(
      'SELECT id, state FROM otto_sqlite_import_runs WHERE id = $1 FOR UPDATE',
      [runId],
    );
    if (!runResult.rows[0] || runResult.rows[0].state !== 'verified') {
      throw new Error('SQLite import run is missing or not verified');
    }
    await assertUnusedTarget(client);
    const loaded = new Map<string, DecodedRow[]>();
    const counts: Record<string, number> = {};
    for (const table of PROMOTION_ORDER) {
      const rows = await loadVerifiedSqliteImportTable(client, runId, table);
      loaded.set(table, rows);
      counts[table] = rows.length;
    }
    for (const table of BUSINESS_PROMOTION_ORDER) {
      const rows = await loadVerifiedSqliteImportTable(client, runId, table);
      loaded.set(table, rows);
      counts[table] = rows.length;
    }
    const attachmentRows = await loadVerifiedSqliteImportTable(
      client,
      runId,
      'direct_message_attachments',
    );
    counts.direct_message_attachments = attachmentRows.length;
    const preparedAttachments = await verifiedPreparedAttachments({
      client,
      runId,
      attachmentRows,
      messageRows: loaded.get('direct_messages') ?? [],
    });
    const defaultAttachmentQuotaBytes =
      input.defaultAttachmentQuotaBytes ?? 100 * 1024 * 1024 * 1024;
    const legacyAttachmentGraceMs =
      input.legacyAttachmentGraceMs ?? 30 * 24 * 60 * 60 * 1_000;
    if (
      !Number.isSafeInteger(defaultAttachmentQuotaBytes) ||
      defaultAttachmentQuotaBytes <= 0 ||
      !Number.isSafeInteger(legacyAttachmentGraceMs) ||
      legacyAttachmentGraceMs < 24 * 60 * 60 * 1_000
    ) {
      throw new Error('SQLite attachment promotion configuration is invalid');
    }
    const plannedBytesByOrganization = new Map<string, number>();
    for (const attachment of preparedAttachments) {
      const next =
        (plannedBytesByOrganization.get(attachment.organizationId) ?? 0) +
        attachment.ciphertextBytes;
      if (!Number.isSafeInteger(next) || next > defaultAttachmentQuotaBytes) {
        throw new Error(
          `SQLite attachment import exceeds the configured quota for ${attachment.organizationId}`,
        );
      }
      plannedBytesByOrganization.set(attachment.organizationId, next);
    }
    if ((loaded.get('organizations')?.length ?? 0) === 0) {
      throw new Error('SQLite import contains no organizations');
    }
    if (input.dryRun) {
      await client.query('ROLLBACK');
      active = false;
      return {
        runId,
        state: 'planned',
        promotedCounts: counts,
        promotedAt: null,
      };
    }
    for (const table of PROMOTION_ORDER) {
      await INSERTS[table](client, loaded.get(table)!);
    }
    await promoteBusinessTables({
      client,
      loaded,
      fieldCipher: input.fieldCipher,
    });
    await insertPreparedAttachments({
      client,
      attachments: preparedAttachments,
      defaultQuotaBytes: defaultAttachmentQuotaBytes,
      legacyGraceMs: legacyAttachmentGraceMs,
    });
    const inserted = await client.query<PromotionReceiptRow>(
      `INSERT INTO otto_sqlite_import_promotions (run_id, promoted_counts)
       VALUES ($1, $2::jsonb)
       RETURNING run_id, promoted_counts, promoted_at`,
      [runId, JSON.stringify(counts)],
    );
    await client.query('COMMIT');
    active = false;
    const promoted = receipt(inserted.rows[0]!);
    return { ...promoted, state: 'promoted' };
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the promotion error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
