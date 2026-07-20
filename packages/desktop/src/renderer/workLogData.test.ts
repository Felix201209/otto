/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateAndSaveWorkReport,
  localDateKey,
  readRecentWorkLogs,
  summarizeWorkLog,
  type StoredWorkLogEntry,
} from '../main/workLogData.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function makeWorklog(entries: StoredWorkLogEntry[]): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'otto-desktop-worklog-'),
  );
  tempDirs.push(root);
  const daily = path.join(root, 'daily');
  await fs.mkdir(daily, { recursive: true });
  await fs.writeFile(
    path.join(daily, '2026-07-10.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
  return root;
}

describe('桌面工作日志数据闭环', () => {
  it('按本地日历读取，并在悬浮明细中保留最终产出摘要', async () => {
    const root = await makeWorklog([
      {
        timestamp: '2026-07-10T06:30:00.000Z',
        toolName: 'otto_work_result',
        action: '市场竞品调研',
        category: 'web',
        success: true,
        entryType: 'work_result',
        taskTitle: '市场竞品调研',
        userInput: '调研三家竞品并给出结论',
        details: '已完成三家竞品的价格、功能和定位对比。',
      },
    ]);

    const localDay = new Date(2026, 6, 10, 23, 30, 0);
    expect(localDateKey(localDay)).toBe('2026-07-10');
    const days = await readRecentWorkLogs(root, 1, localDay);
    expect(days).toEqual([
      {
        date: '2026-07-10',
        entries: [
          expect.objectContaining({
            action: '市场竞品调研',
            taskTitle: '市场竞品调研',
            details: '已完成三家竞品的价格、功能和定位对比。',
            entryType: 'work_result',
          }),
        ],
      },
    ]);
  });

  it('一键生成有业务标题的报告并真实保存到 summaries', async () => {
    const entries: StoredWorkLogEntry[] = [
      {
        timestamp: '2026-07-10T09:00:00.000Z',
        toolName: 'read_file',
        action: '读取竞品资料',
        category: 'file',
        success: true,
      },
      {
        timestamp: '2026-07-10T09:30:00.000Z',
        toolName: 'otto_work_result',
        action: '市场竞品调研',
        category: 'web',
        success: true,
        entryType: 'work_result',
        taskTitle: '市场竞品调研',
        userInput: '调研三家竞品并给出结论',
        details: '完成价格、功能、定位三方面对比，建议优先突出企业知识沉淀。',
      },
    ];
    const root = await makeWorklog(entries);

    const summary = summarizeWorkLog('2026-07-10', entries);
    expect(summary.summary).toContain('工作成果：1 项');

    const report = await generateAndSaveWorkReport(root, '2026-07-10');
    expect(report.ok).toBe(true);
    expect(report.title).toBe('市场竞品调研报告');
    expect(report.markdown).toContain('# 市场竞品调研报告');
    expect(report.markdown).toContain('建议优先突出企业知识沉淀');
    expect(report.path).toContain(
      path.join('summaries', '2026-07-10-市场竞品调研报告.html'),
    );
    await expect(fs.readFile(report.path, 'utf8')).resolves.toBe(
      report.html,
    );
  });
});
