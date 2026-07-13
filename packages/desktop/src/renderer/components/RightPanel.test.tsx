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
import type { ProductWorkspaceSnapshot } from 'otto-server';
import { RightPanel } from './RightPanel.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

function installBridge(recent: Array<{
  date: string;
  entries: Array<{
    time: string;
    category: string;
    action: string;
    success: boolean;
    entryType: 'tool' | 'work_result';
    details?: string;
    taskTitle?: string;
  }>;
}> = []) {
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
    workLogRecent: async () => recent,
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

function enterpriseWorkspace(): ProductWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    context: {
      edition: 'enterprise',
      role: 'company_owner',
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      capabilities: [
        'agent:base', 'model:otto', 'skill:built-in', 'skill:auto-create',
        'skill:market', 'organization:read', 'organization:manage',
        'invite:issue', 'schedule:write', 'billing:read', 'billing:manage',
      ],
    },
    managerWorkspace: {
      profile: {
        managerId: 'owner-1',
        managerName: 'Felix',
        companyName: '宏创 AI',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
      context: {
        edition: 'enterprise', role: 'company_owner', userId: 'owner-1',
        companyId: 'company-1', capabilities: [],
      },
      organization: {
        rootCompanyId: 'company-1',
        companies: [{ id: 'company-1', name: '宏创 AI', ownerUserId: 'owner-1' }],
        departments: [{ id: 'dept-1', companyId: 'company-1', name: 'CEO 办公室' }],
        positions: [{ id: 'position-1', companyId: 'company-1', departmentId: 'dept-1', title: 'CEO', incumbentUserId: 'owner-1' }],
      },
    },
    members: [{
      userId: 'owner-1', displayName: 'Felix', companyId: 'company-1',
      departmentId: 'dept-1', positionId: 'position-1', role: 'company_owner',
    }],
    friends: [],
    credits: { balance: 0, frozen: 0, status: 'design-preview' },
  };
}

describe('RightPanel v1.7 工作入口', () => {
  it('两种版本都恢复 v1.6 的园区服务与企业 AI 自主开发入口', async () => {
    installBridge();
    const launch = vi.fn();
    const parkOpen = vi.fn();
    window.addEventListener('otto:open-park-services', parkOpen, { once: true });

    render(<RightPanel busy={false} onLaunchAgentProfile={launch} />);

    const parkCard = (await screen.findByText('宏创AI园区服务')).closest('button');
    expect(parkCard).toBeTruthy();
    fireEvent.click(parkCard!);
    expect(parkOpen).toHaveBeenCalledTimes(1);

    const devCard = screen.getByTitle('写代码 · 改项目 · 自动化任务');
    expect(devCard).toBeTruthy();
    fireEvent.click(devCard!);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'self-development',
        name: '企业AI自主开发',
      }),
      expect.stringContaining('企业AI自主开发'),
    );
  });

  it('工具面板恢复 v1.6 的飞书状态与多渠道快捷项', () => {
    installBridge();
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工具' }));
    expect(screen.getByText('/feishu-status')).toBeTruthy();
    expect(screen.getByText('/multi-channel')).toBeTruthy();
    expect(screen.getByText('点击把命令填入输入框，回车执行')).toBeTruthy();
  });

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

  it('个人版隐藏企业记忆、Skill 市场和企业好友，并只保留基础入口', () => {
    installBridge();
    render(<RightPanel busy={false} onLaunchExpert={vi.fn()} onOpenAgents={vi.fn()} />);
    expect(screen.queryByText(/不会自动发送长消息/)).toBeNull();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '专家',
      '工具',
      '笔记',
      '工作日志',
    ]);
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('Word 公文撰写')).toBeTruthy();
    expect(screen.getByText('Excel 数据表格')).toBeTruthy();
    expect(screen.getByText('市场竞品调研')).toBeTruthy();
    expect(screen.queryByText('企业记忆')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skill 专区' })).toBeNull();
    expect(screen.queryByRole('button', { name: /企业与好友/ })).toBeNull();
  });

  it('企业版将 Skill 专区和企业/好友收进底部可折叠入口', () => {
    installBridge();
    const openSkillZone = vi.fn();
    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
        onOpenSkillZone={openSkillZone}
      />,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '专家', '工具', '企业记忆', '笔记', '工作日志',
    ]);
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('品牌营销文案')).toBeTruthy();
    expect(screen.getByText('CEO Agent')).toBeTruthy();
    expect(screen.queryByText('Otto')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Skill 专区' }));
    expect(openSkillZone).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole('button', { name: /企业与好友/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('宏创 AI')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('个人版自动 Skill 候选需要用户明确确认或拒绝', () => {
    installBridge();
    const confirm = vi.fn();
    const reject = vi.fn();
    render(
      <RightPanel
        busy={false}
        autoSkillCandidates={[{
          id: 'candidate-1',
          name: 'auto-report',
          description: '重复报告流程',
          detectedPattern: '整理数据 → 生成报告',
          occurrenceCount: 3,
          reason: '连续三天重复',
        }]}
        onConfirmAutoSkill={confirm}
        onRejectAutoSkill={reject}
      />,
    );
    expect(screen.getByText('重复报告流程')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认生成' }));
    fireEvent.click(screen.getByRole('button', { name: '不再建议' }));
    expect(confirm).toHaveBeenCalledWith('candidate-1');
    expect(reject).toHaveBeenCalledWith('candidate-1');
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

  it('日历悬浮文案按点列出当天全部工作日志', async () => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    installBridge([{
      date,
      entries: [
        {
          time: '09:30',
          category: 'document',
          action: '生成调研报告',
          success: true,
          entryType: 'work_result',
          details: '完成宏创园区竞品数据对比与结论。',
        },
        { time: '14:20', category: 'calendar', action: '安排复盘日程', success: false, entryType: 'tool' },
      ],
    }]);
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    const day = screen.getByRole('button', { name: String(now.getDate()) });
    await waitFor(() => expect(day.getAttribute('title')).toBe(
      '• 09:30 生成调研报告\n• 14:20 安排复盘日程',
    ));
    const tooltipText = screen.getByRole('tooltip').textContent ?? '';
    expect(tooltipText).toContain('成果 生成调研报告');
    expect(tooltipText).toContain('完成宏创园区竞品数据对比与结论。');
    expect(tooltipText).toContain('[calendar] 安排复盘日程（失败）');
  });
});
