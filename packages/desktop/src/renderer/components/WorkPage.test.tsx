/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkPage } from './WorkPage.js';
import { WorkLogCalendar } from './WorkLogCalendar.js';
import { localDateKey } from '../localDateKey.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

function installBridge() {
  const date = localDateKey();
  const previous = new Date();
  previous.setDate(previous.getDate() - 1);
  const workLogRecent = vi.fn(async () => [
    {
      date,
      entries: [
        {
          time: '09:30',
          category: 'document',
          action: '生成调研报告',
          success: true,
          entryType: 'work_result',
          details: '完成宏创园区竞品数据对比与结论。',
          taskTitle: '市场竞品调研报告',
        },
        {
          time: '14:20',
          category: 'calendar',
          action: '安排复盘日程',
          success: false,
          entryType: 'tool',
        },
      ],
    },
    { date: localDateKey(previous), entries: [] },
  ]);
  const workLogReport = vi.fn(async () => ({
    ok: true,
    date,
    title: '市场竞品调研报告',
    markdown: '# 市场竞品调研报告',
    path: '/tmp/市场竞品调研报告.md',
    message: '已生成并保存「市场竞品调研报告」',
  }));
  const openPath = vi.fn(async () => undefined);
  (window as unknown as { otto: unknown }).otto = {
    workLogToday: async () => ({
      summary: '共记录 2 条工作日志。',
      date,
      totalActions: 1,
      workResults: 1,
    }),
    workLogRecent,
    workLogReport,
    openPath,
  };
  return {
    date,
    previousDate: localDateKey(previous),
    workLogRecent,
    workLogReport,
    openPath,
  };
}

function renderPage(onSelectDate = vi.fn()) {
  const date = localDateKey();
  render(
    <WorkPage
      schedules={[]}
      selectedDate={date}
      onSelectDate={onSelectDate}
      onCreateSchedule={vi.fn()}
      onDeleteSchedule={vi.fn()}
      onBack={vi.fn()}
    />,
  );
  return { date, onSelectDate };
}

describe('WorkPage', () => {
  it('owns the work calendar and selects a date from the agenda view', async () => {
    const { date, workLogRecent } = installBridge();
    const onSelectDate = vi.fn();
    renderPage(onSelectDate);

    await waitFor(() => expect(workLogRecent).toHaveBeenCalledWith(92));
    fireEvent.click(screen.getByRole('tab', { name: '日程' }));

    expect(screen.getByRole('region', { name: '工作月历' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回总览' })).toBeTruthy();
    const day = screen.getByRole('button', { name: `${date}，2 条工作记录` });
    expect(day.getAttribute('title')).toBe(
      '• 09:30 生成调研报告\n• 14:20 安排复盘日程',
    );
    const tooltip = screen.getByRole('tooltip').textContent ?? '';
    expect(tooltip).toContain('• 完成 · 生成调研报告');
    expect(tooltip).toContain('完成宏创园区竞品数据对比与结论。');
    expect(tooltip).toContain('• calendar · 安排复盘日程（失败）');

    fireEvent.click(day);
    expect(onSelectDate).toHaveBeenCalledWith(date);
  });

  it('generates and opens the report from the single work entry point', async () => {
    const { workLogReport, openPath } = installBridge();
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: '生成今日总结' }));
    expect(workLogReport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已生成并保存「市场竞品调研报告」')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '打开总结文件' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/tmp/市场竞品调研报告.md'));
  });

  it('opens a recent work day in the shared agenda view', async () => {
    const { previousDate } = installBridge();
    const onSelectDate = vi.fn();
    renderPage(onSelectDate);

    const recentDay = await screen.findByRole('button', { name: new RegExp(previousDate) });
    fireEvent.click(recentDay);

    expect(onSelectDate).toHaveBeenCalledWith(previousDate);
    expect(screen.getByRole('tab', { name: '日程' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: '工作月历' })).toBeTruthy();
  });

  it('keeps worklog popovers inside the calendar at both horizontal edges', () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const mondayDay = 1 + ((7 - firstWeekday) % 7);
    const sundayDay = 1 + ((6 - firstWeekday + 7) % 7);
    const keyFor = (day: number): string =>
      `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const leftDate = keyFor(mondayDay);
    const rightDate = keyFor(sundayDay);

    const { container } = render(
      <WorkLogCalendar
        selectedDate={localDateKey(now)}
        onSelectDate={vi.fn()}
        byDate={{
          [leftDate]: [{ time: '09:00', action: '左侧成果', entryType: 'work_result' }],
          [rightDate]: [{ time: '18:00', action: '右侧成果', entryType: 'work_result' }],
        }}
      />,
    );

    expect(container.querySelector(`button[aria-label^="${leftDate}"]`)?.className)
      .toContain('is-pop-left');
    expect(container.querySelector(`button[aria-label^="${rightDate}"]`)?.className)
      .toContain('is-pop-right');
  });
});
