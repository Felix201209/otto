/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Pure credit-ledger schema definitions. Business decisions live in the
 * repository while the enterprise database composition root owns migrations.
 */

export function buildCreditsTablesSql(defaultOrganizationId: string): string[] {
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
