/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export function createEnterpriseKnowledgeSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for knowledge schema');
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'enterprise_knowledge',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          source_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          department TEXT,
          category TEXT,
          content TEXT NOT NULL,
          contributor TEXT,
          contributor_account_id TEXT,
          confidence REAL DEFAULT 0.5,
          source_type TEXT NOT NULL DEFAULT 'manual',
          source_label TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          version INTEGER NOT NULL DEFAULT 1,
          content_hash TEXT,
          supersedes_id INTEGER,
          reviewed_by TEXT,
          reviewed_at TEXT,
          archived_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (organization_id) REFERENCES organizations(id),
          FOREIGN KEY (supersedes_id) REFERENCES knowledge(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          knowledge_id INTEGER NOT NULL,
          organization_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          department TEXT,
          category TEXT NOT NULL,
          content TEXT NOT NULL,
          contributor TEXT,
          confidence REAL NOT NULL,
          source_type TEXT NOT NULL,
          source_label TEXT,
          status TEXT NOT NULL,
          content_hash TEXT,
          changed_by TEXT,
          change_note TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (knowledge_id) REFERENCES knowledge(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id),
          UNIQUE(knowledge_id, version)
        );
      `);

      const columns = database.prepare('PRAGMA table_info(knowledge)').all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === 'organization_id')) {
        database.exec(
          `ALTER TABLE knowledge ADD COLUMN organization_id TEXT NOT NULL ` +
            `DEFAULT '${defaultOrganizationId}'`,
        );
      }
      if (!columns.some((column) => column.name === 'source_id')) {
        database.exec('ALTER TABLE knowledge ADD COLUMN source_id TEXT');
      }

      const migrations: Array<{ name: string; sql: string }> = [
        { name: 'department', sql: 'ALTER TABLE knowledge ADD COLUMN department TEXT' },
        { name: 'category', sql: "ALTER TABLE knowledge ADD COLUMN category TEXT NOT NULL DEFAULT 'general'" },
        { name: 'contributor', sql: 'ALTER TABLE knowledge ADD COLUMN contributor TEXT' },
        { name: 'confidence', sql: 'ALTER TABLE knowledge ADD COLUMN confidence REAL DEFAULT 0.5' },
        { name: 'title', sql: "ALTER TABLE knowledge ADD COLUMN title TEXT NOT NULL DEFAULT ''" },
        { name: 'contributor_account_id', sql: 'ALTER TABLE knowledge ADD COLUMN contributor_account_id TEXT' },
        { name: 'source_type', sql: "ALTER TABLE knowledge ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'" },
        { name: 'source_label', sql: 'ALTER TABLE knowledge ADD COLUMN source_label TEXT' },
        { name: 'status', sql: "ALTER TABLE knowledge ADD COLUMN status TEXT NOT NULL DEFAULT 'active'" },
        { name: 'version', sql: 'ALTER TABLE knowledge ADD COLUMN version INTEGER NOT NULL DEFAULT 1' },
        { name: 'content_hash', sql: 'ALTER TABLE knowledge ADD COLUMN content_hash TEXT' },
        { name: 'supersedes_id', sql: 'ALTER TABLE knowledge ADD COLUMN supersedes_id INTEGER' },
        { name: 'reviewed_by', sql: 'ALTER TABLE knowledge ADD COLUMN reviewed_by TEXT' },
        { name: 'reviewed_at', sql: 'ALTER TABLE knowledge ADD COLUMN reviewed_at TEXT' },
        { name: 'archived_at', sql: 'ALTER TABLE knowledge ADD COLUMN archived_at TEXT' },
        { name: 'created_at', sql: 'ALTER TABLE knowledge ADD COLUMN created_at TEXT' },
        { name: 'updated_at', sql: 'ALTER TABLE knowledge ADD COLUMN updated_at TEXT' },
      ];
      for (const migration of migrations) {
        if (!columns.some((column) => column.name === migration.name)) {
          database.exec(migration.sql);
        }
      }

      database.exec(`
        UPDATE knowledge
        SET title = CASE WHEN trim(title) = '' THEN substr(content, 1, 200) ELSE title END,
            category = COALESCE(NULLIF(trim(category), ''), 'general'),
            confidence = COALESCE(confidence, 0.5),
            status = COALESCE(NULLIF(trim(status), ''), 'active'),
            version = CASE WHEN version IS NULL OR version < 1 THEN 1 ELSE version END,
            source_type = COALESCE(NULLIF(trim(source_type), ''), 'manual'),
            created_at = COALESCE(created_at, datetime('now')),
            updated_at = COALESCE(updated_at, created_at, datetime('now'));
      `);

      database.exec(`
        DROP INDEX IF EXISTS idx_knowledge_source_unique;
        CREATE INDEX IF NOT EXISTS idx_knowledge_dept
          ON knowledge(department);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_unique
          ON knowledge(organization_id, source_id)
          WHERE source_id IS NOT NULL AND status <> 'archived';
        CREATE INDEX IF NOT EXISTS idx_knowledge_organization
          ON knowledge(organization_id, department, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_review_queue
          ON knowledge(organization_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_knowledge_contributor
          ON knowledge(organization_id, contributor_account_id, status);
        CREATE INDEX IF NOT EXISTS idx_knowledge_revision_entry
          ON knowledge_revisions(organization_id, knowledge_id, version DESC);
      `);
    },
  };
}
