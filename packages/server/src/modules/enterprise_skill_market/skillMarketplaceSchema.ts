/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const ENTERPRISE_SKILL_MARKET_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'enterprise_skill_market',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS enterprise_skills (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        department TEXT,
        visibility TEXT NOT NULL CHECK(visibility IN ('department', 'company')),
        status TEXT NOT NULL CHECK(status IN ('pending_review', 'active', 'archived')),
        author_account_id TEXT,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '[encrypted:v1]',
        content_ciphertext TEXT,
        content_iv TEXT,
        content_auth_tag TEXT,
        content_key_version INTEGER,
        content_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        install_count INTEGER NOT NULL DEFAULT 0,
        usage_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        rating_total INTEGER NOT NULL DEFAULT 0,
        rating_count INTEGER NOT NULL DEFAULT 0,
        reviewed_by TEXT,
        reviewed_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );

      CREATE TABLE IF NOT EXISTS enterprise_skill_versions (
        skill_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL DEFAULT '[encrypted:v1]',
        content_ciphertext TEXT,
        content_iv TEXT,
        content_auth_tag TEXT,
        content_key_version INTEGER,
        content_hash TEXT NOT NULL,
        description TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (skill_id, version),
        FOREIGN KEY (skill_id) REFERENCES enterprise_skills(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );

      CREATE TABLE IF NOT EXISTS enterprise_skill_installs (
        skill_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        installed_version INTEGER NOT NULL,
        installed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (skill_id, account_id),
        FOREIGN KEY (skill_id) REFERENCES enterprise_skills(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS enterprise_skill_ratings (
        skill_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (skill_id, account_id),
        FOREIGN KEY (skill_id) REFERENCES enterprise_skills(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS enterprise_skill_usage_events (
        event_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        account_id TEXT,
        success INTEGER NOT NULL CHECK(success IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (skill_id) REFERENCES enterprise_skills(id) ON DELETE CASCADE,
        FOREIGN KEY (organization_id) REFERENCES organizations(id),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_enterprise_skills_author_hash
        ON enterprise_skills(organization_id, author_account_id, content_hash)
        WHERE status <> 'archived' AND author_account_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_enterprise_skills_market
        ON enterprise_skills(organization_id, status, visibility, department, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_enterprise_skills_review
        ON enterprise_skills(organization_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_enterprise_skill_installs_account
        ON enterprise_skill_installs(organization_id, account_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_enterprise_skill_usage_events_account
        ON enterprise_skill_usage_events(organization_id, account_id, created_at DESC);
    `);
  },
};
