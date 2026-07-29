/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import type {
  DatabaseHandle,
  DatabaseSchemaContributor,
} from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function assertDefaultOrganizationId(defaultOrganizationId: string): void {
  if (!SAFE_ORGANIZATION_ID.test(defaultOrganizationId)) {
    throw new Error('Invalid default organization id for account auth schema');
  }
}

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

export function migrateLegacyAuthSessions(
  database: DatabaseHandle,
  defaultOrganizationId: string,
): void {
  assertDefaultOrganizationId(defaultOrganizationId);
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'",
    )
    .get() as { name?: string } | undefined;
  if (!table) return;

  const names = tableColumns(database, 'auth_sessions');
  if (names.has('token_hash') && names.has('id')) return;
  if (
    !names.has('token') ||
    !names.has('account_id') ||
    !names.has('expires_at')
  ) {
    return;
  }

  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      'ALTER TABLE auth_sessions RENAME TO auth_sessions_legacy_v195',
    );
    database.exec(`
      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
        account_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      )
    `);
    const legacyNames = tableColumns(database, 'auth_sessions_legacy_v195');
    const organizationExpr = legacyNames.has('organization_id')
      ? 'COALESCE(organization_id, ?) AS organization_id'
      : '? AS organization_id';
    const rows = database
      .prepare(
        `SELECT token, account_id, expires_at, created_at, ${organizationExpr}
         FROM auth_sessions_legacy_v195
         WHERE token IS NOT NULL AND token <> ''`,
      )
      .all(defaultOrganizationId) as Array<{
      token: string;
      account_id: string;
      expires_at: string;
      created_at: string | null;
      organization_id: string | null;
    }>;
    const insert = database.prepare(
      `INSERT OR IGNORE INTO auth_sessions
       (id, organization_id, account_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    );
    for (const row of rows) {
      const hashed = createHash('sha256').update(row.token).digest('hex');
      insert.run(
        `session_legacy_${hashed.slice(0, 24)}`,
        row.organization_id || defaultOrganizationId,
        row.account_id,
        hashed,
        row.expires_at,
        row.created_at,
      );
    }
    database.exec('DROP TABLE auth_sessions_legacy_v195');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

export function createAccountAuthSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  assertDefaultOrganizationId(input.defaultOrganizationId);
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'identity_organization_account_auth',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          account_type TEXT NOT NULL DEFAULT 'enterprise',
          employee_id TEXT UNIQUE,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          phone TEXT,
          feishu_open_id TEXT,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          role TEXT,
          department TEXT,
          department_id TEXT,
          position_id TEXT,
          position_title TEXT,
          avatar_url TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active', 'disabled')),
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (employee_id) REFERENCES employees(id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS account_tags (
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          account_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (account_id, tag),
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          account_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS sms_login_challenges (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          account_id TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          attempts_remaining INTEGER NOT NULL DEFAULT 5,
          consumed_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS sms_registration_challenges (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          phone TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          attempts_remaining INTEGER NOT NULL DEFAULT 5,
          organization_invite_id TEXT,
          department TEXT,
          department_id TEXT,
          position_id TEXT,
          position_title TEXT,
          role TEXT,
          consumed_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      for (const table of [
        'accounts',
        'account_tags',
        'auth_sessions',
        'sms_login_challenges',
        'sms_registration_challenges',
      ]) {
        ensureColumn(
          database,
          table,
          'organization_id',
          `TEXT NOT NULL DEFAULT '${defaultOrganizationId}'`,
        );
      }

      for (const column of [
        'phone',
        'feishu_open_id',
        'employee_id',
        'position_id',
        'position_title',
        'department_id',
        'avatar_url',
        'account_type',
        'deleted_at',
      ]) {
        ensureColumn(database, 'accounts', column, 'TEXT');
      }
      for (const column of [
        'department',
        'organization_invite_id',
        'department_id',
        'position_id',
        'position_title',
        'role',
      ]) {
        ensureColumn(database, 'sms_registration_challenges', column, 'TEXT');
      }

      database.exec(`
        UPDATE accounts
        SET account_type = 'enterprise'
        WHERE account_type IS NULL;

        CREATE INDEX IF NOT EXISTS idx_accounts_status
          ON accounts(status);
        CREATE INDEX IF NOT EXISTS idx_account_tags_tag
          ON account_tags(tag, account_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_token
          ON auth_sessions(token_hash);
        CREATE INDEX IF NOT EXISTS idx_sms_challenges_account_created
          ON sms_login_challenges(account_id, created_at_ms);
        CREATE INDEX IF NOT EXISTS idx_sms_registration_phone_created
          ON sms_registration_challenges(phone, created_at_ms);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_phone_unique
          ON accounts(phone) WHERE phone IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_accounts_organization
          ON accounts(organization_id, status);
        CREATE INDEX IF NOT EXISTS idx_accounts_feishu_open_id
          ON accounts(organization_id, feishu_open_id)
          WHERE feishu_open_id IS NOT NULL;
      `);
    },
  };
}
