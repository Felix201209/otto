/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { PARK_CORE_SCHEMA_CONTRIBUTOR } from './parkCoreSchema.js';

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-admin'), ('org-tenant');
    INSERT INTO accounts (id) VALUES ('account-specialist');
  `);
}

describe('park core schema contributor', () => {
  it('creates the park core schema idempotently and preserves records', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [PARK_CORE_SCHEMA_CONTRIBUTOR]);
      database.exec(`
        INSERT INTO parks
          (id, name, slug, invite_secret, admin_organization_id, brand_name)
        VALUES
          ('park-a', 'Technology Park', 'technology-park', 'secret',
           'org-admin', 'Technology Park Services');
        INSERT INTO park_invites
          (id, park_id, nonce, issued_at_ms, expires_at_ms,
           created_by_account_id, max_uses, used_count)
        VALUES
          ('invite-a', 'park-a', 'nonce-a', 100, 200,
           'account-specialist', 5, 2);
        INSERT INTO park_services
          (park_id, id, name, enabled, config_json)
        VALUES ('park-a', 'repair', 'Property Repair', 1, '{"priority":true}');
        INSERT INTO park_tenant_profiles
          (organization_id, park_id, address, room_number)
        VALUES ('org-tenant', 'park-a', 'Building A', '5-101');
        INSERT INTO park_service_specialists
          (park_id, service_id, account_id)
        VALUES ('park-a', 'repair', 'account-specialist');
      `);

      applyDatabaseSchemaContributors(database, [PARK_CORE_SCHEMA_CONTRIBUTOR]);

      expect(
        database
          .prepare(
            `SELECT name, admin_organization_id, brand_name, status
             FROM parks WHERE id = 'park-a'`,
          )
          .get(),
      ).toEqual({
        name: 'Technology Park',
        admin_organization_id: 'org-admin',
        brand_name: 'Technology Park Services',
        status: 'active',
      });
      expect(
        database
          .prepare(
            `SELECT max_uses, used_count FROM park_invites
             WHERE id = 'invite-a'`,
          )
          .get(),
      ).toEqual({ max_uses: 5, used_count: 2 });
      expect(
        database
          .prepare(
            `SELECT address, room_number FROM park_tenant_profiles
             WHERE organization_id = 'org-tenant'`,
          )
          .get(),
      ).toEqual({ address: 'Building A', room_number: '5-101' });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_park_invites_active'`,
          )
          .get(),
      ).toEqual({ name: 'idx_park_invites_active' });
    } finally {
      database.close();
    }
  });

  it('enforces park ownership and service state constraints', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [PARK_CORE_SCHEMA_CONTRIBUTOR]);
      database.exec(`
        INSERT INTO parks
          (id, name, slug, invite_secret, admin_organization_id, brand_name)
        VALUES
          ('park-a', 'Technology Park', 'technology-park', 'secret',
           'org-admin', 'Technology Park Services');
      `);

      expect(() =>
        database.exec(`
          INSERT INTO parks
            (id, name, slug, invite_secret, admin_organization_id, brand_name)
          VALUES
            ('park-b', 'Second Park', 'second-park', 'secret-b',
             'org-admin', 'Second Park Services');
        `),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO park_services (park_id, id, name, enabled)
          VALUES ('park-a', 'repair', 'Property Repair', 2);
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO park_tenant_profiles
            (organization_id, park_id, address, room_number)
          VALUES ('missing-org', 'park-a', 'Building B', '1-101');
        `),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      database.close();
    }
  });

  it('cascades park-owned records when a park is removed', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [PARK_CORE_SCHEMA_CONTRIBUTOR]);
      database.exec(`
        INSERT INTO parks
          (id, name, slug, invite_secret, admin_organization_id, brand_name)
        VALUES
          ('park-a', 'Technology Park', 'technology-park', 'secret',
           'org-admin', 'Technology Park Services');
        INSERT INTO park_invites
          (id, park_id, nonce, issued_at_ms, expires_at_ms,
           created_by_account_id)
        VALUES
          ('invite-a', 'park-a', 'nonce-a', 100, 200,
           'account-specialist');
        INSERT INTO park_services (park_id, id, name)
        VALUES ('park-a', 'repair', 'Property Repair');
        INSERT INTO park_tenant_profiles
          (organization_id, park_id, address, room_number)
        VALUES ('org-tenant', 'park-a', 'Building A', '5-101');
        INSERT INTO park_service_specialists
          (park_id, service_id, account_id)
        VALUES ('park-a', 'repair', 'account-specialist');
        DELETE FROM parks WHERE id = 'park-a';
      `);

      for (const table of [
        'park_invites',
        'park_services',
        'park_tenant_profiles',
        'park_service_specialists',
      ]) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
    } finally {
      database.close();
    }
  });
});
