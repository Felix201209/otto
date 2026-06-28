/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * parseDiff 纯函数单测：unified diff → 带行号的行数组 + 增删计数。
 * 覆盖 hunk 行号推进、add/del/context 计数、元信息跳过、空/无 hunk 兜底、\r\n 归一化。
 */

import { describe, it, expect } from 'vitest';
import { parseDiff } from './diff.js';

describe('parseDiff', () => {
  it('空串 → 空 lines + 0 计数', () => {
    expect(parseDiff('')).toEqual({ lines: [], stats: { added: 0, removed: 0 } });
  });

  it('标准 unified diff：hunk 头解析起始行号 + 增删计数', () => {
    const raw = [
      '@@ -10,3 +10,4 @@',
      ' context line',
      '-removed line',
      '+added line 1',
      '+added line 2',
    ].join('\n');
    const { lines, stats } = parseDiff(raw);
    expect(stats).toEqual({ added: 2, removed: 1 });

    const hunk = lines.find((l) => l.type === 'hunk');
    expect(hunk).toBeDefined();

    const ctx = lines.find((l) => l.type === 'context');
    expect(ctx?.oldLine).toBe(10);
    expect(ctx?.newLine).toBe(10);

    const del = lines.find((l) => l.type === 'del');
    expect(del?.oldLine).toBe(11);
    expect(del?.newLine).toBeUndefined();

    const adds = lines.filter((l) => l.type === 'add');
    expect(adds[0].newLine).toBe(11);
    expect(adds[1].newLine).toBe(12);
    expect(adds[0].oldLine).toBeUndefined();
  });

  it('行号推进：context 双推、del 只推 old、add 只推 new', () => {
    const raw = [
      '@@ -1,4 +1,4 @@',
      ' a', // old1 new1
      '-b', // old2
      '+B', // new2
      ' c', // old3 new3
    ].join('\n');
    const { lines } = parseDiff(raw);
    const body = lines.filter((l) => l.type !== 'hunk');
    // a: context old1/new1
    expect(body[0]).toMatchObject({ type: 'context', oldLine: 1, newLine: 1 });
    // b: del old2
    expect(body[1]).toMatchObject({ type: 'del', oldLine: 2 });
    // B: add new2
    expect(body[2]).toMatchObject({ type: 'add', newLine: 2 });
    // c: context old3/new3
    expect(body[3]).toMatchObject({ type: 'context', oldLine: 3, newLine: 3 });
  });

  it('hunk 头无 count（@@ -5 +5 @@）也能解析起始行号', () => {
    const raw = ['@@ -5 +7 @@', ' x'].join('\n');
    const { lines } = parseDiff(raw);
    const ctx = lines.find((l) => l.type === 'context');
    expect(ctx?.oldLine).toBe(5);
    expect(ctx?.newLine).toBe(7);
  });

  it('元信息行（---/+++/diff --git/index）被跳过', () => {
    const raw = [
      'diff --git a/f.ts b/f.ts',
      'index 111..222 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');
    const { lines, stats } = parseDiff(raw);
    // 不应有 meta 行混进（元信息全跳过），只剩 hunk + add + del
    expect(lines.some((l) => l.content.startsWith('diff --git'))).toBe(false);
    expect(lines.some((l) => l.content.startsWith('---'))).toBe(false);
    expect(stats).toEqual({ added: 1, removed: 1 });
  });

  it('无 hunk 头的裸文本 → 每行当 context，不丢内容', () => {
    const raw = ['just some', 'plain text'].join('\n');
    const { lines, stats } = parseDiff(raw);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.type === 'context')).toBe(true);
    expect(lines[0].content).toBe('just some');
    expect(stats).toEqual({ added: 0, removed: 0 });
  });

  it('\\r\\n 被归一化', () => {
    const raw = '@@ -1,1 +1,1 @@\r\n-old\r\n+new';
    const { lines, stats } = parseDiff(raw);
    expect(stats).toEqual({ added: 1, removed: 1 });
    const add = lines.find((l) => l.type === 'add');
    expect(add?.content).toBe('new'); // 无尾随 \r
  });

  it('内容去掉前缀符号', () => {
    const { lines } = parseDiff('@@ -1,1 +1,1 @@\n+hello');
    const add = lines.find((l) => l.type === 'add');
    expect(add?.content).toBe('hello');
  });
});
