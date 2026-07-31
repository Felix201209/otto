/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'data_governance',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS legal_consents (
        account_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_version TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('registration', 'settings', 'migration')),
        accepted_at_ms INTEGER NOT NULL,
        PRIMARY KEY (account_id, document_id, document_version),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS privacy_requests (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        request_type TEXT NOT NULL CHECK(request_type IN ('export', 'delete')),
        status TEXT NOT NULL CHECK(status IN ('requested', 'completed', 'failed')),
        requested_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        receipt_json TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts(id),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_legal_consents_account
        ON legal_consents(account_id, accepted_at_ms);
      CREATE INDEX IF NOT EXISTS idx_privacy_requests_account
        ON privacy_requests(account_id, requested_at_ms);
    `);
  },
};
