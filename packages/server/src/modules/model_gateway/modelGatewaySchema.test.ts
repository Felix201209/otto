/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { MODEL_GATEWAY_SCHEMA_CONTRIBUTOR } from './modelGatewaySchema.js';

function createIdentityPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );
  `);
}

describe('model gateway schema contributor', () => {
  it('creates the usage table and time indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
      ]);
      applyDatabaseSchemaContributors(database, [
        MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
      ]);

      expect(
        database
          .prepare(
            `SELECT type, name FROM sqlite_master
             WHERE name IN (
               'account_token_usage',
               'idx_account_token_usage_org_created',
               'idx_account_token_usage_account_created'
             )
             ORDER BY type, name`,
          )
          .all(),
      ).toEqual([
        { type: 'index', name: 'idx_account_token_usage_account_created' },
        { type: 'index', name: 'idx_account_token_usage_org_created' },
        { type: 'table', name: 'account_token_usage' },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves message idempotency and account deletion cascades', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        MODEL_GATEWAY_SCHEMA_CONTRIBUTOR,
      ]);
      database.exec(`
        INSERT INTO organizations (id) VALUES ('org');
        INSERT INTO accounts (id, organization_id) VALUES ('account', 'org');
        INSERT INTO account_token_usage
          (id, organization_id, account_id, session_id, message_id, total_tokens)
        VALUES ('usage-1', 'org', 'account', 'session', 'message', 10);
      `);

      expect(() =>
        database
          .prepare(
            `INSERT INTO account_token_usage
               (id, organization_id, account_id, session_id, message_id, total_tokens)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('usage-2', 'org', 'account', 'session', 'message', 20),
      ).toThrow(/UNIQUE constraint failed/i);

      database.prepare('DELETE FROM accounts WHERE id = ?').run('account');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM account_token_usage').get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
