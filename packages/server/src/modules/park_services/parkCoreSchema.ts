/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PARK_CORE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'park_services_core',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS parks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        invite_secret TEXT NOT NULL,
        admin_organization_id TEXT NOT NULL UNIQUE,
        brand_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'disabled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (admin_organization_id) REFERENCES organizations(id)
          ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS park_invites (
        id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        created_by_account_id TEXT NOT NULL,
        max_uses INTEGER,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_services (
        park_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (park_id, id),
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_tenant_profiles (
        organization_id TEXT PRIMARY KEY,
        park_id TEXT NOT NULL,
        address TEXT NOT NULL,
        room_number TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_service_specialists (
        park_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (park_id, service_id, account_id),
        FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_park_invites_active
        ON park_invites(park_id, expires_at_ms, revoked_at_ms);
    `);
  },
};
