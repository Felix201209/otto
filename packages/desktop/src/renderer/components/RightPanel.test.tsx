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
import { BASE_AGENT_PROFILES } from '../agents/departmentAgents.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

interface TestWorkLogEntry {
  time: string;
  category: string;
  action: string;
  success: boolean;
  entryType: 'tool' | 'work_result';
  details?: string;
  taskTitle?: string;
}

interface TestWorkLogDay {
  date: string;
  entries: TestWorkLogEntry[];
}

function installBridge(
  recent: TestWorkLogDay[] | (() => Promise<TestWorkLogDay[]>) = [],
) {
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
    workLogRecent: typeof recent === 'function' ? recent : async () => recent,
    workLogToday: async () => ({
      summary: '今天还没有工作记录。',
      date: '2026-07-10',
      totalActions: 0,
      workResults: 0,
    }),
    enterpriseKnowledgeList: async () => [],
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
        'agent:base',
        'model:otto',
        'skill:built-in',
        'skill:auto-create',
        'organization:read',
        'organization:manage',
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
        edition: 'enterprise',
        role: 'company_owner',
        userId: 'owner-1',
        companyId: 'company-1',
        capabilities: [],
      },
      organization: {
        rootCompanyId: 'company-1',
        companies: [{ id: 'company-1', name: '宏创 AI', ownerUserId: 'owner-1' }],
        departments: [{ id: 'dept-1', companyId: 'company-1', name: 'CEO 办公室' }],
        positions: [{
          id: 'position-1',
          companyId: 'company-1',
          departmentId: 'dept-1',
          title: 'CEO',
          incumbentUserId: 'owner-1',
        }],
      },
    },
    members: [{
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      departmentId: 'dept-1',
      positionId: 'position-1',
      role: 'company_owner',
    }],
    friends: [],
    credits: { balance: 0, frozen: 0, status: 'design-preview' },
  };
}

describe('RightPanel fixed Agent catalog', () => {
  it('keeps the fixed 9 enterprise Agents out of personal mode', () => {
    installBridge();

    const { container } = render(<RightPanel busy={false} />);

    for (const profile of BASE_AGENT_PROFILES) {
      expect(screen.getByText(profile.name)).toBeTruthy();
    }
    expect(screen.queryByText('PPT 创作专家')).toBeNull();
    expect(screen.queryByText('会议 Agent')).toBeNull();
    expect(screen.queryByText('品牌营销文案')).toBeNull();
    expect(screen.queryByText('企业AI自主开发')).toBeNull();
    expect(screen.queryByText('开发 AI 智能体')).toBeNull();
    expect(screen.queryByText('自主开发')).toBeNull();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('战略与竞争 Agent')).toBeNull();
    expect(screen.getByText('装修 · 公告 · 停车 · 网络 · 会议 · 报修')).toBeTruthy();
    expect(screen.queryByText('访客 · 会议室 · 报修 · 后勤 · 班车 · 餐饮')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(1);
  });

  it('launches the independent development AI without counting it among the fixed 9 cards', () => {
    installBridge();
    const launch = vi.fn();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={enterpriseWorkspace()}
        onLaunchAgentProfile={launch}
      />,
    );

    fireEvent.click(screen.getByText('自主开发'));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      id: 'self-development',
      name: '自主开发',
    }));
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('keeps the enterprise admin on the shared enterprise-work 9-Agent catalog', () => {
    installBridge();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="company_admin"
        workspace={enterpriseWorkspace()}
        onOpenSkillZone={vi.fn()}
      />,
    );

    expect(screen.getByText('企业工作 Agent')).toBeTruthy();
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('品牌营销文案')).toBeTruthy();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('产品需求 Agent')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('ignores a stale local owner workspace for an authenticated central member', () => {
    installBridge();

    const { container } = render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={enterpriseWorkspace()}
      />,
    );

    expect(screen.getByText('企业工作 Agent')).toBeTruthy();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(container.querySelectorAll('.otto-profile-card')).toHaveLength(9);
  });

  it('keeps worklog popovers inside the panel on the left and right calendar edges', async () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const mondayDay = 1 + ((7 - firstWeekday) % 7);
    const sundayDay = 1 + ((6 - firstWeekday + 7) % 7);
    const keyFor = (day: number): string =>
      `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    installBridge(async () => [
      {
        date: keyFor(mondayDay),
        entries: [{
          time: '09:00',
          category: 'test',
          action: '左侧成果',
          success: true,
          entryType: 'work_result',
        }],
      },
      {
        date: keyFor(sundayDay),
        entries: [{
          time: '18:00',
          category: 'test',
          action: '右侧成果',
          success: true,
          entryType: 'work_result',
        }],
      },
    ]);

    const { container } = render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));

    await waitFor(() => {
      expect(container.querySelector('button[title*="左侧成果"]')).toBeTruthy();
      expect(container.querySelector('button[title*="右侧成果"]')).toBeTruthy();
    });

    expect(container.querySelector('button[title*="左侧成果"]')?.className)
      .toContain('is-pop-col-0');
    expect(container.querySelector('button[title*="左侧成果"]')?.className)
      .toContain('is-pop-left');
    expect(container.querySelector('button[title*="右侧成果"]')?.className)
      .toContain('is-pop-col-6');
    expect(container.querySelector('button[title*="右侧成果"]')?.className)
      .toContain('is-pop-right');
  });

  it('keeps the park service entry wired to the park-services event', async () => {
    installBridge();
    const parkOpen = vi.fn();
    window.addEventListener('otto:open-park-services', parkOpen, { once: true });

    render(<RightPanel busy={false} />);

    const parkCard = (await screen.findByText('宏创AI园区服务')).closest('button');
    expect(parkCard).toBeTruthy();
    expect(parkCard?.getAttribute('title')).toContain('装修管理');
    fireEvent.click(parkCard!);
    expect(parkOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps the Feishu status and multi-channel shortcuts in the tools tab', () => {
    installBridge();
    render(<RightPanel busy={false} />);

    fireEvent.click(screen.getByRole('tab', { name: '工具' }));

    expect(screen.getByText('/feishu-status')).toBeTruthy();
    expect(screen.getByText('/multi-channel')).toBeTruthy();
    expect(screen.getByText('点击把命令填入输入框，回车执行')).toBeTruthy();
  });

  it('keeps one mascot stage outside the tabs while switching panels', () => {
    installBridge();
    render(<RightPanel busy={false} />);
    expect(screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }))
      .toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: '笔记' }));

    expect(screen.getAllByRole('region', { name: 'Otto 吉祥物活动区' }))
      .toHaveLength(1);
  });

  it('keeps personal mode on its four tabs without enterprise-only actions', () => {
    installBridge();
    render(<RightPanel busy={false} />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '专家',
      '工具',
      '笔记',
      '工作日志',
    ]);
    expect(screen.queryByText('企业记忆')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skill 专区' })).toBeNull();
    expect(screen.queryByRole('button', { name: /企业与好友/ })).toBeNull();
  });

  it('keeps enterprise tabs, Skill Zone, and collaboration in fixed-catalog mode', () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Skill 专区' }));
    expect(openSkillZone).toHaveBeenCalledTimes(1);

    const toggle = screen.getByRole('button', { name: /企业与好友/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByText('宏创 AI')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('loads and displays real enterprise memory entries', async () => {
    installBridge();
    (window as unknown as { otto: { enterpriseKnowledgeList: () => Promise<unknown[]> } }).otto.enterpriseKnowledgeList = vi.fn(async () => [
      {
        id: 'k1',
        organizationId: 'org-1',
        sourceId: 's1',
        department: '研发部',
        category: 'solution',
        content: '客户部署必须先完成企业邀请码校验。',
        contributor: 'Felix',
        confidence: 0.86,
        createdAt: '2026-07-20T04:00:00.000Z',
      },
    ]);

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '企业记忆' }));

    expect(await screen.findByText('客户部署必须先完成企业邀请码校验。')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('solution')).toBeTruthy();
    expect(screen.getByText('86%')).toBeTruthy();
    expect(screen.getByText('Felix')).toBeTruthy();
  });

  it('shows the authenticated central organization before stale local company data', () => {
    installBridge();
    const workspace = {
      ...enterpriseWorkspace(),
      authenticatedOrganization: { id: 'central-org', name: '中心企业' },
    };
    const openOrganization = vi.fn();

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        enterpriseRole="member"
        workspace={workspace}
        onOpenOrganization={openOrganization}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /企业与好友/ }));
    expect(screen.getByText('中心企业')).toBeTruthy();
    expect(screen.queryByText('宏创 AI')).toBeNull();
    expect(screen.getByText('成员与部门由中心组织树实时加载')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开企业组织树' }));
    expect(openOrganization).toHaveBeenCalledOnce();
  });

  it('requires an explicit confirmation or rejection for auto-Skill candidates', () => {
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

  it('shows and opens the real saved result after generating a work report', async () => {
    const { openPath, workLogReport } = installBridge();
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    fireEvent.click(screen.getByRole('button', { name: '生成今日总结' }));

    expect(workLogReport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/已生成并保存「市场竞品调研报告」/))
      .toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开总结' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(
      '/tmp/2026-07-10-市场竞品调研报告.md',
    ));
  });

  it('lists every worklog item and its details in the calendar tooltip', async () => {
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
        {
          time: '14:20',
          category: 'calendar',
          action: '安排复盘日程',
          success: false,
          entryType: 'tool',
        },
      ],
    }]);
    render(<RightPanel busy={false} />);
    fireEvent.click(screen.getByRole('tab', { name: '工作日志' }));
    const day = screen.getByRole('button', { name: String(now.getDate()) });

    await waitFor(() => expect(day.getAttribute('title')).toBe(
      '• 09:30 生成调研报告\n• 14:20 安排复盘日程',
    ));
    const tooltipText = screen.getByRole('tooltip').textContent ?? '';
    expect(tooltipText).toContain('• 完成 · 生成调研报告');
    expect(tooltipText).toContain('完成宏创园区竞品数据对比与结论。');
    expect(tooltipText).toContain('• calendar · 安排复盘日程（失败）');
  });
});
