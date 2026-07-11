/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Message 单测：
 *   1) Bot 动作行：只剩复制 / 重新生成——赞、踩已移除（假按钮不再误导）。
 *   2) 重新生成回调携带被点 bot 消息的 id（App 据此定位对应用户轮次重发）。
 *   3) User 图片缩略图可点开放大（lightbox），点遮罩 / Esc 关闭。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { OttoMessage } from 'otto-server';
import { Message } from './Message.js';

// mock 图片资源导入（webpack 里是 data URI，vitest 下给个占位）。
vi.mock('../assets/otto-avatar.png', () => ({ default: 'avatar.png' }));

function botMessage(overrides: Partial<OttoMessage> = {}): OttoMessage {
  return {
    id: 'bot-1',
    sessionId: 's1',
    role: 'assistant',
    content: [{ type: 'text', value: 'Otto 的回复' }],
    timestamp: 1_700_000_000_000,
    source: 'local',
    isStreaming: false,
    ...overrides,
  };
}

function userMessageWithImage(): OttoMessage {
  return {
    id: 'user-1',
    sessionId: 's1',
    role: 'user',
    content: [
      {
        type: 'image_reference',
        value: {
          id: 'img-1',
          fileName: '截图.png',
          data: 'AAAA',
          mimeType: 'image/png',
          originalSize: 100,
          compressedSize: 80,
        },
      },
    ],
    timestamp: 1_700_000_000_000,
    source: 'local',
  };
}

describe('Message 动作行', () => {
  it('bot 消息使用独立刺猬刺球标记，不再把完整吉祥物当作消息头像', () => {
    const { container } = render(
      <Message message={botMessage()} onCopy={vi.fn()} onRegenerate={vi.fn()} />,
    );
    const mark = screen.getByLabelText('Otto 回复');
    expect(mark.querySelector('.otto-response-mark__ball')).toBeTruthy();
    expect(mark.querySelector('.otto-response-mark__spines')).toBeTruthy();
    expect(container.querySelector('img[alt="Otto"]')).toBeNull();
  });

  it('流式、推理或工具处理中，刺球进入弹性跳跃活动态', () => {
    const { rerender } = render(
      <Message
        message={botMessage({ isStreaming: true, content: [] })}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('status', { name: 'Otto 正在回答' }).classList.contains('is-active'),
    ).toBe(true);

    rerender(
      <Message
        message={botMessage({ isStreaming: false, isProcessingTools: true })}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('status', { name: 'Otto 正在回答' }).classList.contains('is-active'),
    ).toBe(true);
  });

  it('bot 消息只渲染复制与重新生成，不再有赞 / 踩', () => {
    render(
      <Message message={botMessage()} onCopy={vi.fn()} onRegenerate={vi.fn()} />,
    );
    expect(screen.getByLabelText('复制')).toBeTruthy();
    expect(screen.getByLabelText('重新生成')).toBeTruthy();
    // 关键：假的赞 / 踩按钮已彻底移除。
    expect(screen.queryByLabelText('赞')).toBeNull();
    expect(screen.queryByLabelText('踩')).toBeNull();
  });

  it('点重新生成时回调收到该 bot 消息的 id', () => {
    const onRegenerate = vi.fn();
    render(
      <Message
        message={botMessage({ id: 'bot-42' })}
        onCopy={vi.fn()}
        onRegenerate={onRegenerate}
      />,
    );
    fireEvent.click(screen.getByLabelText('重新生成'));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
    expect(onRegenerate).toHaveBeenCalledWith('bot-42');
  });

  it('流式中的 bot 消息不显示动作行', () => {
    render(
      <Message
        message={botMessage({ isStreaming: true })}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('重新生成')).toBeNull();
  });
});

describe('User 图片 lightbox', () => {
  it('缩略图渲染为可点按钮，点击弹出放大浮层', () => {
    render(
      <Message
        message={userMessageWithImage()}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    // 未点开前无对话浮层。
    expect(screen.queryByRole('dialog')).toBeNull();
    const thumb = screen.getByLabelText('查看大图：截图.png');
    fireEvent.click(thumb);
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();
  });

  it('点遮罩关闭 lightbox', () => {
    render(
      <Message
        message={userMessageWithImage()}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('查看大图：截图.png'));
    const dialog = screen.getByRole('dialog', { name: '图片预览' });
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc 关闭 lightbox', () => {
    render(
      <Message
        message={userMessageWithImage()}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('查看大图：截图.png'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点大图本身不关闭（只有点遮罩才关）', () => {
    render(
      <Message
        message={userMessageWithImage()}
        onCopy={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('查看大图：截图.png'));
    const img = screen.getByRole('dialog').querySelector('.otto-lightbox__img');
    fireEvent.click(img as Element);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
