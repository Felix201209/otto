/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  decryptAccountSyncPayload,
  encryptAccountSyncPayload,
  type AccountSyncEncryptionKeyProvider,
} from './accountSyncCrypto.js';
import {
  AccountSyncConflictError,
  type AccountSyncIdentity,
  type AccountSyncScope,
  type AccountSyncSnapshotView,
  type PutAccountSyncSnapshotInput,
} from './accountSyncTypes.js';
import {
  isAccountSyncScope,
  normalizeAccountSyncPayload,
} from './accountSyncValidation.js';

interface AccountSyncSnapshotRow {
  account_id: string;
  organization_id: string;
  scope: AccountSyncScope;
  version: number;
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
  payload_hash: string;
  device_id: string | null;
  updated_at_ms: number;
}

export interface AccountSyncRepositoryStore {
  db(): Database;
  keyProvider: AccountSyncEncryptionKeyProvider;
  resolveActiveIdentity(accountId: string): AccountSyncIdentity | null;
  now?(): number;
}

function requireActiveIdentity(
  store: AccountSyncRepositoryStore,
  accountId: string,
): AccountSyncIdentity {
  const identity = store.resolveActiveIdentity(accountId);
  if (!identity || identity.accountId !== accountId) {
    throw new Error('account not found');
  }
  return identity;
}

function accountSyncSnapshotView(
  store: AccountSyncRepositoryStore,
  row: AccountSyncSnapshotRow,
): AccountSyncSnapshotView {
  if (!isAccountSyncScope(row.scope)) {
    throw new Error('account sync snapshot integrity check failed');
  }
  return {
    scope: row.scope,
    version: row.version,
    payload: decryptAccountSyncPayload(store.keyProvider, row),
    payloadHash: row.payload_hash,
    deviceId: row.device_id,
    updatedAtMs: row.updated_at_ms,
  };
}

export function listAccountSyncSnapshotsFromRepository(
  store: AccountSyncRepositoryStore,
  accountId: string,
): AccountSyncSnapshotView[] {
  const identity = requireActiveIdentity(store, accountId);
  const rows = store
    .db()
    .prepare(
      `SELECT * FROM account_sync_snapshots
       WHERE account_id = ? AND organization_id = ?
       ORDER BY scope`,
    )
    .all(accountId, identity.organizationId) as AccountSyncSnapshotRow[];
  return rows.map((row) => accountSyncSnapshotView(store, row));
}

function latestStoredVersion(
  store: AccountSyncRepositoryStore,
  accountId: string,
  scope: AccountSyncScope,
): { organizationId: string; version: number } | null {
  const row = store
    .db()
    .prepare(
      `SELECT organization_id, version FROM account_sync_snapshots
       WHERE account_id = ? AND scope = ?`,
    )
    .get(accountId, scope) as
    { organization_id: string; version: number } | undefined;
  return row
    ? { organizationId: row.organization_id, version: Number(row.version) }
    : null;
}

export function putAccountSyncSnapshotInRepository(
  store: AccountSyncRepositoryStore,
  input: PutAccountSyncSnapshotInput,
): AccountSyncSnapshotView {
  if (!isAccountSyncScope(input.scope)) {
    throw new Error('account sync scope is invalid');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('account sync expectedVersion is invalid');
  }
  const identity = requireActiveIdentity(store, input.accountId);
  const payload = normalizeAccountSyncPayload(input.scope, input.payload);
  const existing = latestStoredVersion(store, input.accountId, input.scope);
  if (existing && existing.organizationId !== identity.organizationId) {
    throw new Error('account sync snapshot organization mismatch');
  }
  const currentVersion = existing?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    throw new AccountSyncConflictError(currentVersion);
  }

  const version = currentVersion + 1;
  const encrypted = encryptAccountSyncPayload(store.keyProvider, {
    accountId: input.accountId,
    organizationId: identity.organizationId,
    scope: input.scope,
    version,
    payload,
  });
  const updatedAtMs = Math.floor((store.now ?? Date.now)());
  const deviceId =
    typeof input.deviceId === 'string'
      ? input.deviceId.trim().slice(0, 160) || null
      : null;

  if (existing) {
    const result = store
      .db()
      .prepare(
        `UPDATE account_sync_snapshots
         SET version = ?, payload_ciphertext = ?, payload_iv = ?,
             payload_auth_tag = ?, payload_hash = ?, device_id = ?,
             updated_at_ms = ?
         WHERE account_id = ? AND organization_id = ? AND scope = ?
           AND version = ?`,
      )
      .run(
        version,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.payloadHash,
        deviceId,
        updatedAtMs,
        input.accountId,
        identity.organizationId,
        input.scope,
        currentVersion,
      ) as { changes?: number | bigint };
    if (Number(result.changes ?? 0) !== 1) {
      const latest = latestStoredVersion(store, input.accountId, input.scope);
      throw new AccountSyncConflictError(latest?.version ?? currentVersion);
    }
  } else {
    try {
      store
        .db()
        .prepare(
          `INSERT INTO account_sync_snapshots
           (account_id, organization_id, scope, version, payload_ciphertext,
            payload_iv, payload_auth_tag, payload_hash, device_id, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.accountId,
          identity.organizationId,
          input.scope,
          version,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.payloadHash,
          deviceId,
          updatedAtMs,
        );
    } catch (error) {
      const latest = latestStoredVersion(store, input.accountId, input.scope);
      if (latest) throw new AccountSyncConflictError(latest.version);
      throw error;
    }
  }

  return {
    scope: input.scope,
    version,
    payload,
    payloadHash: encrypted.payloadHash,
    deviceId,
    updatedAtMs,
  };
}
