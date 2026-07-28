/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const MODEL_GATEWAY_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'model_gateway',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_token_usage (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(account_id, message_id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_account_token_usage_org_created
        ON account_token_usage(organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_account_token_usage_account_created
        ON account_token_usage(account_id, created_at);
    `);
  },
};
