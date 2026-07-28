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
          department TEXT,
          category TEXT,
          content TEXT NOT NULL,
          contributor TEXT,
          confidence REAL DEFAULT 0.5,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
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

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_dept
          ON knowledge(department);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_unique
          ON knowledge(organization_id, source_id) WHERE source_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_knowledge_organization
          ON knowledge(organization_id, department);
      `);
    },
  };
}
