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
  return screen.getByPlaceholderText('搜索对话标题或内容…') as HTMLInputElement;
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

describe('AllConversations：每行删除二次确认', () => {
  it('点删除按钮出确认条；确认后回调 onDelete，面板不关', () => {
    const { onDelete, onClose } = renderPanel();
    const delBtns = screen.getAllByLabelText('删除对话');
    fireEvent.click(delBtns[1]); // 会话B 那行
    expect(screen.getByText('删除此对话？不可撤销。')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    const confirmDel = screen.getByText('删除', {
      selector: '.otto-allconv__confirmdel',
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

  it('确认态下 Esc 先撤销确认，不关面板', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getAllByLabelText('删除对话')[0]);
    expect(screen.getByText('删除此对话？不可撤销。')).toBeTruthy();
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('删除此对话？不可撤销。')).toBeNull();
  });
});
