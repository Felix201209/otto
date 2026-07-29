/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export interface LegacyEnterpriseTenantMigrationOptions {
  defaultOrganizationId: string;
  defaultOrganizationName: string;
  inviteSecret: string;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Establishes the tenant root required by pre-B2B data before domain-specific
 * backfills run. The operation is idempotent so every database reopen is safe.
 */
export function migrateLegacyEnterpriseTenant(
  database: Database,
  options: LegacyEnterpriseTenantMigrationOptions,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO organizations (id, name, slug, invite_secret)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      options.defaultOrganizationId,
      options.defaultOrganizationName,
      'default',
      options.inviteSecret,
    );

  const columns = database
    .prepare('PRAGMA table_info(account_presence)')
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'organization_id')) {
    database.exec(
      `ALTER TABLE account_presence ADD COLUMN organization_id TEXT NOT NULL ` +
        `DEFAULT ${sqlStringLiteral(options.defaultOrganizationId)}`,
    );
  }
}
