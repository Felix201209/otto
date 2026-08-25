/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ChatView 重新生成接线单测：
 *   每条 bot 消息的「重新生成」按钮点击时，onRegenerate 必须收到**这条**消息的 id，
 *   而不是所有消息共用一个无参回调。这是修复「上翻对旧回复点重生成却重发最新一轮」
 *   串轮 bug 的关键接线——id 传对了，App 才能定位到正确的用户轮次。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { OttoMessage, SessionSummary, ModelInfo } from 'otto-server';
import { ChatView } from './ChatView.js';

vi.mock('../assets/otto-avatar.png', () => ({ default: 'avatar.png' }));

const SESSION: SessionSummary = {
  sessionId: 's1',
  source: 'local',
  title: '测试会话',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  messageCount: 4,
};

const MODELS: ModelInfo[] = [
  { id: 'm1', displayName: '模型一', provider: 'anthropic' },
];

// 两轮问答：用户 A → botA，用户 B → botB。上翻对 botA 点重生成应传 botA 的 id。
function twoRounds(): OttoMessage[] {
  const mk = (
    id: string,
    role: OttoMessage['role'],
    text: string,
  ): OttoMessage => ({
    id,
    sessionId: 's1',
    role,
    content: [{ type: 'text', value: text }],
    timestamp: 1_700_000_000_000,
    source: 'local',
    isStreaming: false,
  });
  return [
    mk('u-A', 'user', '第一轮问题'),
    mk('bot-A', 'assistant', '第一轮回答'),
    mk('u-B', 'user', '第二轮问题'),
    mk('bot-B', 'assistant', '第二轮回答'),
  ];
}

function renderChat(onRegenerate = vi.fn()) {
  render(
    <ChatView
      session={SESSION}
      messages={twoRounds()}
      models={MODELS}
      currentModel="m1"
      identityLabel="北辰科技 · 产品部 · 产品经理 · 企业成员"
      busy={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onSetModel={vi.fn()}
      onRegenerate={onRegenerate}
      onOpenSetup={vi.fn()}
      onNewChat={vi.fn()}
      onClearContext={vi.fn()}
      onExport={vi.fn()}
    />,
  );
  return { onRegenerate };
}

describe('ChatView 重新生成携带消息 id', () => {
  it('保留服务端权威身份，不再显示顶栏快捷操作', () => {
    renderChat();

    expect(
      screen.getByText('北辰科技 · 产品部 · 产品经理 · 企业成员'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '切换到深色' })).toBeNull();
    expect(screen.queryByRole('button', { name: '切换到浅色' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出会话为 Markdown' })).toBeNull();
    expect(screen.queryByRole('button', { name: '模型与个人 API 设置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '专家面板' })).toBeNull();
  });

  it('空会话与未选择会话时恢复 v1.6 的 Otto 形象', () => {
    const props = {
      models: MODELS,
      currentModel: 'm1',
      busy: false,
      onSend: vi.fn(),
      onCancel: vi.fn(),
      onSetModel: vi.fn(),
      onRegenerate: vi.fn(),
      onOpenSetup: vi.fn(),
      onNewChat: vi.fn(),
      onClearContext: vi.fn(),
    };
    const { rerender } = render(
      <ChatView session={null} messages={[]} {...props} />,
    );
    expect(screen.getByRole('img', { name: 'Otto' })).toBeTruthy();

    rerender(<ChatView session={SESSION} messages={[]} {...props} />);
    expect(screen.getByRole('img', { name: 'Otto' })).toBeTruthy();
  });

  it('点旧回复（第一轮 bot）的重新生成 → 传出该条 bot 的 id，而非最新一轮', () => {
    const { onRegenerate } = renderChat();
    // 每条 bot 消息各有一个「重新生成」按钮，取第一个（第一轮 bot-A）。
    const buttons = screen.getAllByLabelText('重新生成');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]);
    expect(onRegenerate).toHaveBeenCalledWith('bot-A');
  });

  it('点最新一轮 bot 的重新生成 → 传出最新那条的 id', () => {
    const { onRegenerate } = renderChat();
    const buttons = screen.getAllByLabelText('重新生成');
    fireEvent.click(buttons[1]);
    expect(onRegenerate).toHaveBeenCalledWith('bot-B');
  });
});
