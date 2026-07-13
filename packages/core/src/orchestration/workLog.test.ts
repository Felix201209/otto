/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WorkLogger,
  formatLocalDate,
  resolveDefaultWorklogDir,
} from './workLog.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('WorkLogger 工作结果日志', () => {
  it('测试和企业自定义目录不会污染真实 ~/.otto-user', () => {
    const oldWorklog = process.env['OTTO_WORKLOG_DIR'];
    const oldUserDir = process.env['OTTO_USER_DIR'];
    const oldVitest = process.env['VITEST'];
    try {
      process.env['OTTO_WORKLOG_DIR'] = '/tmp/otto-explicit-worklog';
      expect(resolveDefaultWorklogDir()).toBe('/tmp/otto-explicit-worklog');
      delete process.env['OTTO_WORKLOG_DIR'];
      process.env['OTTO_USER_DIR'] = '/tmp/otto-user-test';
      expect(resolveDefaultWorklogDir()).toBe(
        path.join('/tmp/otto-user-test', 'memory', 'worklog'),
      );
      delete process.env['OTTO_USER_DIR'];
      process.env['VITEST'] = 'true';
      expect(resolveDefaultWorklogDir()).toContain(
        path.join('otto-worklog-tests', String(process.pid)),
      );
    } finally {
      if (oldWorklog === undefined) delete process.env['OTTO_WORKLOG_DIR'];
      else process.env['OTTO_WORKLOG_DIR'] = oldWorklog;
      if (oldUserDir === undefined) delete process.env['OTTO_USER_DIR'];
      else process.env['OTTO_USER_DIR'] = oldUserDir;
      if (oldVitest === undefined) delete process.env['VITEST'];
      else process.env['VITEST'] = oldVitest;
    }
  });

  it('按本地日期落盘，而不是按 UTC 日期错位', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-worklog-'));
    tempDirs.push(root);
    const lateLocalTime = new Date(2026, 6, 10, 23, 30, 0);
    const logger = new WorkLogger(root, () => lateLocalTime);

    await logger.log({
      toolName: 'otto_work_result',
      action: '市场竞品调研',
      category: 'web',
      success: true,
      entryType: 'work_result',
      taskTitle: '市场竞品调研',
      userInput: '调研三家竞品并给出结论',
      details: '已完成三家竞品的功能、价格和定位对比。',
      sessionId: 'session-1',
    });

    expect(formatLocalDate(lateLocalTime)).toBe('2026-07-10');
    const entries = await logger.readDay('2026-07-10');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: 'work_result',
      taskTitle: '市场竞品调研',
      userInput: '调研三家竞品并给出结论',
      details: '已完成三家竞品的功能、价格和定位对比。',
    });
  });
});
