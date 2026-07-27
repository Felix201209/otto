/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  AUTH_SESSION_DEFAULT_TTL_MS,
  createAuthSessionFacade,
  type AuthSessionAccountRow,
  type AuthSessionAccountView,
  type AuthSessionRepositoryStore,
} from './modules/identity_organization/index.js';

interface TestAccountView extends AuthSessionAccountView {
  id: string;
  name: string;
}

interface TestAccountRow extends AuthSessionAccountRow {
  id: string;
  name: string;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );
  `);
  return database;
}

function seedOrganization(
  database: Database,
  id: string,
  status: 'active' | 'disabled' = 'active',
): void {
  database
    .prepare('INSERT INTO organizations (id, status) VALUES (?, ?)')
    .run(id, status);
}

function seedAccount(
  database: Database,
  input: {
    id: string;
    organizationId: string;
    status?: 'active' | 'disabled';
    deletedAt?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, name, status, deleted_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.organizationId,
      input.id,
      input.status ?? 'active',
      input.deletedAt ?? null,
    );
}

function createStore(
  database: Database,
  clock: { now: number },
): AuthSessionRepositoryStore<TestAccountView, TestAccountRow> {
  return {
    db: () => database,
    now: () => clock.now,
    getAccount(accountId) {
      const row = database
        .prepare('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL')
        .get(accountId) as TestAccountRow | undefined;
      return row ? this.toAccountView(row) : null;
    },
    isOrganizationActive(organizationId) {
      const row = database
        .prepare(
          "SELECT 1 AS active FROM organizations WHERE id = ? AND status = 'active'",
        )
        .get(organizationId) as { active?: number } | undefined;
      return row?.active === 1;
    },
    toAccountView(row) {
      return {
        id: row.id,
        name: row.name,
        organizationId: row.organization_id,
        status: row.status,
      };
    },
  };
}

describe('identity_organization auth session kernel', () => {
  it('stores only a token digest and resolves an active tenant-bound session', () => {
    const database = createDatabase();
    const clock = { now: Date.parse('2026-07-27T00:00:00.000Z') };
    seedOrganization(database, 'org-a');
    seedAccount(database, { id: 'account-a', organizationId: 'org-a' });
    const sessions = createAuthSessionFacade(createStore(database, clock));

    try {
      const issued = sessions.createAuthSession('account-a');
      expect(issued.expiresAt).toBe(
        new Date(clock.now + AUTH_SESSION_DEFAULT_TTL_MS).toISOString(),
      );
      const stored = database
        .prepare('SELECT token_hash, last_used_at FROM auth_sessions')
        .get() as { token_hash: string; last_used_at: string | null };
      expect(stored.token_hash).not.toBe(issued.token);
      expect(stored.token_hash).toBe(
        createHash('sha256').update(issued.token).digest('hex'),
      );

      expect(sessions.getAccountBySession(issued.token)).toEqual({
        id: 'account-a',
        name: 'account-a',
        organizationId: 'org-a',
        status: 'active',
      });
      const touched = database
        .prepare('SELECT last_used_at FROM auth_sessions')
        .get() as { last_used_at: string | null };
      expect(touched.last_used_at).toBe(new Date(clock.now).toISOString());
    } finally {
      database.close();
    }
  });

  it('rejects invalid TTLs and accounts that cannot hold an active identity', () => {
    const database = createDatabase();
    const clock = { now: Date.parse('2026-07-27T00:00:00.000Z') };
    seedOrganization(database, 'org-active');
    seedOrganization(database, 'org-disabled', 'disabled');
    seedAccount(database, {
      id: 'account-disabled',
      organizationId: 'org-active',
      status: 'disabled',
    });
    seedAccount(database, {
      id: 'account-org-disabled',
      organizationId: 'org-disabled',
    });
    const sessions = createAuthSessionFacade(createStore(database, clock));

    try {
      expect(() => sessions.createAuthSession('account-disabled')).toThrow(
        'Account not found',
      );
      expect(() => sessions.createAuthSession('account-org-disabled')).toThrow(
        'Account not found',
      );
      expect(() => sessions.createAuthSession('missing')).toThrow(
        'Account not found',
      );
      expect(() => sessions.createAuthSession('account-disabled', 0)).toThrow(
        'Session TTL must be a finite positive number',
      );
      expect(() =>
        sessions.createAuthSession(
          'account-disabled',
          Number.POSITIVE_INFINITY,
        ),
      ).toThrow('Session TTL must be a finite positive number');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get(),
      ).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('fails closed for expiration, revocation and identity state changes', () => {
    const database = createDatabase();
    const clock = { now: Date.parse('2026-07-27T00:00:00.000Z') };
    seedOrganization(database, 'org-a');
    seedAccount(database, { id: 'account-a', organizationId: 'org-a' });
    const sessions = createAuthSessionFacade(createStore(database, clock));

    try {
      const expired = sessions.createAuthSession('account-a', 1_000);
      clock.now += 1_001;
      expect(sessions.getAccountBySession(expired.token)).toBeNull();

      const revoked = sessions.createAuthSession('account-a');
      sessions.revokeAuthSession(revoked.token);
      expect(sessions.getAccountBySession(revoked.token)).toBeNull();

      const stoppedOrganization = sessions.createAuthSession('account-a');
      database
        .prepare("UPDATE organizations SET status = 'disabled' WHERE id = ?")
        .run('org-a');
      expect(
        sessions.getAccountBySession(stoppedOrganization.token),
      ).toBeNull();
      database
        .prepare("UPDATE organizations SET status = 'active' WHERE id = ?")
        .run('org-a');

      const disabled = sessions.createAuthSession('account-a');
      database
        .prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?")
        .run('account-a');
      expect(sessions.getAccountBySession(disabled.token)).toBeNull();

      database
        .prepare("UPDATE accounts SET status = 'active' WHERE id = ?")
        .run('account-a');
      const deleted = sessions.createAuthSession('account-a');
      database
        .prepare('UPDATE accounts SET deleted_at = ? WHERE id = ?')
        .run(new Date(clock.now).toISOString(), 'account-a');
      expect(sessions.getAccountBySession(deleted.token)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('rejects a session whose organization was changed away from its account', () => {
    const database = createDatabase();
    const clock = { now: Date.parse('2026-07-27T00:00:00.000Z') };
    seedOrganization(database, 'org-a');
    seedOrganization(database, 'org-b');
    seedAccount(database, { id: 'account-a', organizationId: 'org-a' });
    const sessions = createAuthSessionFacade(createStore(database, clock));

    try {
      const issued = sessions.createAuthSession('account-a');
      database
        .prepare('UPDATE auth_sessions SET organization_id = ?')
        .run('org-b');
      expect(sessions.getAccountBySession(issued.token)).toBeNull();
    } finally {
      database.close();
    }
  });
});
