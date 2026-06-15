/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { clampCodeBlock } from './feishuToolDisplay.js';

/**
 * clampCodeBlock — 飞书工具卡片代码框的统一体积裁剪。
 *
 * 背景：飞书单卡片容量约 30KB（安全阈值 8500 字符）。一个 replace 工具如果
 * 把完整 diff 全量渲染，单个工具块就能撑爆整张卡片、被迫分页。本函数对任意
 * 代码框内容施加「行数 + 字符数」双重上限，超限时保留头部并追加省略提示。
 *
 * 规则：
 *   - 行数超过 maxLines → 只保留前 maxLines 行，并附带「… 还有 N 行」提示
 *   - 即便行数没超，总字符数超过 maxChars → 硬截断到 maxChars 并附省略号
 *   - 末尾不带多余空行（交给调用方包裹 ``` 代码框）
 */
describe('clampCodeBlock', () => {
  it('returns content unchanged when within both limits', () => {
    const out = clampCodeBlock('a\nb\nc', { maxLines: 15, maxChars: 2000 });
    expect(out.text).toBe('a\nb\nc');
    expect(out.truncated).toBe(false);
    expect(out.omittedLines).toBe(0);
  });

  it('truncates by line count and reports omitted lines', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const out = clampCodeBlock(lines.join('\n'), { maxLines: 15, maxChars: 100000 });
    expect(out.truncated).toBe(true);
    expect(out.omittedLines).toBe(25);
    // 只保留前 15 行
    expect(out.text.split('\n').slice(0, 15)).toEqual(lines.slice(0, 15));
    // 含省略提示（含剩余行数）
    expect(out.text).toMatch(/25/);
  });

  it('hard-truncates by char count even when line count is fine', () => {
    // 3 行但每行超长，总字符数远超 maxChars
    const huge = ['x'.repeat(5000), 'y'.repeat(5000), 'z'.repeat(5000)].join('\n');
    const out = clampCodeBlock(huge, { maxLines: 15, maxChars: 2000 });
    expect(out.truncated).toBe(true);
    // 截断后正文（不含提示行）不应超过 maxChars
    expect(out.text.length).toBeLessThanOrEqual(2000 + 80); // 容许提示行附加长度
  });

  it('handles empty input', () => {
    const out = clampCodeBlock('', { maxLines: 15, maxChars: 2000 });
    expect(out.text).toBe('');
    expect(out.truncated).toBe(false);
  });

  it('applies char limit after line limit (line-clamped result still char-checked)', () => {
    // 20 行，前 15 行就已经超 maxChars
    const lines = Array.from({ length: 20 }, () => 'a'.repeat(400));
    const out = clampCodeBlock(lines.join('\n'), { maxLines: 15, maxChars: 2000 });
    expect(out.truncated).toBe(true);
    // 既因行数被裁，也因字符数被进一步硬截
    expect(out.text.length).toBeLessThanOrEqual(2000 + 80);
  });

  it('uses sensible defaults when options omitted', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
    const out = clampCodeBlock(lines.join('\n'));
    expect(out.truncated).toBe(true);
    // 默认行数上限应小于 100，触发裁剪
    expect(out.text.split('\n').length).toBeLessThan(100);
  });
});
