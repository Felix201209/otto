/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Credit-ledger schema ownership. Business decisions remain in the repository.
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function assertSafeOrganizationId(defaultOrganizationId: string): void {
  if (!SAFE_ORGANIZATION_ID.test(defaultOrganizationId)) {
    throw new Error('Invalid default organization id for credits schema');
  }
}

export function buildCreditsTablesSql(defaultOrganizationId: string): string[] {
  assertSafeOrganizationId(defaultOrganizationId);
  return [
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
      account_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('topup','redeem','consume','refund')),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      redeem_code_id TEXT,
      model TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (redeem_code_id) REFERENCES redeem_codes(id)
    )`,

    `CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
      code TEXT NOT NULL UNIQUE,
      credit_amount INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','redeemed','revoked')),
      redeemed_by TEXT,
      redeemed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (created_by) REFERENCES accounts(id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_credit_trans_org
      ON credit_transactions(organization_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_redeem_codes_code
      ON redeem_codes(code)`,
  ];
}

export function createCreditsSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  assertSafeOrganizationId(input.defaultOrganizationId);
  const statements = buildCreditsTablesSql(input.defaultOrganizationId);

  return {
    id: 'commercial_control_credits',
    apply(database) {
      const columns = database
        .prepare('PRAGMA table_info(organizations)')
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'credit_balance')) {
        database.exec(
          'ALTER TABLE organizations ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0',
        );
      }
      database.exec(`${statements.join(';\n')};`);
    },
  };
}
