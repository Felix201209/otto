/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单条消息渲染。spec §主聊天区：
 *   - 用户消息：右对齐 peach 气泡 + 时间 + amber 双勾已读回执。
 *   - Otto 回复：头像 + 名 + 时间 + 正文 + 工具卡 + 动作行（复制/重生成/赞/踩）。
 */

import React, { useState } from 'react';
import type { OttoMessage } from 'otto-server';
import { Prose, contentToText } from './Prose.js';
import { ToolCallsCard } from './ToolCalls.js';
import {
  OttoAvatar,
  IconCheckCheck,
  IconCopy,
  IconRegenerate,
  IconThumbUp,
  IconThumbDown,
} from './icons.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

interface MessageProps {
  message: OttoMessage;
  onCopy: (text: string) => void;
  onRegenerate: () => void;
}

export function Message({
  message,
  onCopy,
  onRegenerate,
}: MessageProps): React.JSX.Element {
  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }
  return (
    <BotMessage
      message={message}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
    />
  );
}

function UserMessage({ message }: { message: OttoMessage }): React.JSX.Element {
  const text = contentToText(message.content);
  return (
    <div className="otto-msg-user">
      <div className="otto-msg-user__bubble">{text}</div>
      <div className="otto-msg-user__receipt">
        <span>{formatTime(message.timestamp)}</span>
        <IconCheckCheck size={14} className="otto-msg-user__check" />
      </div>
    </div>
  );
}

function BotMessage({
  message,
  onCopy,
  onRegenerate,
}: MessageProps): React.JSX.Element {
  const text = contentToText(message.content);
  const tools = message.associatedToolCalls ?? [];

  return (
    <div className="otto-msg-bot">
      <div className="otto-msg-bot__avatar">
        <OttoAvatar size={30} />
      </div>
      <div className="otto-msg-bot__body">
        <div className="otto-msg-bot__head">
          <span className="otto-msg-bot__name">Otto</span>
          <span className="otto-msg-bot__time">
            {formatTime(message.timestamp)}
          </span>
        </div>

        {message.reasoning ? (
          <div className="otto-reasoning">{message.reasoning}</div>
        ) : null}

        {text ? (
          <Prose text={text} streaming={message.isStreaming} />
        ) : message.isStreaming && tools.length === 0 ? (
          <TypingIndicator />
        ) : null}

        {tools.length > 0 ? <ToolCallsCard toolCalls={tools} /> : null}

        {!message.isStreaming ? (
          <MessageActions
            onCopy={() => onCopy(text)}
            onRegenerate={onRegenerate}
          />
        ) : null}
      </div>
    </div>
  );
}

/** 思考中指示：流式开始但首个 chunk 未到时显示三点跳动，替代空白正文。 */
function TypingIndicator(): React.JSX.Element {
  return (
    <div className="otto-typing" role="status" aria-label="Otto 正在输入">
      <span className="otto-typing__dot" />
      <span className="otto-typing__dot" />
      <span className="otto-typing__dot" />
    </div>
  );
}

function MessageActions({
  onCopy,
  onRegenerate,
}: {
  onCopy: () => void;
  onRegenerate: () => void;
}): React.JSX.Element {
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  return (
    <div className="otto-actions">
      <button
        type="button"
        className="otto-action"
        title="复制"
        aria-label="复制"
        onClick={onCopy}
      >
        <IconCopy size={16} />
      </button>
      <button
        type="button"
        className="otto-action"
        title="重新生成"
        aria-label="重新生成"
        onClick={onRegenerate}
      >
        <IconRegenerate size={16} />
      </button>
      <button
        type="button"
        className={`otto-action${vote === 'up' ? ' otto-action--on' : ''}`}
        title="赞"
        aria-label="赞"
        onClick={() => setVote((v) => (v === 'up' ? null : 'up'))}
      >
        <IconThumbUp size={16} />
      </button>
      <button
        type="button"
        className={`otto-action${vote === 'down' ? ' otto-action--on' : ''}`}
        title="踩"
        aria-label="踩"
        onClick={() => setVote((v) => (v === 'down' ? null : 'down'))}
      >
        <IconThumbDown size={16} />
      </button>
    </div>
  );
}
