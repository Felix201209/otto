/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL authority for enterprise domains that previously only had the
 * synchronous SQLite implementation. The shared record/event tables keep
 * tenant ownership explicit while domain routes retain their typed contracts.
 */

import { randomUUID } from 'node:crypto';

import {
  ACCOUNT_SYNC_SCOPES,
  AccountSyncConflictError,
  decryptAccountSyncPayload,
  encryptAccountSyncPayload,
  normalizeAccountSyncPayload,
  type AccountSyncEncryptionKeyProvider,
  type AccountSyncScope,
  type AccountSyncSnapshotView,
} from '../modules/personal_intelligence/index.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';

export const POSTGRES_BUSINESS_DOMAINS = [
  'knowledge',
  'skills',
  'park',
  'ticketing',
  'commercial_control',
  'data_governance',
] as const;

export type PostgresBusinessDomain = (typeof POSTGRES_BUSINESS_DOMAINS)[number];

export interface PostgresBusinessRecord<T = Record<string, unknown>> {
  organizationId: string;
  domain: PostgresBusinessDomain;
  resourceType: string;
  resourceId: string;
  ownerAccountId: string | null;
  status: string;
  version: number;
  payload: T;
  createdAt: string;
  updatedAt: string;
}

export interface PostgresBusinessEvent<T = Record<string, unknown>> {
  organizationId: string;
  domain: PostgresBusinessDomain;
  eventId: string;
  resourceType: string;
  resourceId: string;
  actorAccountId: string | null;
  eventType: string;
  payload: T;
  createdAt: string;
  inserted: boolean;
}

interface BusinessRecordRow extends Record<string, unknown> {
  organization_id: string;
  domain: PostgresBusinessDomain;
  resource_type: string;
  resource_id: string;
  owner_account_id: string | null;
  status: string;
  version: number | string;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BusinessEventRow extends Record<string, unknown> {
  organization_id: string;
  domain: PostgresBusinessDomain;
  event_id: string;
  resource_type: string;
  resource_id: string;
  actor_account_id: string | null;
  event_type: string;
  payload: Record<string, unknown> | string;
  created_at: Date | string;
  inserted?: boolean;
}

interface AccountSyncRow extends Record<string, unknown> {
  account_id: string;
  organization_id: string;
  scope: AccountSyncScope;
  version: number | string;
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
  payload_hash: string;
  device_id: string | null;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function jsonObject<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function businessDomain(value: string): PostgresBusinessDomain {
  if (!(POSTGRES_BUSINESS_DOMAINS as readonly string[]).includes(value)) {
    throw new Error('business domain is invalid');
  }
  return value as PostgresBusinessDomain;
}

function recordView<T>(row: BusinessRecordRow): PostgresBusinessRecord<T> {
  return {
    organizationId: row.organization_id,
    domain: row.domain,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ownerAccountId: row.owner_account_id,
    status: row.status,
    version: Number(row.version),
    payload: jsonObject<T>(row.payload),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventView<T>(row: BusinessEventRow): PostgresBusinessEvent<T> {
  return {
    organizationId: row.organization_id,
    domain: row.domain,
    eventId: row.event_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    actorAccountId: row.actor_account_id,
    eventType: row.event_type,
    payload: jsonObject<T>(row.payload),
    createdAt: iso(row.created_at),
    inserted: row.inserted !== false,
  };
}

function accountSyncView(
  keyProvider: AccountSyncEncryptionKeyProvider,
  row: AccountSyncRow,
): AccountSyncSnapshotView {
  return {
    scope: row.scope,
    version: Number(row.version),
    payload: decryptAccountSyncPayload(keyProvider, {
      account_id: row.account_id,
      organization_id: row.organization_id,
      scope: row.scope,
      version: Number(row.version),
      payload_ciphertext: row.payload_ciphertext,
      payload_iv: row.payload_iv,
      payload_auth_tag: row.payload_auth_tag,
      payload_hash: row.payload_hash,
    }),
    payloadHash: row.payload_hash,
    deviceId: row.device_id,
    updatedAtMs: new Date(row.updated_at).getTime(),
  };
}

async function transaction<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
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
        // Preserve the original domain/PostgreSQL error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresEnterpriseBusinessRepository(input: {
  pool: PostgresPoolLike;
  accountSyncKeyProvider?: AccountSyncEncryptionKeyProvider;
  now?: () => Date;
  createId?: () => string;
}) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;

  function accountSyncKeyProvider(): AccountSyncEncryptionKeyProvider {
    if (!input.accountSyncKeyProvider) {
      throw new Error('account sync encryption key provider is unavailable');
    }
    return input.accountSyncKeyProvider;
  }

  async function listAccountSyncSnapshots(raw: {
    organizationId: string;
    accountId: string;
  }): Promise<AccountSyncSnapshotView[]> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const accountId = identifier(raw.accountId, 'account id');
    const result = await input.pool.query<AccountSyncRow>(
      `SELECT account_id, organization_id, scope, version, payload_ciphertext,
              payload_iv, payload_auth_tag, payload_hash, device_id, updated_at
       FROM account_sync_snapshots
       WHERE organization_id = $1 AND account_id = $2
       ORDER BY scope`,
      [organizationId, accountId],
    );
    const keyProvider = accountSyncKeyProvider();
    return result.rows.map((row) => accountSyncView(keyProvider, row));
  }

  async function putAccountSyncSnapshot(raw: {
    organizationId: string;
    accountId: string;
    scope: AccountSyncScope;
    expectedVersion: number;
    payload: unknown;
    deviceId?: string | null;
  }): Promise<AccountSyncSnapshotView> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const accountId = identifier(raw.accountId, 'account id');
    if (!(ACCOUNT_SYNC_SCOPES as readonly string[]).includes(raw.scope)) {
      throw new Error('account sync scope is invalid');
    }
    if (!Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 0) {
      throw new Error('account sync expectedVersion is invalid');
    }
    const payload = normalizeAccountSyncPayload(raw.scope, raw.payload);
    const deviceId = raw.deviceId?.trim().slice(0, 160) || null;
    const updatedAt = now();

    return transaction(input.pool, async (client) => {
      const account = await client.query<{ id: string }>(
        `SELECT id FROM accounts
         WHERE id = $1 AND organization_id = $2
           AND status = 'active' AND deleted_at IS NULL
         FOR UPDATE`,
        [accountId, organizationId],
      );
      if (!account.rows[0]) throw new Error('account not found');

      const current = await client.query<AccountSyncRow>(
        `SELECT account_id, organization_id, scope, version, payload_ciphertext,
                payload_iv, payload_auth_tag, payload_hash, device_id, updated_at
         FROM account_sync_snapshots
         WHERE organization_id = $1 AND account_id = $2 AND scope = $3
         FOR UPDATE`,
        [organizationId, accountId, raw.scope],
      );
      const currentVersion = Number(current.rows[0]?.version ?? 0);
      if (currentVersion !== raw.expectedVersion) {
        throw new AccountSyncConflictError(currentVersion);
      }
      const version = currentVersion + 1;
      const encrypted = encryptAccountSyncPayload(accountSyncKeyProvider(), {
        accountId,
        organizationId,
        scope: raw.scope,
        version,
        payload,
      });
      const saved = await client.query<AccountSyncRow>(
        `INSERT INTO account_sync_snapshots
           (organization_id, account_id, scope, version, payload_ciphertext,
            payload_iv, payload_auth_tag, payload_hash, device_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (organization_id, account_id, scope) DO UPDATE SET
           version = EXCLUDED.version,
           payload_ciphertext = EXCLUDED.payload_ciphertext,
           payload_iv = EXCLUDED.payload_iv,
           payload_auth_tag = EXCLUDED.payload_auth_tag,
           payload_hash = EXCLUDED.payload_hash,
           device_id = EXCLUDED.device_id,
           updated_at = EXCLUDED.updated_at
         WHERE account_sync_snapshots.version = $11
         RETURNING account_id, organization_id, scope, version,
                   payload_ciphertext, payload_iv, payload_auth_tag, payload_hash,
                   device_id, updated_at`,
        [
          organizationId,
          accountId,
          raw.scope,
          version,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.payloadHash,
          deviceId,
          updatedAt,
          currentVersion,
        ],
      );
      if (!saved.rows[0]) {
        const latest = await client.query<{ version: number | string }>(
          `SELECT version FROM account_sync_snapshots
           WHERE organization_id = $1 AND account_id = $2 AND scope = $3`,
          [organizationId, accountId, raw.scope],
        );
        throw new AccountSyncConflictError(
          Number(latest.rows[0]?.version ?? 0),
        );
      }
      return accountSyncView(accountSyncKeyProvider(), saved.rows[0]);
    });
  }

  async function listBusinessRecords<T = Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    ownerAccountId?: string;
    statuses?: readonly string[];
    limit?: number;
  }): Promise<Array<PostgresBusinessRecord<T>>> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const domain = businessDomain(raw.domain);
    const resourceType = identifier(raw.resourceType, 'resource type');
    const ownerAccountId = raw.ownerAccountId
      ? identifier(raw.ownerAccountId, 'owner account id')
      : null;
    const statuses = (raw.statuses ?? [])
      .map((status) => identifier(status, 'status'))
      .slice(0, 20);
    const limit = Math.min(500, Math.max(1, Math.floor(raw.limit ?? 100)));
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE organization_id = $1 AND domain = $2 AND resource_type = $3
         AND ($4::text IS NULL OR owner_account_id = $4)
         AND (cardinality($5::text[]) = 0 OR status = ANY($5::text[]))
       ORDER BY updated_at DESC, resource_id
       LIMIT $6`,
      [organizationId, domain, resourceType, ownerAccountId, statuses, limit],
    );
    return result.rows.map((row) => recordView<T>(row));
  }

  async function getBusinessRecord<T = Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    resourceId: string;
  }): Promise<PostgresBusinessRecord<T> | null> {
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE organization_id = $1 AND domain = $2
         AND resource_type = $3 AND resource_id = $4`,
      [
        identifier(raw.organizationId, 'organization id'),
        businessDomain(raw.domain),
        identifier(raw.resourceType, 'resource type'),
        identifier(raw.resourceId, 'resource id'),
      ],
    );
    return result.rows[0] ? recordView<T>(result.rows[0]) : null;
  }

  async function createBusinessRecord<T extends Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    resourceId?: string;
    ownerAccountId?: string | null;
    status?: string;
    payload: T;
  }): Promise<PostgresBusinessRecord<T>> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const domain = businessDomain(raw.domain);
    const resourceType = identifier(raw.resourceType, 'resource type');
    const resourceId = identifier(raw.resourceId ?? createId(), 'resource id');
    const ownerAccountId = raw.ownerAccountId
      ? identifier(raw.ownerAccountId, 'owner account id')
      : null;
    const status = identifier(raw.status ?? 'active', 'status');
    const result = await input.pool.query<BusinessRecordRow>(
      `INSERT INTO enterprise_business_records
         (organization_id, domain, resource_type, resource_id,
          owner_account_id, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING organization_id, domain, resource_type, resource_id,
                 owner_account_id, status, version, payload, created_at, updated_at`,
      [
        organizationId,
        domain,
        resourceType,
        resourceId,
        ownerAccountId,
        status,
        JSON.stringify(raw.payload),
      ],
    );
    return recordView<T>(result.rows[0]!);
  }

  async function updateBusinessRecord<T extends Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    resourceId: string;
    expectedVersion: number;
    status: string;
    payload: T;
  }): Promise<PostgresBusinessRecord<T> | null> {
    if (!Number.isInteger(raw.expectedVersion) || raw.expectedVersion < 1) {
      throw new Error('business record version is invalid');
    }
    const result = await input.pool.query<BusinessRecordRow>(
      `UPDATE enterprise_business_records
       SET status = $5, payload = $6::jsonb, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND domain = $2
         AND resource_type = $3 AND resource_id = $4 AND version = $7
       RETURNING organization_id, domain, resource_type, resource_id,
                 owner_account_id, status, version, payload, created_at, updated_at`,
      [
        identifier(raw.organizationId, 'organization id'),
        businessDomain(raw.domain),
        identifier(raw.resourceType, 'resource type'),
        identifier(raw.resourceId, 'resource id'),
        identifier(raw.status, 'status'),
        JSON.stringify(raw.payload),
        raw.expectedVersion,
      ],
    );
    return result.rows[0] ? recordView<T>(result.rows[0]) : null;
  }

  async function appendBusinessEvent<T extends Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    eventId?: string;
    resourceType: string;
    resourceId: string;
    actorAccountId?: string | null;
    eventType: string;
    payload: T;
  }): Promise<PostgresBusinessEvent<T>> {
    const result = await input.pool.query<BusinessEventRow>(
      `INSERT INTO enterprise_business_events
         (organization_id, domain, event_id, resource_type, resource_id,
          actor_account_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (organization_id, domain, event_id) DO UPDATE SET
         event_id = enterprise_business_events.event_id
       RETURNING organization_id, domain, event_id, resource_type, resource_id,
                 actor_account_id, event_type, payload, created_at,
                 (xmax = 0) AS inserted`,
      [
        identifier(raw.organizationId, 'organization id'),
        businessDomain(raw.domain),
        identifier(raw.eventId ?? createId(), 'event id'),
        identifier(raw.resourceType, 'resource type'),
        identifier(raw.resourceId, 'resource id'),
        raw.actorAccountId
          ? identifier(raw.actorAccountId, 'actor account id')
          : null,
        identifier(raw.eventType, 'event type'),
        JSON.stringify(raw.payload),
      ],
    );
    return eventView<T>(result.rows[0]!);
  }

  async function listBusinessEvents<T = Record<string, unknown>>(raw: {
    organizationId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    resourceId: string;
    limit?: number;
  }): Promise<Array<PostgresBusinessEvent<T>>> {
    const limit = Math.min(500, Math.max(1, Math.floor(raw.limit ?? 100)));
    const result = await input.pool.query<BusinessEventRow>(
      `SELECT organization_id, domain, event_id, resource_type, resource_id,
              actor_account_id, event_type, payload, created_at, FALSE AS inserted
       FROM enterprise_business_events
       WHERE organization_id = $1 AND domain = $2
         AND resource_type = $3 AND resource_id = $4
       ORDER BY created_at, event_id
       LIMIT $5`,
      [
        identifier(raw.organizationId, 'organization id'),
        businessDomain(raw.domain),
        identifier(raw.resourceType, 'resource type'),
        identifier(raw.resourceId, 'resource id'),
        limit,
      ],
    );
    return result.rows.map((row) => eventView<T>(row));
  }

  async function findActiveParkInvite<T = Record<string, unknown>>(
    codeSha256: string,
  ): Promise<PostgresBusinessRecord<T> | null> {
    if (!/^[0-9a-f]{64}$/u.test(codeSha256)) {
      throw new Error('park invitation digest is invalid');
    }
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE domain = 'park' AND resource_type = 'invite' AND status = 'active'
         AND payload->>'codeSha256' = $1
         AND (payload->>'expiresAt')::timestamptz > CURRENT_TIMESTAMP
       ORDER BY created_at DESC
       LIMIT 1`,
      [codeSha256],
    );
    return result.rows[0] ? recordView<T>(result.rows[0]) : null;
  }

  async function listParkTenantMemberships<T = Record<string, unknown>>(
    adminOrganizationIdValue: string,
  ): Promise<Array<PostgresBusinessRecord<T>>> {
    const adminOrganizationId = identifier(
      adminOrganizationIdValue,
      'admin organization id',
    );
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE domain = 'park' AND resource_type = 'membership'
         AND status = 'active' AND payload->>'adminOrganizationId' = $1
       ORDER BY updated_at DESC, organization_id`,
      [adminOrganizationId],
    );
    return result.rows.map((row) => recordView<T>(row));
  }

  async function listTicketRecordsForAccount<T = Record<string, unknown>>(raw: {
    organizationId: string;
    accountId: string;
    inbox?: boolean;
    limit?: number;
  }): Promise<Array<PostgresBusinessRecord<T>>> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const accountId = identifier(raw.accountId, 'account id');
    const limit = Math.min(500, Math.max(1, Math.floor(raw.limit ?? 200)));
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE domain = 'ticketing' AND resource_type = 'ticket'
         AND (
           ($3::boolean = FALSE AND owner_account_id = $2)
           OR ($3::boolean = TRUE AND (
             payload->>'targetOrganizationId' = $1
             OR payload->'assigneeAccountIds' ? $2
           ))
           OR payload->'participantAccountIds' ? $2
         )
       ORDER BY updated_at DESC, resource_id
       LIMIT $4`,
      [organizationId, accountId, raw.inbox === true, limit],
    );
    return result.rows.map((row) => recordView<T>(row));
  }

  async function listAddressedBusinessRecords<
    T = Record<string, unknown>,
  >(raw: {
    organizationId: string;
    accountId: string;
    domain: PostgresBusinessDomain;
    resourceType: string;
    limit?: number;
  }): Promise<Array<PostgresBusinessRecord<T>>> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const accountId = identifier(raw.accountId, 'account id');
    const domain = businessDomain(raw.domain);
    const resourceType = identifier(raw.resourceType, 'resource type');
    const limit = Math.min(500, Math.max(1, Math.floor(raw.limit ?? 200)));
    const result = await input.pool.query<BusinessRecordRow>(
      `SELECT organization_id, domain, resource_type, resource_id,
              owner_account_id, status, version, payload, created_at, updated_at
       FROM enterprise_business_records
       WHERE domain = $3 AND resource_type = $4
         AND (
           organization_id = $1
           OR owner_account_id = $2
           OR payload->>'targetOrganizationId' = $1
           OR payload->'recipientAccountIds' ? $2
           OR payload->'assigneeAccountIds' ? $2
         )
       ORDER BY updated_at DESC, resource_id
       LIMIT $5`,
      [organizationId, accountId, domain, resourceType, limit],
    );
    return result.rows.map((row) => recordView<T>(row));
  }

  return {
    listAccountSyncSnapshots,
    putAccountSyncSnapshot,
    listBusinessRecords,
    getBusinessRecord,
    createBusinessRecord,
    updateBusinessRecord,
    appendBusinessEvent,
    listBusinessEvents,
    findActiveParkInvite,
    listParkTenantMemberships,
    listTicketRecordsForAccount,
    listAddressedBusinessRecords,
  };
}

export type PostgresEnterpriseBusinessRepository = ReturnType<
  typeof createPostgresEnterpriseBusinessRepository
>;
