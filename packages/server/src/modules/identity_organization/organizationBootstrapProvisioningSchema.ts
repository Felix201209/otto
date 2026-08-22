/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

/**
 * Durable business idempotency for Control-driven enterprise provisioning.
 * The command queue deduplicates transport command IDs; this table prevents a
 * newly signed retry with the same business key from creating another tenant.
 */
export const ORGANIZATION_BOOTSTRAP_PROVISIONING_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor =
  {
    id: 'identity_organization_bootstrap_provisioning',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS organization_bootstrap_provisioning (
          deployment_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          command_id TEXT NOT NULL,
          payload_digest TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          ceo_account_id TEXT NOT NULL,
          default_department_id TEXT NOT NULL,
          ceo_position_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (deployment_id, idempotency_key),
          UNIQUE (organization_id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
          FOREIGN KEY (ceo_account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
          FOREIGN KEY (default_department_id) REFERENCES organization_departments(id) ON DELETE RESTRICT,
          FOREIGN KEY (ceo_position_id) REFERENCES organization_positions(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_organization_bootstrap_command
          ON organization_bootstrap_provisioning(command_id);
      `);
    },
  };
