/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import {
  createAccountAuthSchemaContributor,
  migrateLegacyAuthSessions,
} from './accountAuthSchema.js';

const contributor = createAccountAuthSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE employees (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default');
  `);
}

describe('account auth schema contributor', () => {
  it('creates the account and authentication schema idempotently', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO accounts
          (id, username, password_hash, name, phone)
        VALUES ('account-a', 'alice', 'hash', 'Alice', '13800000000');
        INSERT INTO account_tags (account_id, tag)
        VALUES ('account-a', 'IT');
        INSERT INTO auth_sessions
          (id, account_id, token_hash, expires_at)
        VALUES ('session-a', 'account-a', 'token-hash', '2099-01-01');
        INSERT INTO sms_login_challenges
          (id, account_id, code_hash, expires_at_ms, created_at_ms)
        VALUES ('sms-a', 'account-a', 'code-hash', 200, 100);
        INSERT INTO sms_registration_challenges
          (id, phone, code_hash, expires_at_ms, created_at_ms)
        VALUES ('smsreg-a', '13900000000', 'code-hash', 200, 100);
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, account_type, username, phone
             FROM accounts WHERE id = 'account-a'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        account_type: 'enterprise',
        username: 'alice',
        phone: '13800000000',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_accounts_phone_unique',
               'idx_accounts_organization',
               'idx_sessions_token',
               'idx_sms_registration_phone_created'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_accounts_organization' },
        { name: 'idx_accounts_phone_unique' },
        { name: 'idx_sessions_token' },
        { name: 'idx_sms_registration_phone_created' },
      ]);
    } finally {
      database.close();
    }
  });

  it('upgrades an existing account schema without losing account data', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organizations (id TEXT PRIMARY KEY);
        CREATE TABLE employees (id TEXT PRIMARY KEY);
        INSERT INTO organizations (id) VALUES ('org-default');
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
        INSERT INTO accounts (id, username, password_hash, name)
        VALUES ('legacy-account', 'legacy', 'legacy-hash', 'Legacy User');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT id, username, organization_id, account_type
             FROM accounts WHERE id = 'legacy-account'`,
          )
          .get(),
      ).toEqual({
        id: 'legacy-account',
        username: 'legacy',
        organization_id: 'org-default',
        account_type: 'enterprise',
      });
      const columns = database
        .prepare('PRAGMA table_info(accounts)')
        .all() as Array<{
        name: string;
      }>;
      expect(columns.filter((column) => column.name === 'phone')).toHaveLength(
        1,
      );
      expect(
        columns.filter((column) => column.name === 'organization_id'),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('migrates legacy plaintext sessions and preserves the organization', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE auth_sessions (
          token TEXT PRIMARY KEY,
          organization_id TEXT,
          account_id TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT
        );
        INSERT INTO auth_sessions
          (token, organization_id, account_id, expires_at, created_at)
        VALUES
          ('legacy-token', 'org-legacy', 'account-a', '2099-01-01', '2026-01-01');
      `);

      migrateLegacyAuthSessions(database, 'org-default');
      migrateLegacyAuthSessions(database, 'org-default');

      expect(
        database
          .prepare(
            `SELECT organization_id, account_id, token_hash, expires_at
             FROM auth_sessions`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-legacy',
        account_id: 'account-a',
        token_hash: createHash('sha256').update('legacy-token').digest('hex'),
        expires_at: '2099-01-01',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'auth_sessions_legacy_v195'`,
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('rejects unsafe default organization ids', () => {
    const unsafe = "org'; DROP TABLE accounts; --";
    expect(() =>
      createAccountAuthSchemaContributor({ defaultOrganizationId: unsafe }),
    ).toThrow('Invalid default organization id for account auth schema');
    const database = new Database(':memory:');
    try {
      expect(() => migrateLegacyAuthSessions(database, unsafe)).toThrow(
        'Invalid default organization id for account auth schema',
      );
    } finally {
      database.close();
    }
  });
});
