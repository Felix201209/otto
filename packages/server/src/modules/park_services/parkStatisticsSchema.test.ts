/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { PARK_STATISTICS_SCHEMA_CONTRIBUTOR } from './parkStatisticsSchema.js';

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      FOREIGN KEY (admin_organization_id) REFERENCES organizations(id)
    );
    INSERT INTO organizations (id)
    VALUES ('org-admin'), ('org-tenant'), ('org-other');
    INSERT INTO accounts (id)
    VALUES ('account-admin'), ('account-ceo'), ('account-assignee');
    INSERT INTO parks (id, admin_organization_id)
    VALUES ('park-a', 'org-admin');
  `);
}

function insertTaskAndAssignment(database: Database): void {
  database.exec(`
    INSERT INTO park_data_statistics_tasks (
      id, park_id, admin_organization_id, created_by_account_id, title,
      description, deadline, fields_json, template_name, template_data
    ) VALUES (
      'task-a', 'park-a', 'org-admin', 'account-admin', 'Monthly report',
      'Submit operations data', '2026-08-31', '["Revenue"]',
      'template.xlsx', 'base64-template'
    );
    INSERT INTO park_data_statistics_assignments (
      id, task_id, park_id, organization_id, ceo_account_id,
      assignee_account_id, status, response_data, return_reason, read_at,
      submitted_at, reviewed_at, last_reminded_at
    ) VALUES (
      'assignment-a', 'task-a', 'park-a', 'org-tenant', 'account-ceo',
      'account-assignee', 'returned', '{"Revenue":"100"}', 'Check total',
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'
    );
  `);
}

describe('park statistics schema contributor', () => {
  it('is idempotent and preserves templates, responses, and review history', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
      ]);
      insertTaskAndAssignment(database);

      applyDatabaseSchemaContributors(database, [
        PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
      ]);

      expect(
        database
          .prepare(
            `SELECT t.fields_json, t.template_name, t.template_data,
                    a.status, a.response_data, a.return_reason, a.read_at,
                    a.submitted_at, a.reviewed_at, a.last_reminded_at
             FROM park_data_statistics_tasks t
             JOIN park_data_statistics_assignments a ON a.task_id = t.id
             WHERE t.id = 'task-a'`,
          )
          .get(),
      ).toEqual({
        fields_json: '["Revenue"]',
        template_name: 'template.xlsx',
        template_data: 'base64-template',
        status: 'returned',
        response_data: '{"Revenue":"100"}',
        return_reason: 'Check total',
        read_at: '2026-08-01',
        submitted_at: '2026-08-02',
        reviewed_at: '2026-08-03',
        last_reminded_at: '2026-08-04',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_park_statistics_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_park_statistics_assignments_account' },
        { name: 'idx_park_statistics_assignments_org' },
        { name: 'idx_park_statistics_tasks_park' },
      ]);
    } finally {
      database.close();
    }
  });

  it('enforces task and assignment status constraints', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
      ]);
      expect(() =>
        database.exec(`
          INSERT INTO park_data_statistics_tasks (
            id, park_id, admin_organization_id, created_by_account_id, title,
            description, deadline, status
          ) VALUES (
            'invalid-task', 'park-a', 'org-admin', 'account-admin', 'Invalid',
            'Invalid', '2026-08-31', 'draft'
          );
        `),
      ).toThrow(/CHECK constraint failed/);

      database.exec(`
        INSERT INTO park_data_statistics_tasks (
          id, park_id, admin_organization_id, created_by_account_id, title,
          description, deadline
        ) VALUES (
          'task-a', 'park-a', 'org-admin', 'account-admin', 'Valid', 'Valid',
          '2026-08-31'
        );
      `);
      expect(() =>
        database.exec(`
          INSERT INTO park_data_statistics_assignments (
            id, task_id, park_id, organization_id, ceo_account_id, status
          ) VALUES (
            'invalid-assignment', 'task-a', 'park-a', 'org-tenant',
            'account-ceo', 'accepted'
          );
        `),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it('enforces one assignment per task and organization', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
      ]);
      insertTaskAndAssignment(database);

      expect(() =>
        database.exec(`
          INSERT INTO park_data_statistics_assignments (
            id, task_id, park_id, organization_id, ceo_account_id
          ) VALUES (
            'assignment-b', 'task-a', 'park-a', 'org-tenant', 'account-ceo'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it('deletes assignments when their task is deleted', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_STATISTICS_SCHEMA_CONTRIBUTOR,
      ]);
      insertTaskAndAssignment(database);

      database.exec(
        "DELETE FROM park_data_statistics_tasks WHERE id = 'task-a'",
      );
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM park_data_statistics_assignments',
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
