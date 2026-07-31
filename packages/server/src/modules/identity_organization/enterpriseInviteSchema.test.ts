/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createEnterpriseInviteSchemaContributor } from './enterpriseInviteSchema.js';

const contributor = createEnterpriseInviteSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createOrganizations(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default'), ('org-a');
  `);
}

describe('enterprise invite schema contributor', () => {
  it('creates both invite schemas and indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      createOrganizations(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO organization_invites
          (id, organization_id, nonce, issued_at_ms, expires_at_ms,
           max_uses, used_count)
        VALUES ('invite-a', 'org-a', 'nonce-a', 100, 200, 5, 2);
        INSERT INTO invite_codes
          (code, organization_id, department, max_uses, used_count)
        VALUES ('ABC123', 'org-a', 'Engineering', 3, 1);
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, max_uses, used_count
             FROM organization_invites WHERE id = 'invite-a'`,
          )
          .get(),
      ).toEqual({ organization_id: 'org-a', max_uses: 5, used_count: 2 });
      expect(
        database
          .prepare(
            `SELECT organization_id, department, used_count
             FROM invite_codes WHERE code = 'ABC123'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-a',
        department: 'Engineering',
        used_count: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name = 'idx_organization_invites_active'`,
          )
          .get(),
      ).toEqual({ name: 'idx_organization_invites_active' });
    } finally {
      database.close();
    }
  });

  it('upgrades legacy invite tables without losing issued codes', () => {
    const database = new Database(':memory:');
    try {
      createOrganizations(database);
      database.exec(`
        CREATE TABLE organization_invites (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          issued_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          revoked_at_ms INTEGER,
          created_by_account_id TEXT,
          created_at TEXT
        );
        CREATE TABLE invite_codes (
          code TEXT PRIMARY KEY,
          department TEXT NOT NULL,
          max_uses INTEGER DEFAULT 1,
          used_count INTEGER DEFAULT 0,
          created_by TEXT,
          created_at TEXT,
          expires_at TEXT
        );
        INSERT INTO organization_invites
          (id, organization_id, nonce, issued_at_ms, expires_at_ms, created_at)
        VALUES ('legacy-invite', 'org-a', 'legacy-nonce', 100, 200, '2026-01-01');
        INSERT INTO invite_codes
          (code, department, max_uses, used_count, created_by)
        VALUES ('OLD123', 'Legacy Department', 4, 2, 'legacy-admin');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, nonce, max_uses, used_count,
                    default_department, position_id
             FROM organization_invites WHERE id = 'legacy-invite'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-a',
        nonce: 'legacy-nonce',
        max_uses: null,
        used_count: 0,
        default_department: null,
        position_id: null,
      });
      expect(
        database
          .prepare(
            `SELECT organization_id, department, max_uses, used_count, created_by
             FROM invite_codes WHERE code = 'OLD123'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        department: 'Legacy Department',
        max_uses: 4,
        used_count: 2,
        created_by: 'legacy-admin',
      });
    } finally {
      database.close();
    }
  });

  it('rejects unsafe default organization ids', () => {
    expect(() =>
      createEnterpriseInviteSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE invite_codes; --",
      }),
    ).toThrow('Invalid default organization id for enterprise invite schema');
  });
});
