/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createEncryptedFieldCipher, Database } from '../data_platform/index.js';
import { ENTERPRISE_SKILL_MARKET_SCHEMA_CONTRIBUTOR } from './skillMarketplaceSchema.js';
import {
  getEnterpriseSkillLeaderboardFromRepository,
  installEnterpriseSkillInRepository,
  listEnterpriseSkillsFromRepository,
  rateEnterpriseSkillInRepository,
  recordEnterpriseSkillUsageInRepository,
  reviewEnterpriseSkillInRepository,
  submitEnterpriseSkillInRepository,
  type EnterpriseSkillActor,
} from './skillMarketplaceRepository.js';

function actor(
  accountId: string,
  name: string,
  department: string | null,
  isAdmin = false,
): EnterpriseSkillActor {
  return { accountId, organizationId: 'org-1', name, department, isAdmin };
}

function createStore() {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    INSERT INTO organizations (id, name) VALUES ('org-1', '示例企业');
    INSERT INTO accounts (id, organization_id) VALUES
      ('author-1', 'org-1'), ('buyer-1', 'org-1'), ('other-1', 'org-1'), ('admin-1', 'org-1');
  `);
  ENTERPRISE_SKILL_MARKET_SCHEMA_CONTRIBUTOR.apply(database);
  let nextId = 0;
  return {
    database,
    store: {
      db: () => database,
      fieldCipher: createEncryptedFieldCipher({
        keyProvider: { getKey: () => Buffer.alloc(32, 11), clear() {} },
      }),
      organizationExists: (organizationId: string) => organizationId === 'org-1',
      createId: () => String(++nextId),
    },
  };
}

describe('enterprise Skill marketplace repository', () => {
  it('closes submission, review, installation, rating, usage and ranking without crossing departments', () => {
    const { database, store } = createStore();
    try {
      const author = actor('author-1', '张悦', '财务部');
      const buyer = actor('buyer-1', '李明', '财务部');
      const outsider = actor('other-1', '王芳', '研发部');
      const admin = actor('admin-1', '管理员', '管理层', true);
      const submitted = submitEnterpriseSkillInRepository(store, author, {
        name: '月报整理',
        description: '根据工作日志整理月报。',
        content: '# 月报整理\n\n汇总事实并标注来源。',
        visibility: 'department',
      });

      expect(submitted.outcome).toBe('submitted');
      expect(submitted.skill.status).toBe('pending_review');
      expect(listEnterpriseSkillsFromRepository(store, buyer)).toEqual([]);
      expect(() => listEnterpriseSkillsFromRepository(store, buyer, { scope: 'review' })).toThrow('只有企业管理员');

      const stored = database.prepare(
        'SELECT content, content_ciphertext FROM enterprise_skills WHERE id = ?',
      ).get(submitted.skill.id) as { content: string; content_ciphertext: string };
      expect(stored.content).toBe('[encrypted:v1]');
      expect(stored.content_ciphertext).not.toContain('汇总事实');

      const reviewed = reviewEnterpriseSkillInRepository(store, admin, {
        id: submitted.skill.id,
        action: 'approve',
        visibility: 'department',
      });
      expect(reviewed?.status).toBe('active');
      expect(listEnterpriseSkillsFromRepository(store, buyer)).toHaveLength(1);
      expect(listEnterpriseSkillsFromRepository(store, outsider)).toEqual([]);
      expect(listEnterpriseSkillsFromRepository(store, buyer, { scope: 'company' })).toEqual([]);

      const installed = installEnterpriseSkillInRepository(store, buyer, submitted.skill.id);
      expect(installed?.content).toContain('汇总事实并标注来源');
      expect(installed?.installedVersion).toBe(1);
      installEnterpriseSkillInRepository(store, buyer, submitted.skill.id);
      expect(listEnterpriseSkillsFromRepository(store, buyer)[0]?.installCount).toBe(1);

      expect(() => rateEnterpriseSkillInRepository(store, outsider, submitted.skill.id, 5)).toThrow('无权评价');
      expect(rateEnterpriseSkillInRepository(store, buyer, submitted.skill.id, 5)?.rating).toBe(5);
      expect(rateEnterpriseSkillInRepository(store, buyer, submitted.skill.id, 4)?.ratingCount).toBe(1);
      installEnterpriseSkillInRepository(store, author, submitted.skill.id);
      expect(() => rateEnterpriseSkillInRepository(store, author, submitted.skill.id, 5)).toThrow('不能评价自己');

      recordEnterpriseSkillUsageInRepository(store, buyer, submitted.skill.id, true, 'a'.repeat(64));
      recordEnterpriseSkillUsageInRepository(store, buyer, submitted.skill.id, true, 'a'.repeat(64));
      recordEnterpriseSkillUsageInRepository(store, buyer, submitted.skill.id, false);
      const ranking = getEnterpriseSkillLeaderboardFromRepository(store, buyer);
      expect(ranking.skills[0]).toMatchObject({
        name: '月报整理',
        rank: 1,
        usageCount: 2,
        successCount: 1,
        successRate: 0.5,
      });
      expect(ranking.contributors[0]).toMatchObject({ name: '张悦', rank: 1, skillCount: 1 });
      expect((database.prepare(
        'SELECT COUNT(*) AS count FROM enterprise_skill_usage_events WHERE skill_id = ?',
      ).get(submitted.skill.id) as { count: number }).count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('deduplicates identical submissions and blocks obvious credentials', () => {
    const { database, store } = createStore();
    try {
      const author = actor('author-1', '张悦', '财务部');
      const input = {
        name: '发票检查',
        description: '核对发票字段。',
        content: '# 发票检查\n\n检查抬头和税号。',
      };
      expect(submitEnterpriseSkillInRepository(store, author, input).outcome).toBe('submitted');
      expect(submitEnterpriseSkillInRepository(store, author, input).outcome).toBe('exists');
      expect(() => submitEnterpriseSkillInRepository(store, author, {
        ...input,
        content: 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123456"',
      })).toThrow('疑似包含密钥');
    } finally {
      database.close();
    }
  });
});
