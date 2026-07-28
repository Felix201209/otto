/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createAuditLogSchemaContributor } from './auditLogSchema.js';

const contributor = createAuditLogSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createOrganizationPrerequisite(database: Database): void {
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default');
  `);
}

describe('audit log schema contributor', () => {
  it('creates the tenant audit schema and index idempotently', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO audit_logs (event, employee_id, detail)
        VALUES ('login', 'employee-1', 'success');
      `);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, event, employee_id, detail,
                    created_at IS NOT NULL AS has_created_at
             FROM audit_logs`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        event: 'login',
        employee_id: 'employee-1',
        detail: 'success',
        has_created_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_audit_organization'`,
          )
          .get(),
      ).toEqual({ name: 'idx_audit_organization' });
      expect(
        database.prepare('PRAGMA foreign_key_list(audit_logs)').all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'organizations',
            from: 'organization_id',
            to: 'id',
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('migrates a legacy single-tenant audit table without losing records', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      database.exec(`
        CREATE TABLE audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          employee_id TEXT,
          detail TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO audit_logs (event, employee_id, detail)
        VALUES ('legacy-event', 'employee-1', 'legacy-detail');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, event, employee_id, detail
             FROM audit_logs`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        event: 'legacy-event',
        employee_id: 'employee-1',
        detail: 'legacy-detail',
      });
      expect(database.prepare('PRAGMA table_info(audit_logs)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'organization_id',
            notnull: 1,
            dflt_value: "'org-default'",
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('rejects an unsafe default organization id before applying SQL', () => {
    expect(() =>
      createAuditLogSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE audit_logs; --",
      }),
    ).toThrow('Invalid default organization id for audit log schema');
  });
});
