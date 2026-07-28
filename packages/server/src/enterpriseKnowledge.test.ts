/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createEnterpriseKnowledgeFacade,
  ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH,
  type EnterpriseKnowledgeRepositoryStore,
} from './modules/enterprise_knowledge/index.js';
import { Database } from './modules/data_platform/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL,
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
    CREATE UNIQUE INDEX idx_knowledge_source_unique
      ON knowledge(organization_id, source_id) WHERE source_id IS NOT NULL;
    INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');
  `);
  return database;
}

function createStore(database: Database): EnterpriseKnowledgeRepositoryStore {
  return {
    db: () => database,
    defaultOrganizationId: 'org-a',
    organizationExists: (organizationId) =>
      Boolean(
        database
          .prepare('SELECT 1 FROM organizations WHERE id = ?')
          .get(organizationId),
      ),
  };
}

describe('enterprise knowledge kernel', () => {
  it('isolates source-id deduplication by organization and rejects missing tenants', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const entry = {
        sourceId: 'shared-source',
        category: 'process',
        content: 'Shared process knowledge',
      };
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-a' }),
      ).toBe(true);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-a' }),
      ).toBe(false);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-b' }),
      ).toBe(true);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-a'),
      ).toHaveLength(1);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-b'),
      ).toHaveLength(1);
      expect(() =>
        knowledge.addKnowledge({ ...entry, organizationId: 'missing' }),
      ).toThrow('Organization not found');
      expect(() =>
        knowledge.getKnowledge(undefined, undefined, 'missing'),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('limits members to global knowledge and their own department', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      knowledge.addKnowledge({
        organizationId: 'org-a',
        category: 'global',
        content: 'All employees can read this',
      });
      knowledge.addKnowledge({
        organizationId: 'org-a',
        department: '研发部',
        category: 'engineering',
        content: '研发内部方案',
      });
      knowledge.addKnowledge({
        organizationId: 'org-a',
        department: '销售部',
        category: 'sales',
        content: '销售客户名单',
      });
      knowledge.addKnowledge({
        organizationId: 'org-b',
        category: 'other-tenant',
        content: 'Other tenant secret',
      });

      expect(
        knowledge
          .getMemberKnowledge('研发部', '', 'org-a')
          .map((entry) => entry.category),
      ).toEqual(expect.arrayContaining(['global', 'engineering']));
      expect(
        knowledge
          .getMemberKnowledge('研发部', '', 'org-a')
          .map((entry) => entry.category),
      ).not.toContain('sales');
      expect(
        knowledge
          .getMemberKnowledge(null, '', 'org-a')
          .map((entry) => entry.category),
      ).toEqual(['global']);
      expect(
        JSON.stringify(knowledge.getMemberKnowledge('研发部', '', 'org-a')),
      ).not.toContain('Other tenant secret');
    } finally {
      database.close();
    }
  });

  it('searches percent and underscore as literal characters', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      knowledge.addKnowledge({
        category: 'metrics',
        content: 'Coverage is 100%',
      });
      knowledge.addKnowledge({
        category: 'metrics',
        content: 'Coverage is 100X',
      });
      knowledge.addKnowledge({
        category: 'under_score',
        content: 'Literal marker',
      });
      knowledge.addKnowledge({
        category: 'underXscore',
        content: 'Wildcard decoy',
      });

      expect(
        knowledge.searchKnowledge('%').map((entry) => entry.content),
      ).toEqual(['Coverage is 100%']);
      expect(
        knowledge.searchKnowledge('_').map((entry) => entry.category),
      ).toEqual(['under_score']);
    } finally {
      database.close();
    }
  });

  it('normalizes stored fields and rejects invalid content boundaries', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      expect(
        knowledge.addKnowledge({
          department: ' 研发部 ',
          category: ' solution ',
          content: ' 可复用方案 ',
          contributor: ' 张三 ',
          sourceId: ' source-1 ',
          confidence: 0.9,
        }),
      ).toBe(true);
      expect(knowledge.getKnowledge('研发部', 'solution')).toEqual([
        expect.objectContaining({
          department: '研发部',
          category: 'solution',
          content: '可复用方案',
          contributor: '张三',
          source_id: 'source-1',
          confidence: 0.9,
        }),
      ]);
      expect(() =>
        knowledge.addKnowledge({ category: ' ', content: 'content' }),
      ).toThrow('knowledge category is required');
      expect(() =>
        knowledge.addKnowledge({ category: 'general', content: ' ' }),
      ).toThrow('knowledge content is required');
      expect(() =>
        knowledge.addKnowledge({
          category: 'general',
          content: 'content',
          confidence: 2,
        }),
      ).toThrow('knowledge confidence must be between 0 and 1');
      expect(() =>
        knowledge.addKnowledge({
          category: 'general',
          content: 'content',
          sourceId: 'x'.repeat(ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH + 1),
        }),
      ).toThrow('knowledge source id is too long');
    } finally {
      database.close();
    }
  });
});
