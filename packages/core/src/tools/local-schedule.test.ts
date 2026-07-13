/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LocalScheduleTool,
  createLocalSchedule,
  deleteLocalSchedule,
  listLocalSchedules,
  updateLocalSchedule,
} from './local-schedule.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-schedule-'));
  vi.stubEnv('OTTO_SCHEDULE_FILE', path.join(tempDir, 'schedules.json'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('本地日程数据层', () => {
  it('创建后可按指定时区的日期查询，并保留 Otto 自动创建原因', () => {
    const created = createLocalSchedule({
      title: '竞品调研复盘',
      startAt: '2026-07-12T01:30:00.000Z',
      endAt: '2026-07-12T02:00:00.000Z',
      source: 'otto',
      reason: '调研报告已经完成，安排复盘',
    });

    expect(created.id).toBeTruthy();
    expect(listLocalSchedules('2026-07-12', 'Asia/Shanghai')).toEqual([
      expect.objectContaining({
        title: '竞品调研复盘',
        source: 'otto',
        reason: '调研报告已经完成，安排复盘',
      }),
    ]);
    expect(listLocalSchedules('2026-07-11', 'Asia/Shanghai')).toEqual([]);
  });

  it('拒绝结束时间早于开始时间', () => {
    expect(() =>
      createLocalSchedule({
        title: '错误日程',
        startAt: '2026-07-12T02:00:00.000Z',
        endAt: '2026-07-12T01:00:00.000Z',
        source: 'user',
      }),
    ).toThrow(/结束时间/);
  });

  it('支持更新和删除，重复删除保持幂等', () => {
    const created = createLocalSchedule({
      title: '初稿评审',
      startAt: '2026-07-12T01:30:00.000Z',
      source: 'user',
    });
    const updated = updateLocalSchedule(created.id, { title: '终稿评审' });

    expect(updated.title).toBe('终稿评审');
    expect(deleteLocalSchedule(created.id)).toBe(true);
    expect(deleteLocalSchedule(created.id)).toBe(false);
  });
});

describe('local_schedule 工具', () => {
  const config = {} as ConstructorParameters<typeof LocalScheduleTool>[0];

  it('Otto 可自主创建日程，并返回结构化结果', async () => {
    const tool = new LocalScheduleTool(config);
    const result = await tool.execute(
      {
        action: 'create',
        title: '客户访谈准备',
        startAt: '2026-07-12T08:00:00+08:00',
        endAt: '2026-07-12T08:30:00+08:00',
        reason: '访谈前需要整理问题清单',
      },
      new AbortController().signal,
    );

    expect(result.llmContent).toContain('客户访谈准备');
    expect(listLocalSchedules('2026-07-12', 'Asia/Shanghai')[0]).toMatchObject({
      source: 'otto',
      reason: '访谈前需要整理问题清单',
    });
  });

  it('list 不要求标题，create 缺少标题则校验失败', () => {
    const tool = new LocalScheduleTool(config);

    expect(tool.validateToolParams({ action: 'list', date: '2026-07-12' })).toBeNull();
    expect(
      tool.validateToolParams({
        action: 'create',
        startAt: '2026-07-12T08:00:00+08:00',
      }),
    ).toContain('title');
  });
});
