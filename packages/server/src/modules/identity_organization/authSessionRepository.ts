/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../data_platform/index.js';

export const AUTH_SESSION_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthSessionAccountView {
  organizationId: string;
  status: 'active' | 'disabled';
}

export interface AuthSessionAccountRow {
  organization_id: string;
  status: 'active' | 'disabled';
  deleted_at: string | null;
}

export interface AuthSessionRepositoryStore<
  TAccountView extends AuthSessionAccountView,
  TAccountRow extends AuthSessionAccountRow,
> {
  db(): Database;
  now(): number;
  getAccount(accountId: string): TAccountView | null;
  isOrganizationActive(organizationId: string): boolean;
  toAccountView(row: TAccountRow): TAccountView;
}

export interface AuthSessionIssueResult {
  token: string;
  expiresAt: string;
}

interface SessionAccountRow {
  session_expires_at: string;
  session_organization_id: string;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function assertSessionTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Session TTL must be a finite positive number');
  }
}

export function createAuthSessionInRepository<
  TAccountView extends AuthSessionAccountView,
  TAccountRow extends AuthSessionAccountRow,
>(
  store: AuthSessionRepositoryStore<TAccountView, TAccountRow>,
  accountId: string,
  ttlMs = AUTH_SESSION_DEFAULT_TTL_MS,
): AuthSessionIssueResult {
  assertSessionTtl(ttlMs);
  const account = store.getAccount(accountId);
  if (
    !account ||
    account.status !== 'active' ||
    !store.isOrganizationActive(account.organizationId)
  ) {
    throw new Error('Account not found');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAtMs = store.now() + ttlMs;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > 8.64e15) {
    throw new Error('Session TTL must be a finite positive number');
  }
  const expiresAt = new Date(expiresAtMs).toISOString();
  store
    .db()
    .prepare(
      `INSERT INTO auth_sessions (id, organization_id, account_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `session_${randomUUID()}`,
      account.organizationId,
      accountId,
      tokenDigest(token),
      expiresAt,
    );
  return { token, expiresAt };
}

export function getAccountBySessionFromRepository<
  TAccountView extends AuthSessionAccountView,
  TAccountRow extends AuthSessionAccountRow,
>(
  store: AuthSessionRepositoryStore<TAccountView, TAccountRow>,
  token: string,
): TAccountView | null {
  if (!token) return null;
  const digest = tokenDigest(token);
  const row = store
    .db()
    .prepare(
      `SELECT a.*, s.expires_at AS session_expires_at,
              s.organization_id AS session_organization_id
       FROM auth_sessions s
       JOIN accounts a
         ON a.id = s.account_id AND a.organization_id = s.organization_id
       JOIN organizations o ON o.id = s.organization_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL
         AND a.status = 'active' AND a.deleted_at IS NULL AND o.status = 'active'`,
    )
    .get(digest) as (TAccountRow & SessionAccountRow) | undefined;
  if (!row) return null;

  const now = store.now();
  const expiresAtMs = Date.parse(row.session_expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;

  const touched = store
    .db()
    .prepare(
      `UPDATE auth_sessions SET last_used_at = ?
       WHERE token_hash = ? AND organization_id = ? AND revoked_at IS NULL`,
    )
    .run(new Date(now).toISOString(), digest, row.session_organization_id) as {
    changes?: number | bigint;
  };
  if (Number(touched.changes ?? 0) !== 1) return null;
  return store.toAccountView(row);
}

export function revokeAuthSessionInRepository<
  TAccountView extends AuthSessionAccountView,
  TAccountRow extends AuthSessionAccountRow,
>(
  store: AuthSessionRepositoryStore<TAccountView, TAccountRow>,
  token: string,
): void {
  if (!token) return;
  store
    .db()
    .prepare(
      `UPDATE auth_sessions SET revoked_at = ?
       WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .run(new Date(store.now()).toISOString(), tokenDigest(token));
}
