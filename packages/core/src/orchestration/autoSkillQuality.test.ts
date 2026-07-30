/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { WorkLogEntry } from './workLog.js';
import {
  assessAutoSkillCandidate,
  rankAutoSkillCandidates,
  type AutoSkillQualityInput,
} from './autoSkillQuality.js';

function log(day: number, success = true, details?: string): WorkLogEntry {
  return {
    timestamp: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    toolName: 'write_document',
    action: '生成品牌营销方案',
    category: 'document',
    success,
    details,
    entryType: 'work_result',
    taskTitle: '品牌营销方案',
    userInput: day % 2 ? '生成新品发布营销方案' : '制作活动品牌营销方案',
  };
}

function candidate(overrides: Partial<AutoSkillQualityInput> = {}): AutoSkillQualityInput {
  return {
    name: 'auto-brand-campaign',
    description: '复用品牌营销方案的结构、校验与交付流程',
    triggerPatterns: ['生成品牌营销方案', '制作新品营销文案'],
    detectedPattern: '品牌营销方案交付',
    occurrenceCount: 4,
    sampleEntries: [log(1), log(2), log(3), log(4, false, '缺少品牌色导致返工')],
    skillContent: [
      '---',
      'name: auto-brand-campaign',
      'description: 复用品牌营销方案交付流程',
      '---',
      '',
      '## 触发场景',
      '当用户需要品牌营销方案时使用。',
      '## 必要输入',
      '先确认品牌资料、目标受众和输出范围。',
      '## 操作步骤',
      '1. 确认目标与资料。',
      '2. 生成方案并检查事实。',
      '3. 按用户偏好输出成品。',
      '## 注意事项',
      '资料不足时明确标注，不编造品牌事实。',
      '## 输出与验收',
      '输出可直接使用的方案和文件位置。',
    ].join('\n'),
    ...overrides,
  };
}

describe('autoSkillQuality', () => {
  it('用跨天证据、失败经验和结构完整性计算可解释评分', () => {
    const result = assessAutoSkillCandidate(candidate());

    expect(result.qualityScore).toBeGreaterThanOrEqual(80);
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.evidence.join('\n')).toContain('跨 4 天');
    expect(result.failureLessons).toContain('缺少品牌色导致返工');
    expect(result.rejectionReasons).toEqual([]);
  });

  it('拒绝一次性、空泛且无法执行的候选', () => {
    const result = assessAutoSkillCandidate(candidate({
      occurrenceCount: 1,
      sampleEntries: [log(1)],
      triggerPatterns: [],
      skillContent: '写一个方案。',
    }));

    expect(result.rejectionReasons).toContain('重复次数不足 3 次');
    expect(result.rejectionReasons).toContain('尚未跨至少 2 天复现');
    expect(result.rejectionReasons).toContain('缺少明确触发意图');
  });

  it('按质量排序并过滤与现有 Skill 或候选高度重复的建议', () => {
    const duplicate = candidate({
      name: 'auto-marketing-plan',
      description: '复用品牌营销方案的结构、校验与交付流程',
    });
    const distinct = candidate({
      name: 'auto-meeting-minutes',
      description: '会议录音转写、行动项提取和纪要交付流程',
      detectedPattern: '会议纪要整理',
      triggerPatterns: ['整理会议纪要', '提取会议行动项'],
      sampleEntries: [
        { ...log(1), action: '整理会议纪要', taskTitle: '会议纪要', userInput: '整理会议录音' },
        { ...log(2), action: '整理会议纪要', taskTitle: '会议纪要', userInput: '提取会议行动项' },
        { ...log(3), action: '整理会议纪要', taskTitle: '会议纪要', userInput: '输出会议纪要' },
      ],
    });
    const result = rankAutoSkillCandidates(
      [candidate(), duplicate, distinct],
      [{ name: 'existing-brand-workflow', summary: '品牌营销方案结构校验交付流程' }],
    );

    expect(result.map((item) => item.name)).toEqual(['auto-meeting-minutes']);
  });
});
