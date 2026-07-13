/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayAgenda } from './DayAgenda.js';

afterEach(cleanup);

describe('DayAgenda', () => {
  it('按时间展示日程，并明确标出 Otto 自主创建原因', () => {
    render(
      <DayAgenda
        date="2026-07-12"
        schedules={[{
          id: 'schedule-1',
          title: '整理竞品调研',
          startAt: '2026-07-12T01:00:00.000Z',
          source: 'otto',
          reason: '调研报告已完成，需要安排复盘',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }]}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText('整理竞品调研')).toBeTruthy();
    expect(screen.getByText('Otto 自主创建')).toBeTruthy();
    expect(screen.getByText('创建原因：调研报告已完成，需要安排复盘')).toBeTruthy();
  });

  it('手动新增当天日程时提交结构化时间，而非聊天文本', () => {
    const onCreate = vi.fn();
    render(
      <DayAgenda
        date="2026-07-12"
        schedules={[]}
        onCreate={onCreate}
        onDelete={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '+ 新建日程' }));
    fireEvent.change(screen.getByLabelText('日程标题'), { target: { value: '周会' } });
    fireEvent.change(screen.getByLabelText('日程备注'), { target: { value: '同步本周进度' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      title: '周会',
      notes: '同步本周进度',
    });
    expect(Number.isNaN(new Date(onCreate.mock.calls[0][0].startAt).getTime())).toBe(false);
  });
});
