/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR } from './organizationSchema.js';

function applySchema(database: Database): void {
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
  ]);
}

describe('organization root schema contributor', () => {
  it('creates the current root schema and indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON;');
      applySchema(database);
      database.exec(`
        INSERT INTO organizations (id, name, slug, invite_secret)
        VALUES ('org-a', 'Acme', 'acme', 'secret-a');
        INSERT INTO organization_features
          (organization_id, feature_key, enabled)
        VALUES ('org-a', 'knowledge', 1);
      `);

      applySchema(database);

      expect(
        database
          .prepare(
            `SELECT name, slug, park_id, status,
                    created_at IS NOT NULL AS has_created_at,
                    updated_at IS NOT NULL AS has_updated_at
             FROM organizations WHERE id = 'org-a'`,
          )
          .get(),
      ).toEqual({
        name: 'Acme',
        slug: 'acme',
        park_id: null,
        status: 'active',
        has_created_at: 1,
        has_updated_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_organizations_status', 'idx_organizations_park'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_organizations_park' },
        { name: 'idx_organizations_status' },
      ]);
    } finally {
      database.close();
    }
  });

  it('adds park ownership to a legacy root without changing commercial data', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
          invite_secret TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'disabled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          credit_balance INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO organizations
          (id, name, slug, invite_secret, credit_balance)
        VALUES ('org-legacy', 'Legacy', 'legacy', 'secret', 42);
      `);

      applySchema(database);
      applySchema(database);

      expect(
        database
          .prepare(
            `SELECT name, park_id, credit_balance FROM organizations
             WHERE id = 'org-legacy'`,
          )
          .get(),
      ).toEqual({ name: 'Legacy', park_id: null, credit_balance: 42 });
      expect(
        (
          database.prepare('PRAGMA table_info(organizations)').all() as Array<{
            name: string;
          }>
        ).filter((column) => column.name === 'park_id'),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('enforces identity constraints and cascades feature configuration', () => {
    const database = new Database(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON;');
      applySchema(database);
      database.exec(`
        INSERT INTO organizations (id, name, slug, invite_secret)
        VALUES ('org-a', 'Acme', 'acme', 'secret-a');
        INSERT INTO organization_features
          (organization_id, feature_key, enabled)
        VALUES ('org-a', 'knowledge', 1);
      `);

      expect(() =>
        database.exec(`
          INSERT INTO organizations (id, name, slug, invite_secret)
          VALUES ('org-b', 'Duplicate', 'ACME', 'secret-b');
        `),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO organizations
            (id, name, slug, invite_secret, status)
          VALUES ('org-invalid', 'Invalid', 'invalid', 'secret', 'pending');
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO organization_features
            (organization_id, feature_key, enabled)
          VALUES ('org-a', 'park_service', 2);
        `),
      ).toThrow(/CHECK constraint failed/);

      database.exec("DELETE FROM organizations WHERE id = 'org-a';");
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM organization_features')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
