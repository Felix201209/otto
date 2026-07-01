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

import React, { useEffect, useRef, useState } from 'react';
import type { OttoMessage } from 'otto-server';
import { Prose, contentToText } from './Prose.js';
import { ToolCallsCard } from './ToolCalls.js';
import {
  OttoAvatar,
  IconCheckCheck,
  IconCheck,
  IconCopy,
  IconRegenerate,
  IconThumbUp,
  IconThumbDown,
  IconChevron,
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
          <Reasoning
            text={message.reasoning}
            active={Boolean(message.isReasoning)}
          />
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

/**
 * 思考过程折叠块。流式推理期间（active）默认展开，标注「思考中」；
 * 推理结束（active: true→false）自动折叠成一行标题。用户可随时手动展开/收起。
 */
function Reasoning({
  text,
  active,
}: {
  text: string;
  active: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(active);
  const prevActiveRef = useRef(active);
  useEffect(() => {
    // 推理结束的那一帧（true→false）自动收起，避免长思考顶下正文。
    if (prevActiveRef.current && !active) {
      setOpen(false);
    }
    prevActiveRef.current = active;
  }, [active]);

  return (
    <div className="otto-reasoning">
      <button
        type="button"
        className="otto-reasoning__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="otto-reasoning__title">
          {active ? '思考中…' : '思考过程'}
        </span>
        <IconChevron
          size={14}
          className={`otto-reasoning__chev${
            open ? ' otto-reasoning__chev--open' : ''
          }`}
        />
      </button>
      <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
        <div className="otto-collapse__inner">
          <div className="otto-reasoning__body">{text}</div>
        </div>
      </div>
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
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    [],
  );
  const handleCopy = (): void => {
    onCopy();
    setCopied(true);
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="otto-actions">
      <button
        type="button"
        className={`otto-action${copied ? ' otto-action--on' : ''}`}
        title={copied ? '已复制' : '复制'}
        aria-label={copied ? '已复制' : '复制'}
        onClick={handleCopy}
      >
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
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
