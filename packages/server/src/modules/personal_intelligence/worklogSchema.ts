/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function createWorklogSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for worklog schema');
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'personal_intelligence_worklog',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS task_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          employee_id TEXT NOT NULL,
          task_type TEXT NOT NULL,
          context TEXT,
          result TEXT,
          duration_min REAL,
          tokens_used INTEGER DEFAULT 0,
          cost_cny REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (employee_id) REFERENCES employees(id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      const columns = database
        .prepare('PRAGMA table_info(task_logs)')
        .all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'organization_id')) {
        database.exec(
          `ALTER TABLE task_logs ADD COLUMN organization_id TEXT NOT NULL ` +
            `DEFAULT '${defaultOrganizationId}'`,
        );
      }

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_emp ON task_logs(employee_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_type ON task_logs(task_type);
        CREATE INDEX IF NOT EXISTS idx_tasks_organization
          ON task_logs(organization_id, created_at);
      `);
    },
  };
}
