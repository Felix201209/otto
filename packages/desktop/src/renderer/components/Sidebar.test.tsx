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
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import type { SessionSummary } from 'otto-server';
import { Sidebar } from './Sidebar.js';
import type { SessionGroup } from '../state/useOttoStore.js';

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
  it('不再渲染常见任务 / 全部智能体入口（已迁 RightPanel）', () => {
    renderSidebar();
    expect(screen.queryByText('常见任务')).toBeNull();
    expect(screen.queryByText('PPT 创作专家')).toBeNull();
    expect(screen.queryByText('全部智能体')).toBeNull();
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
