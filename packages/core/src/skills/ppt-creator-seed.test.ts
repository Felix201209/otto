/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
