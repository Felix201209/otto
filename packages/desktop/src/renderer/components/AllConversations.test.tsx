/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AllConversations 检索面板单测：方向键高亮 + Enter 打开、每行删除二次确认、
 * Esc 关闭（含先撤销删除确认）。焦点在搜索框，键盘事件由搜索框 onKeyDown 分流。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { SessionSummary } from 'otto-server';
import { AllConversations } from './AllConversations.js';

function makeSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 's1',
    source: 'local',
    title: '会话一',
    status: 'idle',
    createdAt: 1000,
    updatedAt: 1000,
    messageCount: 0,
    ...over,
  };
}

function renderPanel() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onDelete = vi.fn();
  const sessions = [
    makeSession({ sessionId: 'a', title: '会话A' }),
    makeSession({ sessionId: 'b', title: '会话B' }),
    makeSession({ sessionId: 'c', title: '会话C' }),
  ];
  render(
    <AllConversations
      sessions={sessions}
      activeSessionId="a"
      onSelect={onSelect}
      onClose={onClose}
      onDelete={onDelete}
    />,
  );
  return { onSelect, onClose, onDelete };
}

function search(): HTMLInputElement {
  return screen.getByPlaceholderText('搜索消息标题或内容…') as HTMLInputElement;
}

describe('AllConversations：键盘导航', () => {
  it('Enter 打开当前高亮（默认第一个）', () => {
    const { onSelect, onClose } = renderPanel();
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalled();
  });

  it('↓ 移动高亮后 Enter 打开对应会话', () => {
    const { onSelect } = renderPanel();
    fireEvent.keyDown(search(), { key: 'ArrowDown' }); // → b
    fireEvent.keyDown(search(), { key: 'ArrowDown' }); // → c
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('↑ 从首项回绕到末项', () => {
    const { onSelect } = renderPanel();
    fireEvent.keyDown(search(), { key: 'ArrowUp' }); // 0 → 末项 c
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('Esc 关闭面板', () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AllConversations unread indicators', () => {
  it('shows an unread red-dot marker for unread sessions', () => {
    const sessions = [
      makeSession({ sessionId: 'a', title: 'A' }),
      makeSession({ sessionId: 'b', title: 'B' }),
    ];
    render(
      <AllConversations
        sessions={sessions}
        activeSessionId="a"
        unreadSessions={['b']}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('未读消息')).toBeTruthy();
    expect(document.querySelector('[data-unread="true"]')).toBeTruthy();
  });

  it('combines enterprise notifications with history and filters by category or unread state', () => {
    const onOpenNotification = vi.fn();
    render(
      <AllConversations
        sessions={[
          makeSession({ sessionId: 'local-1', title: '本地历史', source: 'local' }),
          makeSession({ sessionId: 'feishu-1', title: '飞书历史', source: 'feishu' }),
        ]}
        activeSessionId="local-1"
        unreadSessions={[]}
        enterpriseUnreadCounts={{ 'enterprise:message:account-2': 3 }}
        onSelect={vi.fn()}
        onOpenNotification={onOpenNotification}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: '消息中心' })).toBeTruthy();
    expect(screen.getByText('企业私聊')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '仅看未读' }));
    expect(screen.getByText('企业私聊')).toBeTruthy();
    expect(screen.queryByText('本地历史')).toBeNull();

    fireEvent.click(screen.getByText('企业私聊'));
    expect(onOpenNotification).toHaveBeenCalledWith(
      'enterprise:message:account-2',
    );
  });

  it('filters durable history by local and Feishu sources', () => {
    render(
      <AllConversations
        sessions={[
          makeSession({ sessionId: 'local-1', title: '本地历史', source: 'local' }),
          makeSession({ sessionId: 'feishu-1', title: '飞书历史', source: 'feishu' }),
        ]}
        activeSessionId="local-1"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '飞书消息' }));
    expect(screen.getByText('飞书历史')).toBeTruthy();
    expect(screen.queryByText('本地历史')).toBeNull();
  });
});

describe('AllConversations：每行删除二次确认（弹窗）', () => {
  it('点删除按钮弹出确认弹窗；确认后回调 onDelete，面板不关', () => {
    const { onDelete, onClose } = renderPanel();
    const delBtns = screen.getAllByLabelText('删除对话');
    fireEvent.click(delBtns[1]); // 会话B 那行
    // 弹窗出现（面板本身也是 role=dialog，故以确认文案判定弹窗存在）
    expect(
      screen.getByText('确定删除「会话B」吗？此操作不可撤销。'),
    ).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    const confirmDel = screen.getByText('删除', {
      selector: '.otto-confirm__confirm',
    });
    fireEvent.click(confirmDel);
    expect(onDelete).toHaveBeenCalledWith('b');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('删除按钮点击不触发选中该行（stopPropagation）', () => {
    const { onSelect } = renderPanel();
    fireEvent.click(screen.getAllByLabelText('删除对话')[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('确认态下 Esc（搜索框）先撤销确认，不关面板', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getAllByLabelText('删除对话')[0]);
    expect(
      screen.getByText('确定删除「会话A」吗？此操作不可撤销。'),
    ).toBeTruthy();
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByText('确定删除「会话A」吗？此操作不可撤销。'),
    ).toBeNull();
  });

  it('弹窗「取消」→ 不删、关闭弹窗', () => {
    const { onDelete } = renderPanel();
    fireEvent.click(screen.getAllByLabelText('删除对话')[0]);
    fireEvent.click(screen.getByText('取消'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.queryByText('确定删除「会话A」吗？此操作不可撤销。'),
    ).toBeNull();
  });
});
