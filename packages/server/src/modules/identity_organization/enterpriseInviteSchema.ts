/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  DatabaseHandle,
  DatabaseSchemaContributor,
} from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function tableColumns(database: DatabaseHandle, table: string): Set<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

function ensureColumn(
  database: DatabaseHandle,
  table: string,
  column: string,
  definition: string,
): void {
  if (!tableColumns(database, table).has(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function createEnterpriseInviteSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error(
      'Invalid default organization id for enterprise invite schema',
    );
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'identity_organization_enterprise_invites',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS organization_invites (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          nonce TEXT NOT NULL,
          issued_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          revoked_at_ms INTEGER,
          created_by_account_id TEXT,
          default_department TEXT,
          department_id TEXT,
          position_id TEXT,
          position_title TEXT,
          default_role TEXT,
          max_uses INTEGER,
          used_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
            ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS invite_codes (
          code TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          department TEXT NOT NULL,
          max_uses INTEGER DEFAULT 1,
          used_count INTEGER DEFAULT 0,
          created_by TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      ensureColumn(
        database,
        'invite_codes',
        'organization_id',
        `TEXT NOT NULL DEFAULT '${defaultOrganizationId}'`,
      );
      for (const column of [
        'default_department',
        'department_id',
        'position_id',
        'position_title',
        'default_role',
      ]) {
        ensureColumn(database, 'organization_invites', column, 'TEXT');
      }
      ensureColumn(database, 'organization_invites', 'max_uses', 'INTEGER');
      ensureColumn(
        database,
        'organization_invites',
        'used_count',
        'INTEGER NOT NULL DEFAULT 0',
      );

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_organization_invites_active
          ON organization_invites(
            organization_id,
            expires_at_ms,
            revoked_at_ms
          );
      `);
    },
  };
}
