/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

/**
 * 企业初始化的持久层：开通幂等记录、系统角色绑定、首次登录令牌。
 * 令牌只保存安全摘要，不保存明文。
 */
export const ENTERPRISE_INITIATION_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'enterprise_initiation',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_initiations (
        deployment_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('completed')),
        organization_id TEXT NOT NULL,
        ceo_account_id TEXT NOT NULL,
        default_department_id TEXT,
        result_json TEXT NOT NULL,
        executed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (deployment_id, command_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS system_role_assignments (
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        role_name TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        PRIMARY KEY (organization_id, account_id, role_key)
      );

      CREATE TABLE IF NOT EXISTS first_login_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('ceo_password_set')),
        expires_at_ms INTEGER NOT NULL,
        used_at_ms INTEGER,
        revoked_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_first_login_tokens_account
        ON first_login_tokens(account_id, purpose, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_system_role_assignments_role
        ON system_role_assignments(organization_id, role_key);
    `);
  },
};
