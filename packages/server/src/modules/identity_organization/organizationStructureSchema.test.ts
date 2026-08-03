/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR } from './organizationStructureSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
  `);
  return database;
}

function applySchema(database: Database): void {
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
  ]);
}

describe('organization structure schema contributor', () => {
  it('creates both structure tables and indexes idempotently without losing data', () => {
    const database = createDatabase();
    try {
      applySchema(database);
      database.exec(`
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-a', 'org-a', 'Engineering');
        INSERT INTO organization_positions
          (id, organization_id, department_id, title)
        VALUES ('position-a', 'org-a', 'dept-a', 'Developer');
      `);

      applySchema(database);

      expect(
        database
          .prepare(
            `SELECT department_id, title, role_mapping,
                    created_at IS NOT NULL AS has_created_at,
                    updated_at IS NOT NULL AS has_updated_at
             FROM organization_positions WHERE id = ?`,
          )
          .get('position-a'),
      ).toEqual({
        department_id: 'dept-a',
        title: 'Developer',
        role_mapping: 'member',
        has_created_at: 1,
        has_updated_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_organization_departments_org',
               'idx_organization_positions_org'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_organization_departments_org' },
        { name: 'idx_organization_positions_org' },
      ]);
    } finally {
      database.close();
    }
  });

  it('enforces tenant uniqueness and valid position role mappings', () => {
    const database = createDatabase();
    try {
      applySchema(database);
      database.exec(`
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-a', 'org-a', 'Engineering');
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-b', 'org-b', 'Engineering');
        INSERT INTO organization_positions
          (id, organization_id, department_id, title, role_mapping)
        VALUES ('position-a', 'org-a', 'dept-a', 'Lead', 'department_admin');
      `);

      expect(() =>
        database.exec(`
          INSERT INTO organization_departments (id, organization_id, name)
          VALUES ('dept-duplicate', 'org-a', 'engineering');
        `),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO organization_positions
            (id, organization_id, department_id, title)
          VALUES ('position-duplicate', 'org-a', 'dept-a', 'lead');
        `),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO organization_positions
            (id, organization_id, department_id, title, role_mapping)
          VALUES ('position-invalid', 'org-a', 'dept-a', 'Intern', 'owner');
        `),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it('adds parent_department_id to an existing department table', () => {
    const database = createDatabase();
    try {
      database.exec(`
        CREATE TABLE organization_departments (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(organization_id, name)
        );
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-a', 'org-a', 'Engineering');
      `);

      applySchema(database);

      expect(
        database
          .prepare('SELECT parent_department_id FROM organization_departments WHERE id = ?')
          .get('dept-a'),
      ).toEqual({ parent_department_id: null });
    } finally {
      database.close();
    }
  });

  it('restricts deleting a populated department and cascades an organization removal', () => {
    const database = createDatabase();
    try {
      applySchema(database);
      database.exec(`
        INSERT INTO organization_departments (id, organization_id, name)
        VALUES ('dept-a', 'org-a', 'Engineering');
        INSERT INTO organization_positions
          (id, organization_id, department_id, title)
        VALUES ('position-a', 'org-a', 'dept-a', 'Developer');
      `);

      expect(() =>
        database.exec(
          "DELETE FROM organization_departments WHERE id = 'dept-a';",
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);

      database.exec("DELETE FROM organizations WHERE id = 'org-a';");
      expect(
        database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM organization_departments) AS departments,
               (SELECT COUNT(*) FROM organization_positions) AS positions`,
          )
          .get(),
      ).toEqual({ departments: 0, positions: 0 });
    } finally {
      database.close();
    }
  });
});
