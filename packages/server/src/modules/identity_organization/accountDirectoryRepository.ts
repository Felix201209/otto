/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export interface AccountDirectoryView {
  organizationId: string;
  status: 'active' | 'disabled';
}

export interface AccountDirectoryRow {
  organization_id: string;
  username: string;
  phone: string | null;
  password_hash: string;
  status: 'active' | 'disabled';
  deleted_at: string | null;
}

export interface FeishuAccountBinding {
  organizationId: string;
  accountActive: boolean;
  organizationActive: boolean;
}

export interface AccountDirectoryRepositoryStore<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
> {
  db(): Database;
  defaultOrganizationId: string;
  normalizeIdentifier(identifier: string): string;
  normalizePhone(phone: string): string;
  passwordMatches(password: string, stored: string): boolean;
  isOrganizationActive(organizationId: string): boolean;
  toAccountView(row: TAccountRow): TAccountView;
}

export function getAccountFromRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  id: string,
  organizationId?: string,
): TAccountView | null {
  const row = (
    organizationId
      ? store
          .db()
          .prepare(
            `SELECT * FROM accounts
             WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
          )
          .get(id, organizationId)
      : store
          .db()
          .prepare('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL')
          .get(id)
  ) as TAccountRow | undefined;
  return row ? store.toAccountView(row) : null;
}

export function listAccountsFromRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  organizationId = store.defaultOrganizationId,
): TAccountView[] {
  const rows = store
    .db()
    .prepare(
      `SELECT * FROM accounts
       WHERE organization_id = ? AND deleted_at IS NULL
       ORDER BY name, username`,
    )
    .all(organizationId) as TAccountRow[];
  return rows.map((row) => store.toAccountView(row));
}

export function listFeishuAccountBindingsFromRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  openId: string,
): FeishuAccountBinding[] {
  const normalized = openId.trim();
  if (!normalized) return [];
  const rows = store
    .db()
    .prepare(
      `SELECT DISTINCT organization_id, status, deleted_at FROM accounts
       WHERE feishu_open_id = ?
       ORDER BY organization_id, status, deleted_at`,
    )
    .all(normalized) as Array<{
    organization_id: string;
    status: 'active' | 'disabled';
    deleted_at: string | null;
  }>;
  return rows.map((row) => ({
    organizationId: row.organization_id,
    accountActive: row.status === 'active' && row.deleted_at === null,
    organizationActive: store.isOrganizationActive(row.organization_id),
  }));
}

export function authenticateAccountInRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  identifier: string,
  password: string,
): TAccountView | null {
  const normalized = store.normalizeIdentifier(identifier);
  let row = store
    .db()
    .prepare(
      `SELECT * FROM accounts
       WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL`,
    )
    .get(normalized) as TAccountRow | undefined;
  if (!row) {
    try {
      row = store
        .db()
        .prepare(
          'SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL',
        )
        .get(store.normalizePhone(identifier)) as TAccountRow | undefined;
    } catch {
      // A non-phone identifier should produce the same generic login failure.
    }
  }
  if (
    !row ||
    row.status !== 'active' ||
    !store.isOrganizationActive(row.organization_id) ||
    !store.passwordMatches(password, row.password_hash)
  ) {
    return null;
  }
  return store.toAccountView(row);
}

export function findAccountByPhoneFromRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  phone: string,
): TAccountView | null {
  const row = store
    .db()
    .prepare('SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL')
    .get(store.normalizePhone(phone)) as TAccountRow | undefined;
  return row ? store.toAccountView(row) : null;
}

export function findActiveAccountByPhoneFromRepository<
  TAccountView extends AccountDirectoryView,
  TAccountRow extends AccountDirectoryRow,
>(
  store: AccountDirectoryRepositoryStore<TAccountView, TAccountRow>,
  phone: string,
): TAccountView | null {
  const account = findAccountByPhoneFromRepository(store, phone);
  return account?.status === 'active' &&
    store.isOrganizationActive(account.organizationId)
    ? account
    : null;
}
