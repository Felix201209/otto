/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import {
  buildCreditsTablesSql,
  createCreditsSchemaContributor,
} from './creditsSchema.js';

const contributor = createCreditsSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createPrerequisites(database: Database, withBalance = false): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active',
      ${withBalance ? 'credit_balance INTEGER NOT NULL DEFAULT 0,' : ''}
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL
    );
  `);
}

describe('credits schema contributor', () => {
  it('creates the balance, ledger and redemption schema idempotently', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO organizations (id) VALUES ('org-default');
        INSERT INTO accounts (id, organization_id)
        VALUES ('account-a', 'org-default');
        INSERT INTO redeem_codes
          (id, code, credit_amount, created_by)
        VALUES ('redeem-a', 'ABCD-EFGH-JKLM', 100, 'account-a');
        INSERT INTO credit_transactions
          (id, account_id, type, amount, balance_after, redeem_code_id)
        VALUES ('transaction-a', 'account-a', 'redeem', 100, 100, 'redeem-a');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT id, credit_balance FROM organizations
             WHERE id = 'org-default'`,
          )
          .get(),
      ).toEqual({ id: 'org-default', credit_balance: 0 });
      expect(
        database
          .prepare(
            `SELECT organization_id, type, amount, balance_after
             FROM credit_transactions WHERE id = 'transaction-a'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        type: 'redeem',
        amount: 100,
        balance_after: 100,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_credit_trans_org', 'idx_redeem_codes_code'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_credit_trans_org' },
        { name: 'idx_redeem_codes_code' },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves an existing balance and rejects invalid ledger state', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database, true);
      database.exec(`
        INSERT INTO organizations (id, credit_balance)
        VALUES ('org-default', 42);
        INSERT INTO accounts (id, organization_id)
        VALUES ('account-a', 'org-default');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT credit_balance FROM organizations
             WHERE id = 'org-default'`,
          )
          .get(),
      ).toEqual({ credit_balance: 42 });
      expect(
        (
          database.prepare('PRAGMA table_info(organizations)').all() as Array<{
            name: string;
          }>
        ).filter((column) => column.name === 'credit_balance'),
      ).toHaveLength(1);
      expect(() =>
        database.exec(`
          INSERT INTO redeem_codes
            (id, code, credit_amount, created_by, status)
          VALUES ('invalid', 'INVALID-CODE', 10, 'account-a', 'expired');
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO credit_transactions
            (id, type, amount, balance_after)
          VALUES ('invalid', 'grant', 10, 10);
        `),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it('rejects unsafe default organization ids before building SQL', () => {
    const unsafe = "org'; DROP TABLE organizations; --";
    expect(() => buildCreditsTablesSql(unsafe)).toThrow(
      'Invalid default organization id for credits schema',
    );
    expect(() =>
      createCreditsSchemaContributor({ defaultOrganizationId: unsafe }),
    ).toThrow('Invalid default organization id for credits schema');
  });
});
