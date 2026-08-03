/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sidebar 会话项交互单测：溢出菜单（⋯ → 重命名 / 删除）、inline 重命名
 * （双击标题 / 菜单进入，Enter 提交、Esc 取消、空/未变不提交）、删除二次确认。
 */

import type React from 'react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SessionSummary } from 'otto-server';
import { Sidebar } from './Sidebar.js';
import type { SessionGroup } from '../state/useOttoStore.js';

const PERSONAL_ACCOUNT = {
  id: 'acc_personal',
  organizationId: 'personal_acc_personal',
  organizationName: 'Felix 的个人空间',
  accountType: 'personal' as const,
  employeeId: null,
  username: 'felix',
  phone: '+8613800138000',
  name: 'Felix',
  role: null,
  department: null,
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active' as const,
  tags: [],
  createdAt: '2026-07-20',
  updatedAt: '2026-07-20',
};

const ENTERPRISE_ACCOUNT = {
  ...PERSONAL_ACCOUNT,
  organizationId: 'org_acme',
  organizationName: '星河科技',
  accountType: 'enterprise' as const,
  department: '产品部',
};

function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's1',
    source: 'local',
    title: '旧标题',
    status: 'idle',
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

function renderSidebar(over: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onSelect = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  const groups: SessionGroup[] = [
    { label: '今天', sessions: [makeSession()] },
  ];
  render(
    <Sidebar
      groups={groups}
      activeSessionId="s1"
      onSelect={onSelect}
      onNewChat={vi.fn()}
      onOpenHub={vi.fn()}
      onViewAll={vi.fn()}
      onRename={onRename}
      onDelete={onDelete}
      {...over}
    />,
  );
  return { onSelect, onRename, onDelete };
}

describe('Sidebar：布局（工具区已迁右侧面板）', () => {
  it('首页品牌使用正式名称 Otto', () => {
    renderSidebar();
    expect(screen.getByText('Otto')).toBeTruthy();
    expect(screen.queryByText('otto')).toBeNull();
  });

  it('不再渲染常见任务 / 全部智能体入口（已迁 RightPanel）', () => {
    renderSidebar();
    expect(screen.queryByText('常见任务')).toBeNull();
    expect(screen.queryByText('PPT 创作专家')).toBeNull();
    expect(screen.queryByText('全部智能体')).toBeNull();
  });

  it('只保留一个明确的新建对话入口，不再显示品牌行铅笔按钮', () => {
    const onNewChat = vi.fn();
    renderSidebar({ onNewChat });

    const buttons = screen.getAllByRole('button', { name: '新建对话' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('任务标题只用一个数字表示总数，并支持整体展开收起', () => {
    renderSidebar({
      groups: [{
        label: '今天',
        sessions: [
          makeSession({ sessionId: 's1' }),
          makeSession({ sessionId: 's2', title: '第二个任务' }),
        ],
      }],
    });

    const toggle = screen.getByRole('button', { name: '任务（2）' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('第二个任务')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('第二个任务')).toBeNull();
  });

  it('企业合成会话未读也在 Otto 品牌区保留闪烁点', () => {
    renderSidebar({ unreadSessions: ['enterprise:message:alice'] });

    expect(screen.getByRole('status', { name: '1 条未读消息' })).toBeTruthy();
  });

  it('企业私聊未读按消息条数在 Otto 品牌区显示数字', () => {
    renderSidebar({
      unreadSessions: ['enterprise:message:alice', 'park:ticket:repair-1'],
      enterpriseUnreadCounts: {
        'enterprise:message:alice': 2,
        'enterprise:message:bob': 1,
      },
    });

    expect(screen.getByRole('status', { name: '4 条未读消息' }).textContent).toBe('4');
  });

  it('个人版账号也始终显示账户区和退出登录入口', async () => {
    const onLogout = vi.fn(async () => undefined);
    renderSidebar({
      enterpriseAccount: PERSONAL_ACCOUNT,
      onLogout,
    });

    expect(screen.getByText('Felix')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    expect(screen.getByRole('dialog', { name: '确认退出登录' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce());
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '确认退出登录' }),
    ).toBeNull());
  });

  it('个人版可在客户端内提交企业邀请码升级，成功后关闭弹窗', async () => {
    const onJoinEnterprise = vi.fn(async () => undefined);
    renderSidebar({
      enterpriseAccount: PERSONAL_ACCOUNT,
      onJoinEnterprise,
    });

    fireEvent.click(screen.getByRole('button', { name: '升级企业版' }));
    const dialog = screen.getByRole('dialog', { name: '升级为企业版' });
    expect(within(dialog).getByText(/原个人空间对话不会自动带入企业/)).toBeTruthy();
    const invite = within(dialog).getByRole('textbox', { name: '企业邀请码' });
    fireEvent.change(invite, { target: { value: 'Ab3D-k9Pq-Z7xY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加入企业' }));

    await waitFor(() => expect(onJoinEnterprise).toHaveBeenCalledWith({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
    }));
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '升级为企业版' }),
    ).toBeNull());
  });

  it('邀请码升级失败时显示真实错误并保留输入，修正后可原地重试', async () => {
    const onJoinEnterprise = vi.fn()
      .mockRejectedValueOnce(new Error('企业邀请码无效或已失效'))
      .mockResolvedValueOnce(undefined);
    renderSidebar({
      enterpriseAccount: PERSONAL_ACCOUNT,
      onJoinEnterprise,
    });

    fireEvent.click(screen.getByRole('button', { name: '升级企业版' }));
    const dialog = screen.getByRole('dialog', { name: '升级为企业版' });
    const invite = within(dialog).getByRole('textbox', { name: '企业邀请码' });
    fireEvent.change(invite, { target: { value: 'Ab3D-k9Pq-Z7xY' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加入企业' }));

    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('企业邀请码无效或已失效');
    expect((invite as HTMLInputElement).value).toBe('Ab3D-k9Pq-Z7xY');
    fireEvent.change(invite, { target: { value: 'Wz8Y-m3Na-Q5pB' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '加入企业' }));

    await waitFor(() => expect(onJoinEnterprise).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '升级为企业版' }),
    ).toBeNull());
  });

  it('企业版账号不显示重复升级入口', () => {
    renderSidebar({
      enterpriseAccount: ENTERPRISE_ACCOUNT,
      onJoinEnterprise: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: '升级企业版' })).toBeNull();
  });
});

describe('Sidebar：对话任务日期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 12, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('按自然日标注今天、昨天和 N 天前', () => {
    const day = 86_400_000;
    const today = new Date(2026, 6, 12).getTime();
    renderSidebar({
      groups: [{
        label: '任意旧分组名',
        sessions: [
          makeSession({ sessionId: 'today', title: '今天任务', updatedAt: today + 1_000 }),
          makeSession({ sessionId: 'yesterday', title: '昨天任务', updatedAt: today - day + 1_000 }),
          makeSession({ sessionId: 'old', title: '旧任务', updatedAt: today - 4 * day + 1_000 }),
        ],
      }],
    });

    expect(screen.getByText('今天')).toBeTruthy();
    expect(screen.getByText('昨天')).toBeTruthy();
    expect(screen.getByText('4天前')).toBeTruthy();
  });
});

describe('Sidebar 会话项：溢出菜单', () => {
  it('点 ⋯ 展开菜单（重命名 / 删除）', () => {
    renderSidebar();
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByLabelText('更多操作'));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('重命名')).toBeTruthy();
    expect(within(menu).getByText('删除')).toBeTruthy();
  });

  it('点 ⋯ 不触发选中会话（stopPropagation）', () => {
    const { onSelect } = renderSidebar();
    fireEvent.click(screen.getByLabelText('更多操作'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('Sidebar 会话项：inline 重命名', () => {
  it('双击标题进入输入框，Enter 提交新标题', () => {
    const { onRename } = renderSidebar();
    fireEvent.doubleClick(screen.getByText('旧标题'));
    const input = screen.getByLabelText('重命名会话') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('s1', '新标题');
  });

  it('菜单「重命名」也能进入输入框', () => {
    renderSidebar();
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('重命名'));
    expect(screen.getByLabelText('重命名会话')).toBeTruthy();
  });

  it('Esc 取消：不提交、退回标题', () => {
    const { onRename } = renderSidebar();
    fireEvent.doubleClick(screen.getByText('旧标题'));
    const input = screen.getByLabelText('重命名会话') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '改了一半' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('旧标题')).toBeTruthy();
  });

  it('标题未变化 / 为空 → 提交时不发 onRename', () => {
    const { onRename } = renderSidebar();
    // 未变化
    fireEvent.doubleClick(screen.getByText('旧标题'));
    fireEvent.keyDown(screen.getByLabelText('重命名会话'), { key: 'Enter' });
    // 清空
    fireEvent.doubleClick(screen.getByText('旧标题'));
    const input = screen.getByLabelText('重命名会话');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('Sidebar 会话项：删除二次确认（弹窗）', () => {
  it('菜单「删除」→ 弹出确认弹窗；点弹窗「删除」才真正回调', () => {
    const { onDelete } = renderSidebar();
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('删除'));
    // 弹窗出现（带会话标题 + 不可撤销提示）
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      screen.getByText('确定删除「旧标题」吗？此操作不可撤销。'),
    ).toBeTruthy();
    // 未点确认前不删
    expect(onDelete).not.toHaveBeenCalled();
    // 弹窗里的「删除」按钮
    const confirmDel = screen.getByText('删除', {
      selector: '.otto-confirm__confirm',
    });
    fireEvent.click(confirmDel);
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('弹窗「取消」→ 不删、关闭弹窗', () => {
    const { onDelete } = renderSidebar();
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('删除'));
    fireEvent.click(screen.getByText('取消'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('标题为空 → 弹窗回退「未命名对话」', () => {
    renderSidebar({
      groups: [
        { label: '今天', sessions: [makeSession({ title: '' })] },
      ],
    });
    fireEvent.click(screen.getByLabelText('更多操作'));
    fireEvent.click(screen.getByText('删除'));
    expect(
      screen.getByText('确定删除「未命名对话」吗？此操作不可撤销。'),
    ).toBeTruthy();
  });
});
