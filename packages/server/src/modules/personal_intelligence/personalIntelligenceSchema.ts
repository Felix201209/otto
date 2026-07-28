/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PERSONAL_INTELLIGENCE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'personal_intelligence',
    apply(database) {
      database.exec(`
      CREATE TABLE IF NOT EXISTS account_sync_snapshots (
        account_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('personal_memory', 'worklog', 'auto_skills')),
        version INTEGER NOT NULL,
        payload_ciphertext TEXT NOT NULL,
        payload_iv TEXT NOT NULL,
        payload_auth_tag TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        device_id TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, scope),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_account_sync_snapshots_org_updated
        ON account_sync_snapshots(organization_id, updated_at_ms);
    `);
    },
  };
