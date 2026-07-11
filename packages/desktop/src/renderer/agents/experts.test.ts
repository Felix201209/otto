/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 企业专家目录的结构性单测：保证目录自洽（数量/唯一性/必填字段），并守住一条关键契约——
 * 每个专家的开场消息（kickoff）必须点名它绑定的每个技能，Agent 才会去 use_skill 加载。
 */

import { describe, it, expect } from 'vitest';
import { EXPERTS } from './experts.js';

describe('企业专家目录', () => {
  it('恰好 8 位专家', () => {
    expect(EXPERTS).toHaveLength(8);
  });

  it('id 唯一、生成图标唯一', () => {
    const ids = EXPERTS.map((e) => e.id);
    const icons = EXPERTS.map((e) => e.icon);
    expect(new Set(ids).size).toBe(EXPERTS.length);
    expect(new Set(icons).size).toBe(EXPERTS.length);
  });

  it('每位专家必填字段齐备（名称/卖点/头像/主题色/技能/开场）', () => {
    for (const e of EXPERTS) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.trim().length).toBeGreaterThan(0);
      expect(e.tagline.trim().length).toBeGreaterThan(0);
      expect(e.icon).toMatch(/^expert-/);
      expect(e.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(e.skills.length).toBeGreaterThanOrEqual(1);
      expect(e.kickoff.trim().length).toBeGreaterThan(0);
    }
  });

  it('技能名合法（小写字母/数字/连字符，匹配 SKILL.md 命名规则）', () => {
    for (const e of EXPERTS) {
      for (const s of e.skills) {
        expect(s).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('开场消息点名了每个绑定技能（确保 Agent 会 use_skill 加载它）', () => {
    for (const e of EXPERTS) {
      for (const s of e.skills) {
        expect(e.kickoff).toContain(s);
      }
      // 开场消息应显式要求加载技能。
      expect(e.kickoff).toContain('use_skill');
    }
  });
});
