/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'identity_organization_structure',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS organization_departments (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          parent_department_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(organization_id, name),
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS organization_positions (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          department_id TEXT NOT NULL,
          title TEXT NOT NULL COLLATE NOCASE,
          role_mapping TEXT NOT NULL DEFAULT 'member'
            CHECK(role_mapping IN ('member', 'department_admin', 'enterprise_admin')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(organization_id, department_id, title),
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
          FOREIGN KEY (department_id) REFERENCES organization_departments(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_organization_departments_org
          ON organization_departments(organization_id, name);
        CREATE INDEX IF NOT EXISTS idx_organization_positions_org
          ON organization_positions(organization_id, department_id, title);
      `);

      const columns = database
        .prepare('PRAGMA table_info(organization_departments)')
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'parent_department_id')) {
        database.exec('ALTER TABLE organization_departments ADD COLUMN parent_department_id TEXT');
      }
    },
  };
