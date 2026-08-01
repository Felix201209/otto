/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Atomically promotes a verified SQLite staging run into the PostgreSQL core
 * domain. The target must be unused; retries are idempotent through the
 * promotion receipt and no partial domain state can commit.
 */

import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';

const PROMOTION_LOCK_KEY = 0x4f545450;

interface ImportRunRow extends Record<string, unknown> {
  id: string;
  state: string;
}

interface ImportTableRow extends Record<string, unknown> {
  table_name: string;
  column_names: unknown[] | string;
  source_row_count: number | string;
  copied_row_count: number | string | null;
  state: string;
}

interface ImportDataRow extends Record<string, unknown> {
  row_data: unknown[] | string;
}

interface PromotionReceiptRow extends Record<string, unknown> {
  run_id: string;
  promoted_counts: Record<string, number> | string;
  promoted_at: Date | string;
}

export interface PostgresEnterprisePromotionResult {
  runId: string;
  state: 'promoted' | 'already-promoted' | 'planned';
  promotedCounts: Record<string, number>;
  promotedAt: string | null;
}

type DecodedRow = Record<string, unknown>;

const PROMOTION_ORDER = [
  'organizations',
  'organization_features',
  'organization_departments',
  'organization_positions',
  'accounts',
  'account_tags',
  'auth_sessions',
  'audit_logs',
  'e2ee_devices',
  'e2ee_key_transparency_log',
  'direct_messages',
] as const;

function parseArray(value: unknown[] | string, label: string): unknown[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) throw new Error(`${label} is not a JSON array`);
  return parsed;
}

function decodeValue(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    'value' in value
  ) {
    const encoded = value as { type: unknown; value: unknown };
    if (encoded.type === 'bytes' && typeof encoded.value === 'string') {
      return Buffer.from(encoded.value, 'base64');
    }
    if (encoded.type === 'bigint' && typeof encoded.value === 'string') {
      return encoded.value;
    }
    if (encoded.type === 'number' && encoded.value === '-0') return 0;
    throw new Error('SQLite staging row contains an unsupported encoded value');
  }
  return value;
}

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
  const raw = stringValue(value, label);
  const date = new Date(raw.endsWith('Z') || /[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`SQLite promotion ${label} is invalid`);
  return date.toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : timestamp(value, label);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function integerValue(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`SQLite promotion ${label} is invalid`);
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

async function loadTable(
  client: PostgresClientLike,
  runId: string,
  tableName: string,
): Promise<DecodedRow[]> {
  const tableResult = await client.query<ImportTableRow>(
    `SELECT table_name, column_names, source_row_count, copied_row_count, state
     FROM otto_sqlite_import_tables
     WHERE run_id = $1 AND table_name = $2`,
    [runId, tableName],
  );
  const table = tableResult.rows[0];
  if (!table) return [];
  if (
    table.state !== 'verified' ||
    Number(table.source_row_count) !== Number(table.copied_row_count)
  ) {
    throw new Error(`SQLite import table ${tableName} is not verified`);
  }
  const columns = parseArray(table.column_names, `${tableName} columns`).map(
    (column) => stringValue(column, `${tableName} column`),
  );
  const rows = await client.query<ImportDataRow>(
    `SELECT row_data FROM otto_sqlite_import_rows
     WHERE run_id = $1 AND table_name = $2 ORDER BY row_index`,
    [runId, tableName],
  );
  if (rows.rows.length !== Number(table.source_row_count)) {
    throw new Error(`SQLite import table ${tableName} row count changed after verification`);
  }
  return rows.rows.map((row, rowIndex) => {
    const values = parseArray(row.row_data, `${tableName} row ${rowIndex}`);
    if (values.length !== columns.length) {
      throw new Error(`SQLite import table ${tableName} row shape is invalid`);
    }
    return Object.fromEntries(
      columns.map((column, index) => [column, decodeValue(values[index])]),
    );
  });
}

async function assertUnusedTarget(client: PostgresClientLike): Promise<void> {
  const result = await client.query<
    {
      accounts: number | string;
      messages: number | string;
      non_default_organizations: number | string;
    } & Record<string, unknown>
  >(
    `SELECT
       (SELECT count(*) FROM accounts)::integer AS accounts,
       (SELECT count(*) FROM direct_messages)::integer AS messages,
       (SELECT count(*) FROM organizations WHERE id <> 'org_default')::integer
         AS non_default_organizations`,
  );
  const row = result.rows[0];
  if (
    !row ||
    Number(row.accounts) !== 0 ||
    Number(row.messages) !== 0 ||
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
        (id, name, slug, type, status, park_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, slug = EXCLUDED.slug, type = EXCLUDED.type,
         status = EXCLUDED.status, park_id = EXCLUDED.park_id,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        id,
        stringValue(row.name, 'organization name'),
        stringValue(row.slug, 'organization slug'),
        id.startsWith('personal_') ? 'personal' : 'enterprise',
        row.status === 'disabled' ? 'disabled' : 'active',
        optionalString(row.park_id),
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

async function insertOrganizationFeatures(
  client: PostgresClientLike,
  rows: DecodedRow[],
): Promise<void> {
  const features = new Map<string, Record<string, boolean>>();
  for (const row of rows) {
    const organizationId = stringValue(row.organization_id, 'feature organization id');
    const feature = stringValue(row.feature_key, 'feature key');
    if (!['enterprise_tree', 'direct_messages', 'atoa', 'park_services'].includes(feature)) {
      continue;
    }
    const current = features.get(organizationId) ?? {};
    current[feature] = booleanValue(row.enabled);
    features.set(organizationId, current);
  }
  for (const [organizationId, patch] of features) {
    await client.query(
      `UPDATE organization_features SET
         enterprise_tree = COALESCE($2, enterprise_tree),
         direct_messages = COALESCE($3, direct_messages),
         atoa = COALESCE($4, atoa),
         park_services = COALESCE($5, park_services),
         updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1`,
      [
        organizationId,
        patch.enterprise_tree ?? null,
        patch.direct_messages ?? null,
        patch.atoa ?? null,
        patch.park_services ?? null,
      ],
    );
  }
}

async function insertDepartments(client: PostgresClientLike, rows: DecodedRow[]) {
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

async function insertTransparency(client: PostgresClientLike, rows: DecodedRow[]) {
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
        e2ee ? null : integerValue(row.content_key_version, 'message key version'),
        e2ee ? 1 : null,
        e2ee ? stringValue(row.e2ee_sender_device_id, 'message sender device id') : null,
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

const INSERTS: Record<
  (typeof PROMOTION_ORDER)[number],
  (client: PostgresClientLike, rows: DecodedRow[]) => Promise<void>
> = {
  organizations: insertOrganizations,
  organization_features: insertOrganizationFeatures,
  organization_departments: insertDepartments,
  organization_positions: insertPositions,
  accounts: insertAccounts,
  account_tags: insertTags,
  auth_sessions: insertSessions,
  audit_logs: insertAudits,
  e2ee_devices: insertDevices,
  e2ee_key_transparency_log: insertTransparency,
  direct_messages: insertMessages,
};

export async function promoteVerifiedSqliteImport(input: {
  pool: PostgresPoolLike;
  runId: string;
  dryRun?: boolean;
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
      const rows = await loadTable(client, runId, table);
      loaded.set(table, rows);
      counts[table] = rows.length;
    }
    const attachmentRows = await loadTable(
      client,
      runId,
      'direct_message_attachments',
    );
    counts.direct_message_attachments = attachmentRows.length;
    if (attachmentRows.length > 0) {
      throw new Error(
        'SQLite import contains message attachments; promote them through the shared S3 migration before PostgreSQL cutover',
      );
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
