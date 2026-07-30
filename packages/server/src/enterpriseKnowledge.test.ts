/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createEnterpriseKnowledgeFacade,
  createEnterpriseKnowledgeSchemaContributor,
  ENTERPRISE_KNOWLEDGE_MAX_SOURCE_ID_LENGTH,
  type EnterpriseKnowledgeRepositoryStore,
} from './modules/enterprise_knowledge/index.js';
import {
  applyDatabaseSchemaContributors,
  Database,
} from './modules/data_platform/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY);');
  applyDatabaseSchemaContributors(database, [
    createEnterpriseKnowledgeSchemaContributor({ defaultOrganizationId: 'org-a' }),
  ]);
  database.exec("INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');");
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

  it('keeps member submissions out of retrieval until approval and preserves revisions', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const saved = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'work-result-1',
        title: '客户验收流程',
        category: 'process',
        content: '提交验收单后由项目负责人复核。',
        contributor: '张三',
        contributorAccountId: 'account-1',
        status: 'pending_review',
        sourceType: 'work_result',
      });
      expect(saved.entry.status).toBe('pending_review');
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toEqual([]);
      expect(knowledge.getMemberKnowledge('研发部', '验收', 'org-a')).toEqual([]);
      expect(
        knowledge.getMemberKnowledge('研发部', '验收', 'org-a', {
          includeOwnPending: true,
          contributorAccountId: 'account-1',
        }),
      ).toEqual([expect.objectContaining({ id: saved.entry.id })]);

      const approved = knowledge.reviewKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      });
      expect(approved).toEqual(expect.objectContaining({ status: 'active', version: 2 }));
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toHaveLength(1);

      const revised = knowledge.reviseKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        content: '提交验收单后由项目负责人和客户共同复核。',
        changedBy: '管理员',
        changeNote: '补充客户确认环节',
      });
      expect(revised).toEqual(expect.objectContaining({ version: 3 }));
      expect(knowledge.getKnowledgeRevisions(saved.entry.id, 'org-a'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ version: 1, status: 'pending_review' }),
          expect.objectContaining({ version: 2, status: 'active' }),
          expect.objectContaining({ version: 3, change_note: '补充客户确认环节' }),
        ]));

      knowledge.reviewKnowledge({
        id: saved.entry.id,
        organizationId: 'org-a',
        action: 'archive',
        reviewer: '管理员',
      });
      expect(knowledge.searchKnowledge('验收', undefined, 'org-a')).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('promotes the selected successor safely when several revisions await review', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      const original = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 1000 元。',
        status: 'active',
      }).entry;
      const firstRevision = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 1500 元。',
        status: 'pending_review',
      }).entry;
      const secondRevision = knowledge.saveKnowledge({
        organizationId: 'org-a',
        sourceId: 'policy-1',
        category: 'policy',
        content: '报销上限为 2000 元。',
        status: 'pending_review',
      }).entry;

      knowledge.reviewKnowledge({
        id: firstRevision.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      });
      expect(knowledge.getKnowledge(undefined, 'policy', 'org-a'))
        .toEqual([expect.objectContaining({ id: firstRevision.id })]);

      expect(() => knowledge.reviewKnowledge({
        id: secondRevision.id,
        organizationId: 'org-a',
        action: 'approve',
        reviewer: '管理员',
      })).not.toThrow();
      expect(knowledge.getKnowledge(undefined, 'policy', 'org-a'))
        .toEqual([expect.objectContaining({ id: secondRevision.id })]);
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a', 'archived'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: original.id }),
          expect.objectContaining({ id: firstRevision.id }),
        ]));
    } finally {
      database.close();
    }
  });

  it('exports every lifecycle record instead of truncating backups to the admin view limit', () => {
    const database = createDatabase();
    const knowledge = createEnterpriseKnowledgeFacade(createStore(database));

    try {
      for (let index = 0; index < 125; index += 1) {
        knowledge.saveKnowledge({
          organizationId: 'org-a',
          sourceId: `backup-${index}`,
          category: 'backup',
          content: `知识记录 ${index}`,
          status: index % 2 === 0 ? 'active' : 'pending_review',
        });
      }
      expect(knowledge.getKnowledgeForAdministration('', undefined, 'org-a')).toHaveLength(100);
      expect(knowledge.getKnowledgeForBackup('org-a')).toHaveLength(125);
    } finally {
      database.close();
    }
  });
});
