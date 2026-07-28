/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createWorklogSchemaContributor } from './worklogSchema.js';

const contributor = createWorklogSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createIdentityPrerequisites(database: Database): void {
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE employees (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default');
    INSERT INTO employees (id) VALUES ('employee-1');
  `);
}

describe('worklog schema contributor', () => {
  it('creates the current worklog schema and indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO task_logs (employee_id, task_type)
        VALUES ('employee-1', 'document_summary');
      `);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, employee_id, task_type, tokens_used,
                    cost_cny, created_at IS NOT NULL AS has_created_at
             FROM task_logs`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        employee_id: 'employee-1',
        task_type: 'document_summary',
        tokens_used: 0,
        cost_cny: 0,
        has_created_at: 1,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_tasks_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_tasks_emp' },
        { name: 'idx_tasks_organization' },
        { name: 'idx_tasks_type' },
      ]);
      expect(
        database.prepare('PRAGMA foreign_key_list(task_logs)').all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'employees', from: 'employee_id' }),
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

  it('migrates legacy single-tenant worklogs without losing metrics', () => {
    const database = new Database(':memory:');
    try {
      createIdentityPrerequisites(database);
      database.exec(`
        CREATE TABLE task_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id TEXT NOT NULL,
          task_type TEXT NOT NULL,
          context TEXT,
          result TEXT,
          duration_min REAL,
          tokens_used INTEGER DEFAULT 0,
          cost_cny REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO task_logs
          (employee_id, task_type, context, result, duration_min, tokens_used, cost_cny)
        VALUES
          ('employee-1', 'legacy-task', 'context', 'result', 25.5, 800, 1.25);
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, employee_id, task_type, context, result,
                    duration_min, tokens_used, cost_cny
             FROM task_logs`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        employee_id: 'employee-1',
        task_type: 'legacy-task',
        context: 'context',
        result: 'result',
        duration_min: 25.5,
        tokens_used: 800,
        cost_cny: 1.25,
      });
      expect(database.prepare('PRAGMA table_info(task_logs)').all()).toEqual(
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
      createWorklogSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE task_logs; --",
      }),
    ).toThrow('Invalid default organization id for worklog schema');
  });
});
