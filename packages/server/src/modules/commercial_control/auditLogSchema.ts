/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function createAuditLogSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for audit log schema');
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'commercial_control_audit_log',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          event TEXT NOT NULL,
          employee_id TEXT,
          detail TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      const columns = database
        .prepare('PRAGMA table_info(audit_logs)')
        .all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'organization_id')) {
        database.exec(
          `ALTER TABLE audit_logs ADD COLUMN organization_id TEXT NOT NULL ` +
            `DEFAULT '${defaultOrganizationId}'`,
        );
      }

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_audit_organization
          ON audit_logs(organization_id, created_at);
      `);
    },
  };
}
