/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { backfillLegacyOrganizationStructure } from './organizationStructureMigration.js';
import { IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR } from './organizationStructureSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      deleted_at TEXT,
      department TEXT,
      department_id TEXT,
      position_title TEXT,
      position_id TEXT
    );
    CREATE TABLE employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department TEXT,
      department_id TEXT,
      position_title TEXT,
      position_id TEXT
    );
  `);
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
  ]);
  return database;
}

describe('organization structure legacy migration', () => {
  it('preserves explicit identities, fills missing ids and remains idempotent', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO employees
          (id, organization_id, department, department_id,
           position_title, position_id)
        VALUES
          ('employee-a', 'org-a', 'Engineering', 'dept-legacy',
           'Lead', 'position-legacy');
        INSERT INTO accounts
          (id, organization_id, department, position_title)
        VALUES
          ('account-a', 'org-a', ' Engineering ', 'Developer');
      `);

      backfillLegacyOrganizationStructure(database);
      backfillLegacyOrganizationStructure(database);

      expect(
        database
          .prepare(
            `SELECT id, organization_id, name
             FROM organization_departments ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: 'dept-legacy', organization_id: 'org-a', name: 'Engineering' },
      ]);
      expect(
        database
          .prepare(
            `SELECT id, department_id, title, role_mapping
             FROM organization_positions ORDER BY title`,
          )
          .all(),
      ).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^pos_[a-f0-9]{20}$/),
          department_id: 'dept-legacy',
          title: 'Developer',
          role_mapping: 'member',
        }),
        {
          id: 'position-legacy',
          department_id: 'dept-legacy',
          title: 'Lead',
          role_mapping: 'member',
        },
      ]);
      expect(
        database
          .prepare(
            `SELECT department_id, position_id FROM accounts
             WHERE id = 'account-a'`,
          )
          .get(),
      ).toEqual({
        department_id: 'dept-legacy',
        position_id: expect.stringMatching(/^pos_[a-f0-9]{20}$/),
      });
    } finally {
      database.close();
    }
  });

  it('rejects a cross-tenant position id and rolls back all prior writes', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-b', 'org-b', 'Operations');
        INSERT INTO organization_positions
          (id, organization_id, department_id, title)
        VALUES ('position-shared', 'org-b', 'dept-b', 'Manager');
        INSERT INTO accounts
          (id, organization_id, department, position_title, position_id)
        VALUES
          ('account-a', 'org-a', 'Engineering', 'Developer', 'position-shared');
      `);

      expect(() => backfillLegacyOrganizationStructure(database)).toThrow(
        'Position id belongs to another directory identity',
      );

      expect(
        database
          .prepare(
            `SELECT department_id, position_id FROM accounts
             WHERE id = 'account-a'`,
          )
          .get(),
      ).toEqual({ department_id: null, position_id: 'position-shared' });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM organization_departments
             WHERE organization_id = 'org-a'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rejects a same-tenant id with a conflicting name without relinking data', () => {
    const database = createDatabase();
    try {
      database.exec(`
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-a', 'org-a', 'Engineering');
        INSERT INTO employees
          (id, organization_id, department, department_id)
        VALUES ('employee-a', 'org-a', 'Finance', 'dept-a');
      `);

      expect(() => backfillLegacyOrganizationStructure(database)).toThrow(
        'Department id belongs to another directory identity',
      );
      expect(
        database
          .prepare(
            `SELECT id, name FROM organization_departments
             WHERE organization_id = 'org-a'`,
          )
          .all(),
      ).toEqual([{ id: 'dept-a', name: 'Engineering' }]);
    } finally {
      database.close();
    }
  });
});
