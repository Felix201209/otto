/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export const ACCOUNT_PRESENCE_ONLINE_WINDOW_MS = 60_000;
export const ACCOUNT_PRESENCE_MAX_ONLINE_WINDOW_MS = 5 * 60_000;
export const ACCOUNT_PRESENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_PRESENCE_MAX_CLIENTS_PER_ACCOUNT = 8;
export const ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH = 120;

export interface AccountPresenceView {
  accountId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface AccountPresenceRepositoryStore {
  db(): Database;
  now(): number;
  isActiveAccountInOrganization(
    accountId: string,
    organizationId: string,
  ): boolean;
}

export interface TouchAccountPresenceInput {
  organizationId: string;
  accountId: string;
  clientId?: string | null;
  nowMs?: number;
}

interface AccountPresenceRow {
  account_id: string;
  last_seen_at_ms: number | null;
}

function normalizeObservedNowMs(
  value: number | undefined,
  fallback: number,
): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.max(0, Math.floor(fallback))
    : Date.now();
  if (!Number.isFinite(value)) return safeFallback;
  return Math.max(0, Math.floor(value!));
}

function normalizeHeartbeatNowMs(
  value: number | undefined,
  fallback: number,
): number {
  const observedNowMs = normalizeObservedNowMs(undefined, fallback);
  if (!Number.isFinite(value)) return observedNowMs;
  return Math.min(observedNowMs, Math.max(0, Math.floor(value!)));
}

function normalizeClientId(clientId: string | null | undefined): string {
  return (
    (clientId || 'default')
      .trim()
      .slice(0, ACCOUNT_PRESENCE_MAX_CLIENT_ID_LENGTH) || 'default'
  );
}

function normalizeOnlineWindowMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return ACCOUNT_PRESENCE_ONLINE_WINDOW_MS;
  }
  return Math.min(
    ACCOUNT_PRESENCE_MAX_ONLINE_WINDOW_MS,
    Math.max(1, Math.floor(value)),
  );
}

function trimPresenceClients(
  database: Database,
  organizationId: string,
  accountId: string,
): void {
  const rows = database
    .prepare(
      `SELECT client_id FROM account_presence
       WHERE organization_id = ? AND account_id = ?
       ORDER BY last_seen_at_ms DESC, client_id`,
    )
    .all(organizationId, accountId) as Array<{ client_id: string }>;
  const staleClients = rows.slice(ACCOUNT_PRESENCE_MAX_CLIENTS_PER_ACCOUNT);
  if (staleClients.length === 0) return;
  const remove = database.prepare(
    `DELETE FROM account_presence
     WHERE organization_id = ? AND account_id = ? AND client_id = ?`,
  );
  for (const row of staleClients) {
    remove.run(organizationId, accountId, row.client_id);
  }
}

export function touchAccountPresenceInRepository(
  store: AccountPresenceRepositoryStore,
  input: TouchAccountPresenceInput,
): AccountPresenceView {
  const organizationId = input.organizationId.trim();
  const accountId = input.accountId.trim();
  if (
    !organizationId ||
    !accountId ||
    !store.isActiveAccountInOrganization(accountId, organizationId)
  ) {
    throw new Error('Account not available for presence');
  }

  const nowMs = normalizeHeartbeatNowMs(input.nowMs, store.now());
  const clientId = normalizeClientId(input.clientId);
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `DELETE FROM account_presence
         WHERE organization_id = ? AND account_id = ? AND last_seen_at_ms < ?`,
      )
      .run(
        organizationId,
        accountId,
        Math.max(0, nowMs - ACCOUNT_PRESENCE_RETENTION_MS),
      );
    database
      .prepare(
        `INSERT INTO account_presence
         (organization_id, account_id, client_id, last_seen_at_ms, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(organization_id, account_id, client_id)
         DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms,
                       updated_at = datetime('now')`,
      )
      .run(organizationId, accountId, clientId, nowMs);
    trimPresenceClients(database, organizationId, accountId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return {
    accountId,
    online: true,
    lastSeenAt: new Date(nowMs).toISOString(),
  };
}

export function listAccountPresenceFromRepository(
  store: AccountPresenceRepositoryStore,
  organizationId: string,
  onlineWindowMs = ACCOUNT_PRESENCE_ONLINE_WINDOW_MS,
  nowMs = store.now(),
): AccountPresenceView[] {
  const normalizedOrganizationId = organizationId.trim();
  if (!normalizedOrganizationId) return [];
  const normalizedNowMs = normalizeObservedNowMs(nowMs, store.now());
  const normalizedWindowMs = normalizeOnlineWindowMs(onlineWindowMs);
  const rows = store
    .db()
    .prepare(
      `SELECT account_id,
              MAX(CASE
                    WHEN last_seen_at_ms BETWEEN 0 AND ? THEN last_seen_at_ms
                    ELSE NULL
                  END) AS last_seen_at_ms
       FROM account_presence
       WHERE organization_id = ?
       GROUP BY account_id`,
    )
    .all(normalizedNowMs, normalizedOrganizationId) as AccountPresenceRow[];

  return rows.flatMap<AccountPresenceView>((row) => {
    if (
      !store.isActiveAccountInOrganization(
        row.account_id,
        normalizedOrganizationId,
      )
    ) {
      return [];
    }
    const lastSeenMs =
      row.last_seen_at_ms === null ? Number.NaN : Number(row.last_seen_at_ms);
    if (
      !Number.isFinite(lastSeenMs) ||
      lastSeenMs < 0 ||
      lastSeenMs > normalizedNowMs
    ) {
      return [
        {
          accountId: row.account_id,
          online: false,
          lastSeenAt: null,
        },
      ];
    }
    return [
      {
        accountId: row.account_id,
        online: normalizedNowMs - lastSeenMs <= normalizedWindowMs,
        lastSeenAt: new Date(lastSeenMs).toISOString(),
      },
    ];
  });
}
