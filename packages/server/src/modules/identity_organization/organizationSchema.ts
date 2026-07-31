/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'identity_organization_root',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
          invite_secret TEXT NOT NULL,
          park_id TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'disabled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const columns = database
        .prepare('PRAGMA table_info(organizations)')
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'park_id')) {
        database.exec('ALTER TABLE organizations ADD COLUMN park_id TEXT');
      }

      database.exec(`
        CREATE TABLE IF NOT EXISTS organization_features (
          organization_id TEXT NOT NULL,
          feature_key TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (organization_id, feature_key),
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_organizations_status
          ON organizations(status);
        CREATE INDEX IF NOT EXISTS idx_organizations_park
          ON organizations(park_id);
      `);
    },
  };
