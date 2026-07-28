/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function createMemberSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for member schema');
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'identity_organization_member',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS employees (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          name TEXT NOT NULL,
          role TEXT,
          department TEXT,
          department_id TEXT,
          position_id TEXT,
          position_title TEXT,
          invite_code TEXT,
          status TEXT DEFAULT 'active',
          personality TEXT,
          onboarded_at TEXT DEFAULT (datetime('now')),
          offboarded_at TEXT,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      const columns = database
        .prepare('PRAGMA table_info(employees)')
        .all() as Array<{
        name: string;
      }>;
      const ensureTextColumn = (name: string, definition = 'TEXT'): void => {
        if (!columns.some((column) => column.name === name)) {
          database.exec(
            `ALTER TABLE employees ADD COLUMN ${name} ${definition}`,
          );
        }
      };
      ensureTextColumn(
        'organization_id',
        `TEXT NOT NULL DEFAULT '${defaultOrganizationId}'`,
      );
      ensureTextColumn('department_id');
      ensureTextColumn('position_id');
      ensureTextColumn('position_title');

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_employees_organization
          ON employees(organization_id, status);
      `);
    },
  };
}
