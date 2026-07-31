/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createEnterpriseKnowledgeSchemaContributor } from './enterpriseKnowledgeSchema.js';

const contributor = createEnterpriseKnowledgeSchemaContributor({
  defaultOrganizationId: 'org_default',
});

function createOrganizationPrerequisite(database: Database): void {
  database.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY);');
}

describe('enterprise knowledge schema contributor', () => {
  it('creates the current schema and indexes idempotently', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO organizations (id) VALUES ('org_default');
        INSERT INTO knowledge (content) VALUES ('shared policy');
      `);

      const row = database
        .prepare('SELECT organization_id, source_id, content FROM knowledge')
        .get();
      expect(row).toEqual({
        organization_id: 'org_default',
        source_id: null,
        content: 'shared policy',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_knowledge_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_knowledge_contributor' },
        { name: 'idx_knowledge_dept' },
        { name: 'idx_knowledge_organization' },
        { name: 'idx_knowledge_retention_contributor' },
        { name: 'idx_knowledge_retention_topic' },
        { name: 'idx_knowledge_review_queue' },
        { name: 'idx_knowledge_revision_entry' },
        { name: 'idx_knowledge_source_unique' },
      ]);
    } finally {
      database.close();
    }
  });

  it('migrates a legacy single-organization table without losing rows', () => {
    const database = new Database(':memory:');
    try {
      createOrganizationPrerequisite(database);
      database.exec(`
        CREATE TABLE knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          department TEXT,
          category TEXT,
          content TEXT NOT NULL
        );
        INSERT INTO knowledge (department, category, content)
        VALUES ('研发', '流程', '旧知识');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      expect(
        database.prepare('PRAGMA table_info(knowledge)').all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'organization_id' }),
          expect.objectContaining({ name: 'source_id' }),
          expect.objectContaining({ name: 'status' }),
          expect.objectContaining({ name: 'version' }),
          expect.objectContaining({ name: 'updated_at' }),
        ]),
      );
      expect(
        database
          .prepare(
            `SELECT organization_id, source_id, department, category, content
             FROM knowledge`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org_default',
        source_id: null,
        department: '研发',
        category: '流程',
        content: '旧知识',
      });

      database
        .prepare('UPDATE knowledge SET source_id = ? WHERE id = 1')
        .run('source-1');
      expect(() =>
        database
          .prepare(
            `INSERT INTO knowledge
               (organization_id, source_id, department, category, content)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('org_default', 'source-1', '研发', '流程', '重复来源'),
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      database.close();
    }
  });

  it('rejects an unsafe default organization id before applying SQL', () => {
    expect(() =>
      createEnterpriseKnowledgeSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE knowledge; --",
      }),
    ).toThrow('Invalid default organization id for knowledge schema');
  });
});
