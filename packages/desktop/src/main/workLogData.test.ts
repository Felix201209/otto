/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAndSaveWorkReport } from './workLogData.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-worklog-report-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('generateAndSaveWorkReport', () => {
  it('生成可直接打开的 HTML 今日总结，并保留结构化文本预览', async () => {
    const date = '2026-07-20';
    const dailyDir = path.join(tempDir, 'daily');
    await fs.mkdir(dailyDir, { recursive: true });
    const entries = [
      {
        timestamp: `${date}T09:57:00.000Z`,
        toolName: 'read_file',
        action: '读取会议录音',
        category: 'file',
        success: true,
        details: '文件较大，先识别为会议材料。',
        entryType: 'tool',
      },
      {
        timestamp: `${date}T11:43:00.000Z`,
        toolName: 'doc_writer',
        action: '给我生成一份前沿AI科技报告',
        category: 'document',
        success: true,
        userInput: '给我生成一份前沿AI科技报告',
        taskTitle: '前沿AI科技报告',
        details: '完成报告正文、建议章节与后续检查事项。',
        entryType: 'work_result',
      },
    ];
    await fs.writeFile(
      path.join(dailyDir, `${date}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join('\n'),
      'utf8',
    );

    const report = await generateAndSaveWorkReport(tempDir, date);

    expect(report.ok).toBe(true);
    expect(report.path.endsWith('.html')).toBe(true);
    expect(report.markdown).toContain('## 今日概览');
    expect(report.markdown).toContain('## 重点成果');
    const html = await fs.readFile(report.path, 'utf8');
    expect(html).toContain('<h2>今日概览</h2>');
    expect(html).toContain('前沿AI科技报告');
  });
});
