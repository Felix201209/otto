/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { RightPanel } from './RightPanel.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

function installBridge() {
  const openPath = vi.fn(async () => undefined);
  const workLogReport = vi.fn(async () => ({
    ok: true,
    date: '2026-07-10',
    title: '市场竞品调研报告',
    markdown: '# 市场竞品调研报告\n\n已完成对比。',
    path: '/tmp/2026-07-10-市场竞品调研报告.md',
    message: '已生成并保存「市场竞品调研报告」',
  }));
  (window as unknown as { otto: unknown }).otto = {
    parkConfig: async () => null,
    workLogRecent: async () => [],
    workLogToday: async () => ({
      summary: '今天还没有工作记录。',
      date: '2026-07-10',
      totalActions: 0,
      workResults: 0,
    }),
    workLogReport,
    openPath,
  };
  return { openPath, workLogReport };
}

describe('RightPanel 企业工作入口', () => {
  it('吉祥物活动区固定在 tab 外，切换面板后仍保持唯一实例', () => {
    installBridge();
    render(<RightPanel busy={false} onLaunchExpert={vi.fn()} onOpenAgents={vi.fn()} />);
    expect(
      screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: '笔记' }));
    expect(
      screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }),
    ).toHaveLength(1);
  });

  it('隐藏尚未形成数据闭环的 Skill/排行榜入口', () => {
    installBridge();
    render(<RightPanel busy={false} onLaunchExpert={vi.fn()} onOpenAgents={vi.fn()} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '专家',
      '工具',
      '记忆',
      '笔记',
      '工作日志',
    ]);
  });

  it('一键生成报告后显示真实保存结果并可打开文件', async () => {
    const { openPath, workLogReport } = installBridge();
    render(<RightPanel busy={false} onLaunchExpert={vi.fn()} onOpenAgents={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    fireEvent.click(
      screen.getByRole('button', { name: '总结当下工作 → 生成报告' }),
    );

    expect(workLogReport).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/已生成并保存「市场竞品调研报告」/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开已生成报告' }));
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith(
        '/tmp/2026-07-10-市场竞品调研报告.md',
      ),
    );
  });
});
