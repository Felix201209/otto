/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR } from './personalIntelligenceSchema.js';

function createIdentityPrerequisites(database: Database): void {
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-1');
    INSERT INTO accounts (id) VALUES ('account-1');
  `);
  database.pragma('foreign_keys = ON');
}

function insertSnapshot(database: Database, scope = 'personal_memory'): void {
  database
    .prepare(
      `INSERT INTO account_sync_snapshots
       (account_id, organization_id, scope, version, payload_ciphertext,
        payload_iv, payload_auth_tag, payload_hash, device_id, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'account-1',
      'org-1',
      scope,
      1,
      'ciphertext',
      'iv',
      'auth-tag',
      'hash',
      'device-1',
      100,
    );
}

describe('personal intelligence schema contributor', () => {
  it('creates the account sync schema and index idempotently', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
      ]);
      applyDatabaseSchemaContributors(database, [
        PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertSnapshot(database);

      expect(
        database
          .prepare(
            `SELECT account_id, organization_id, scope, version, device_id,
                    updated_at_ms
             FROM account_sync_snapshots`,
          )
          .get(),
      ).toEqual({
        account_id: 'account-1',
        organization_id: 'org-1',
        scope: 'personal_memory',
        version: 1,
        device_id: 'device-1',
        updated_at_ms: 100,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_account_sync_snapshots_org_updated'`,
          )
          .get(),
      ).toEqual({ name: 'idx_account_sync_snapshots_org_updated' });
    } finally {
      database.close();
    }
  });

  it('enforces sync scopes, account-scope uniqueness, and account cascade deletion', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertSnapshot(database, 'worklog');

      expect(() => insertSnapshot(database, 'worklog')).toThrow(
        /UNIQUE constraint failed/i,
      );
      expect(() => insertSnapshot(database, 'unsupported')).toThrow(
        /CHECK constraint failed/i,
      );

      database.prepare('DELETE FROM accounts WHERE id = ?').run('account-1');
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM account_sync_snapshots')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('preserves rows when adopting an existing account sync table', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      database.exec(`
        CREATE TABLE account_sync_snapshots (
          account_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK(scope IN ('personal_memory', 'worklog', 'auto_skills')),
          version INTEGER NOT NULL,
          payload_ciphertext TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_auth_tag TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          device_id TEXT,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (account_id, scope),
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
        );
      `);
      insertSnapshot(database, 'auto_skills');

      applyDatabaseSchemaContributors(database, [
        PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR,
      ]);

      expect(
        database
          .prepare(
            `SELECT scope, version, payload_ciphertext
             FROM account_sync_snapshots WHERE account_id = ?`,
          )
          .get('account-1'),
      ).toEqual({
        scope: 'auto_skills',
        version: 1,
        payload_ciphertext: 'ciphertext',
      });
    } finally {
      database.close();
    }
  });
});
