/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createAccountDirectoryFacade,
  type AccountDirectoryRow,
  type AccountDirectoryView,
  type AccountDirectoryRepositoryStore,
} from './modules/identity_organization/index.js';

interface TestAccountView extends AccountDirectoryView {
  id: string;
  name: string;
  phone: string | null;
}

interface TestAccountRow extends AccountDirectoryRow {
  id: string;
  name: string;
  phone: string | null;
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
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
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
    username?: string;
    phone?: string | null;
    password?: string;
    status?: 'active' | 'disabled';
    deletedAt?: string | null;
  },
): void {
  database
    .prepare(
      `INSERT INTO accounts
      (id, organization_id, username, phone, password_hash, name, status, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.organizationId,
      input.username ?? input.id,
      input.phone ?? null,
      input.password ?? 'correct-password',
      input.id,
      input.status ?? 'active',
      input.deletedAt ?? null,
    );
}

function normalizeTestPhone(phone: string): string {
  const digits = phone
    .trim()
    .replace(/\D/g, '')
    .replace(/^86(?=1\d{10}$)/, '');
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('invalid phone');
  return `+86${digits}`;
}

function createStore(
  database: Database,
): AccountDirectoryRepositoryStore<TestAccountView, TestAccountRow> {
  return {
    db: () => database,
    defaultOrganizationId: 'org-a',
    normalizeIdentifier: (identifier) =>
      identifier.trim().toLocaleLowerCase('en-US'),
    normalizePhone: normalizeTestPhone,
    passwordMatches: (password, stored) => password === stored,
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
        phone: row.phone,
        organizationId: row.organization_id,
        status: row.status,
      };
    },
  };
}

describe('identity_organization account directory kernel', () => {
  it('isolates organization lists and explicit account reads', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-a');
    seedOrganization(database, 'org-b');
    seedAccount(database, { id: 'account-a', organizationId: 'org-a' });
    seedAccount(database, { id: 'account-b', organizationId: 'org-b' });
    seedAccount(database, {
      id: 'account-deleted',
      organizationId: 'org-a',
      deletedAt: '2026-07-27T00:00:00.000Z',
    });
    const accounts = createAccountDirectoryFacade(createStore(database));

    try {
      expect(accounts.listAccounts().map((account) => account.id)).toEqual([
        'account-a',
      ]);
      expect(
        accounts.listAccounts('org-b').map((account) => account.id),
      ).toEqual(['account-b']);
      expect(accounts.getAccount('account-a', 'org-a')).toMatchObject({
        organizationId: 'org-a',
      });
      expect(accounts.getAccount('account-a', 'org-b')).toBeNull();
      expect(accounts.getAccount('account-b')).toMatchObject({
        organizationId: 'org-b',
      });
      expect(accounts.getAccount('account-deleted')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('authenticates username and phone only for an active account and organization', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-active');
    seedOrganization(database, 'org-disabled', 'disabled');
    seedAccount(database, {
      id: 'account-active',
      organizationId: 'org-active',
      username: 'alice',
      phone: '+8613800138000',
    });
    seedAccount(database, {
      id: 'account-disabled',
      organizationId: 'org-active',
      username: 'disabled',
      phone: '+8613900139000',
      status: 'disabled',
    });
    seedAccount(database, {
      id: 'account-org-disabled',
      organizationId: 'org-disabled',
      username: 'org-disabled',
      phone: '+8613700137000',
    });
    seedAccount(database, {
      id: 'account-deleted',
      organizationId: 'org-active',
      username: 'deleted',
      phone: '+8613600136000',
      deletedAt: '2026-07-27T00:00:00.000Z',
    });
    const accounts = createAccountDirectoryFacade(createStore(database));

    try {
      expect(
        accounts.authenticateAccount(' Alice ', 'correct-password'),
      ).toMatchObject({ id: 'account-active' });
      expect(
        accounts.authenticateAccount('13800138000', 'correct-password'),
      ).toMatchObject({ id: 'account-active' });
      expect(
        accounts.authenticateAccount('alice', 'wrong-password'),
      ).toBeNull();
      expect(
        accounts.authenticateAccount('disabled', 'correct-password'),
      ).toBeNull();
      expect(
        accounts.authenticateAccount('org-disabled', 'correct-password'),
      ).toBeNull();
      expect(
        accounts.authenticateAccount('deleted', 'correct-password'),
      ).toBeNull();
      expect(
        accounts.authenticateAccount('not-a-phone', 'correct-password'),
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  it('keeps global phone conflict lookup separate from active login lookup', () => {
    const database = createDatabase();
    seedOrganization(database, 'org-active');
    seedOrganization(database, 'org-disabled', 'disabled');
    seedAccount(database, {
      id: 'account-active',
      organizationId: 'org-active',
      phone: '+8613800138000',
    });
    seedAccount(database, {
      id: 'account-disabled',
      organizationId: 'org-active',
      phone: '+8613900139000',
      status: 'disabled',
    });
    seedAccount(database, {
      id: 'account-org-disabled',
      organizationId: 'org-disabled',
      phone: '+8613700137000',
    });
    const accounts = createAccountDirectoryFacade(createStore(database));

    try {
      expect(accounts.findAccountByPhone('13900139000')).toMatchObject({
        id: 'account-disabled',
      });
      expect(accounts.findAccountByPhone('13700137000')).toMatchObject({
        id: 'account-org-disabled',
      });
      expect(accounts.findActiveAccountByPhone('13800138000')).toMatchObject({
        id: 'account-active',
      });
      expect(accounts.findActiveAccountByPhone('13900139000')).toBeNull();
      expect(accounts.findActiveAccountByPhone('13700137000')).toBeNull();
    } finally {
      database.close();
    }
  });
});
