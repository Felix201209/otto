/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createMemberSchemaContributor } from './memberSchema.js';

const contributor = createMemberSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createOrganizationPrerequisite(database: Database): void {
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default');
  `);
}

describe('member schema contributor', () => {
  it('creates the current member schema and index idempotently', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO employees (id, name, role, department)
        VALUES ('employee-1', 'Alice', 'engineer', 'R&D');
      `);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, name, role, department, department_id,
                    position_id, position_title, status,
                    onboarded_at IS NOT NULL AS has_onboarded_at
             FROM employees WHERE id = ?`,
          )
          .get('employee-1'),
      ).toEqual({
        organization_id: 'org-default',
        name: 'Alice',
        role: 'engineer',
        department: 'R&D',
        department_id: null,
        position_id: null,
        position_title: null,
        status: 'active',
        has_onboarded_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_employees_organization'`,
          )
          .get(),
      ).toEqual({ name: 'idx_employees_organization' });
      expect(
        database.prepare('PRAGMA foreign_key_list(employees)').all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: 'organizations',
            from: 'organization_id',
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('migrates legacy members without losing lifecycle and profile data', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      database.exec(`
        CREATE TABLE employees (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT,
          department TEXT,
          invite_code TEXT,
          status TEXT DEFAULT 'active',
          personality TEXT,
          onboarded_at TEXT DEFAULT (datetime('now')),
          offboarded_at TEXT
        );
        INSERT INTO employees
          (id, name, role, department, invite_code, status, personality,
           onboarded_at, offboarded_at)
        VALUES
          ('employee-1', 'Legacy User', 'manager', 'Operations', 'invite-1',
           'offboarded', 'careful', '2025-01-01', '2026-01-01');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, name, role, department, invite_code,
                    status, personality, onboarded_at, offboarded_at,
                    department_id, position_id, position_title
             FROM employees WHERE id = ?`,
          )
          .get('employee-1'),
      ).toEqual({
        organization_id: 'org-default',
        name: 'Legacy User',
        role: 'manager',
        department: 'Operations',
        invite_code: 'invite-1',
        status: 'offboarded',
        personality: 'careful',
        onboarded_at: '2025-01-01',
        offboarded_at: '2026-01-01',
        department_id: null,
        position_id: null,
        position_title: null,
      });
      expect(database.prepare('PRAGMA table_info(employees)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'organization_id', notnull: 1 }),
          expect.objectContaining({ name: 'department_id' }),
          expect.objectContaining({ name: 'position_id' }),
          expect.objectContaining({ name: 'position_title' }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('rejects an unsafe default organization id before applying SQL', () => {
    expect(() =>
      createMemberSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE employees; --",
      }),
    ).toThrow('Invalid default organization id for member schema');
  });
});
