/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shouldRefreshBuiltinSkill } from './seed-skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(
  resolve(here, '../../skills-seed/ppt-creator/SKILL.md'),
  'utf8',
);

describe('内置 ppt-creator Skill', () => {
  it('要求用 HTML 视觉画布经浏览器渲染，并由 Node 组装 PPTX', () => {
    expect(skill).toContain('HTML 是视觉画布');
    expect(skill).toMatch(/Playwright|Chromium/);
    expect(skill).toContain('PptxGenJS');
    expect(skill).toContain('逐页 PNG');
  });

  it('禁止 Python 路径，并设置非模板化审美与缩略图验收门槛', () => {
    expect(skill).toMatch(/禁止[^\n]*Python/);
    expect(skill).toContain('不要把幻灯片做成网页后台');
    expect(skill).toContain('重复卡片阵列');
    expect(skill).toContain('缩略图总览');
  });

  it('把炫酷高冲击设为默认目标，并明确禁止固定母版偷懒', () => {
    expect(skill).toContain('默认视觉目标：炫酷、高冲击、像发布会主视觉');
    expect(skill).toContain('每套演示都必须创造自己的视觉母题');
    expect(skill).toContain('禁止固定页眉');
    expect(skill).toContain('动势');
    expect(skill).toContain('景深');
  });

  it('高审美任务走自定义画布，通用生成器只能做快速兜底', () => {
    expect(skill).toContain('自定义 HTML/CSS/SVG');
    expect(skill).toContain('generate_document');
    expect(skill).toContain('仅作为快速兜底');
    expect(skill).toContain('不得把兜底结果冒充高审美成品');
  });
});

describe('内置 skill 安全刷新', () => {
  it('会刷新未改动的旧版 PPT skill 或带受管标记的副本', () => {
    expect(shouldRefreshBuiltinSkill(
      'ppt-creator',
      '1ddbafc17534762249a5323ccd5da0d46713dfc7bda27b4aa2b70993be17a3f2',
      'new-seed-hash',
    )).toBe(true);
    expect(shouldRefreshBuiltinSkill(
      'ppt-creator',
      'managed-current-hash',
      'new-seed-hash',
      'managed-current-hash',
    )).toBe(true);
  });

  it('不会覆盖用户改过的 skill，也不会重复刷新同一版本', () => {
    expect(shouldRefreshBuiltinSkill(
      'ppt-creator',
      'user-customized-hash',
      'new-seed-hash',
    )).toBe(false);
    expect(shouldRefreshBuiltinSkill(
      'ppt-creator',
      'same-hash',
      'same-hash',
      'same-hash',
    )).toBe(false);
  });
});
