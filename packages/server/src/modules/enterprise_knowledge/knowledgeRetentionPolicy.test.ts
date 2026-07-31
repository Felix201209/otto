/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  decideEnterpriseKnowledgeRetention,
  enterpriseKnowledgeObservationSimilarity,
  normalizeEnterpriseKnowledgeAtom,
} from './knowledgeRetentionPolicy.js';

const emptySummary = {
  evidenceCount: 1,
  distinctSessionCount: 1,
  distinctContributorCount: 1,
  spanDays: 0,
  averageConfidence: 0.9,
  maximumImpactScore: 0.9,
  hasVerifiedEvidence: true,
};

describe('enterprise knowledge retention policy', () => {
  it('promotes a verified high-impact conclusion but not an ordinary suggestion', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '重大生产事故的根因是租户缓存未隔离，加入企业编号后验证通过。',
      confidence: 0.92,
      verified: true,
    }, emptySummary)).toMatchObject({
      promote: true,
      reason: 'high_impact_verified',
    });

    expect(decideEnterpriseKnowledgeRetention({
      category: 'research',
      content: '可以考虑以后换一种展示方式。',
      confidence: 0.9,
      verified: false,
    }, emptySummary)).toMatchObject({ promote: false, reason: 'incubating' });

    expect(decideEnterpriseKnowledgeRetention({
      category: 'solution',
      content: '重大生产事故可能与缓存有关，但尚未完成验证。',
      confidence: 0.95,
      verified: true,
    }, emptySummary)).toMatchObject({ promote: false, reason: 'incubating' });
  });

  it('promotes knowledge repeated across sessions and time', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'research',
      content: '客户验收前需要先完成安全扫描。',
      confidence: 0.78,
      verified: false,
    }, {
      evidenceCount: 4,
      distinctSessionCount: 3,
      distinctContributorCount: 1,
      spanDays: 9,
      averageConfidence: 0.79,
      maximumImpactScore: 0.68,
      hasVerifiedEvidence: false,
    })).toMatchObject({ promote: true, reason: 'long_term_recurrence' });
  });

  it('never promotes a personal preference merely because one person repeats it', () => {
    expect(decideEnterpriseKnowledgeRetention({
      category: 'preference',
      content: '我喜欢所有报告都使用蓝色标题。',
      confidence: 0.95,
      verified: true,
    }, {
      evidenceCount: 10,
      distinctSessionCount: 10,
      distinctContributorCount: 1,
      spanDays: 60,
      averageConfidence: 0.95,
      maximumImpactScore: 1,
      hasVerifiedEvidence: true,
    })).toMatchObject({ promote: false, reason: 'incubating' });
  });

  it('reduces transcript-like answers to atomic conclusions and clusters paraphrases', () => {
    const atom = normalizeEnterpriseKnowledgeAtom(
      `助手：这里有很长的背景解释。\n根因是缓存键缺少企业编号。\n修复方案是加入 organizationId。\n验证通过：隔离测试通过。`,
    );
    expect(atom).not.toContain('助手：');
    expect(atom).toContain('根因是缓存键缺少企业编号');
    expect(atom.split('\n')).toHaveLength(3);
    expect(enterpriseKnowledgeObservationSimilarity(
      '缓存键加入企业编号后，跨租户隔离测试通过。',
      '修复缓存串数据：在缓存 key 中增加企业编号，并通过隔离测试。',
    )).toBeGreaterThan(0.3);
  });
});
