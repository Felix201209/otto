/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalSchedule } from '../tools/local-schedule.js';
import {
  ProactiveService,
  type ProactiveContext,
  type ProactiveRule,
} from './proactiveService.js';

const context: ProactiveContext = {
  userId: 'local-test-user',
  userName: '测试用户',
  currentDay: 'Monday',
  currentTime: '09:00',
  recentActions: [],
  pendingTasks: 0,
  hasUpcomingMeeting: false,
};

function cronRule(
  id: string,
  cron: string,
  overrides: Partial<ProactiveRule> = {},
): ProactiveRule {
  return {
    id,
    name: id,
    trigger: { type: 'cron', cron },
    action: {
      type: 'feishu_message',
      message: `${id}-message`,
      priority: 'medium',
    },
    enabled: true,
    minIntervalHours: 0,
    ...overrides,
  };
}

describe('ProactiveService 调度与日程提醒', () => {
  let tempDir: string;
  let services: ProactiveService[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('TZ', 'Asia/Shanghai');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-proactive-'));
    vi.stubEnv(
      'OTTO_SCHEDULE_FILE',
      path.join(tempDir, 'schedules.json'),
    );
    vi.stubEnv('OTTO_WORKLOG_DIR', path.join(tempDir, 'worklog'));
    services = [];
  });

  afterEach(() => {
    for (const service of services) service.stopScheduler();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function service(): ProactiveService {
    const instance = new ProactiveService();
    services.push(instance);
    return instance;
  }

  it('无论从哪一分钟启动，都能在下一个整点触发，且同一小时只触发一次', async () => {
    vi.setSystemTime(new Date('2026-07-20T02:58:30.000Z')); // 北京时间 10:58:30
    const instance = service();
    const notify = vi.fn(async () => {});
    instance.setLocalNotifier({ notify });
    instance.addRule(cronRule('arbitrary_start_cron', '0 11 * * *'));

    instance.startScheduler(() => context);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(
      notify.mock.calls.filter((call) => call[2] === 'arbitrary_start_cron'),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(
      notify.mock.calls.filter((call) => call[2] === 'arbitrary_start_cron'),
    ).toHaveLength(1);
  });

  it('支持一个 cron 小时字段中的多个小时，并允许同一天分别触发', async () => {
    const instance = service();
    instance.addRule(cronRule('multi_hour_cron', '0 10,15 * * 1-5'));

    vi.setSystemTime(new Date('2026-07-20T02:00:00.000Z')); // 北京时间周一 10:00
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).toContain('multi_hour_cron');
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).not.toContain('multi_hour_cron');

    vi.setSystemTime(new Date('2026-07-20T07:00:00.000Z')); // 北京时间周一 15:00
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).toContain('multi_hour_cron');
  });

  it('跨过本地自然日后会自动重置去重状态', async () => {
    const instance = service();
    instance.addRule(cronRule('daily_cron', '0 9 * * *'));

    vi.setSystemTime(new Date('2026-07-20T01:00:00.000Z'));
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).toContain('daily_cron');

    vi.setSystemTime(new Date('2026-07-21T01:00:00.000Z'));
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).toContain('daily_cron');
  });

  it('动态消息本次返回 null 时不会复用并发送上一次的旧消息', async () => {
    const instance = service();
    const generateMessage = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('第一天的消息')
      .mockResolvedValueOnce(null);
    instance.addRule(
      cronRule('dynamic_cron', '0 12 * * *', { generateMessage }),
    );

    vi.setSystemTime(new Date('2026-07-20T04:00:00.000Z'));
    const first = await instance.checkAndTrigger(context);
    expect(first.find((rule) => rule.id === 'dynamic_cron')?.action.message).toBe(
      '第一天的消息',
    );

    vi.setSystemTime(new Date('2026-07-21T04:00:00.000Z'));
    expect(
      (await instance.checkAndTrigger(context)).map((rule) => rule.id),
    ).not.toContain('dynamic_cron');
    expect(generateMessage).toHaveBeenCalledTimes(2);
  });

  it('日程只有时间字段时不会把正常结束的会议误报为未完成待办', async () => {
    vi.setSystemTime(new Date('2026-07-20T10:00:00.000Z')); // 北京时间 18:00
    createLocalSchedule({
      title: '已结束的评审会',
      startAt: '2026-07-20T17:00:00+08:00',
      endAt: '2026-07-20T17:30:00+08:00',
      source: 'user',
    });
    const instance = service();

    const triggered = await instance.checkAndTrigger(context);
    const insight = triggered.find(
      (rule) => rule.id === 'daily_work_insight',
    );

    expect(insight).toBeUndefined();
  });

  it('只在会议进入 10 分钟窗口后提醒，并按本地时区显示时间', async () => {
    vi.setSystemTime(new Date('2026-07-20T00:46:00.000Z')); // 北京时间 08:46
    createLocalSchedule({
      title: '北京时间会议',
      startAt: '2026-07-20T09:00:00+08:00',
      source: 'user',
    });
    const instance = service();
    const notify = vi.fn(async () => {});
    instance.setLocalNotifier({ notify });
    instance.startScheduler(() => context);

    await vi.advanceTimersByTimeAsync(60 * 1000); // 08:47，仍提前 13 分钟
    expect(
      notify.mock.calls.filter((call) =>
        String(call[2]).startsWith('meeting_reminder_'),
      ),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // 08:50，正好提前 10 分钟
    const meetingCalls = notify.mock.calls.filter((call) =>
      String(call[2]).startsWith('meeting_reminder_'),
    );
    expect(meetingCalls).toHaveLength(1);
    expect(meetingCalls[0][0]).toContain('北京时间会议');
    expect(meetingCalls[0][0]).toContain('10分钟后');
    expect(meetingCalls[0][0]).toContain('（09:00）');
  });
});
