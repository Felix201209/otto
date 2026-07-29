/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PARK_STATISTICS_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'park_services_statistics',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS park_data_statistics_tasks (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL,
        admin_organization_id TEXT NOT NULL,
        created_by_account_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        deadline TEXT NOT NULL,
        fields_json TEXT NOT NULL DEFAULT '[]',
        template_name TEXT,
        template_data TEXT,
        status TEXT NOT NULL DEFAULT 'published'
          CHECK(status IN ('published', 'closed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
        FOREIGN KEY (admin_organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
      );

      CREATE TABLE IF NOT EXISTS park_data_statistics_assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        park_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        ceo_account_id TEXT NOT NULL,
        assignee_account_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
          'pending', 'delegated', 'in_progress', 'pending_review',
          'submitted', 'returned', 'overdue'
        )),
        response_data TEXT,
        return_reason TEXT,
        read_at TEXT,
        submitted_at TEXT,
        reviewed_at TEXT,
        last_reminded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, organization_id),
        FOREIGN KEY (task_id) REFERENCES park_data_statistics_tasks(id)
          ON DELETE CASCADE,
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (ceo_account_id) REFERENCES accounts(id),
        FOREIGN KEY (assignee_account_id) REFERENCES accounts(id)
      );

      CREATE INDEX IF NOT EXISTS idx_park_statistics_tasks_park
        ON park_data_statistics_tasks(park_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_park_statistics_assignments_account
        ON park_data_statistics_assignments(
          ceo_account_id, assignee_account_id, status
        );
      CREATE INDEX IF NOT EXISTS idx_park_statistics_assignments_org
        ON park_data_statistics_assignments(organization_id, task_id, status);
    `);
  },
};
