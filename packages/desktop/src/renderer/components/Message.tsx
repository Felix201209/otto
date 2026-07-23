/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单条消息渲染。spec §主聊天区：
 *   - 用户消息：右对齐 peach 气泡 + 时间 + amber 双勾已读回执；图片缩略图可点开放大。
 *   - Otto 回复：副图标 + 名 + 时间 + 正文 + 工具卡 + 动作行（复制 / 重新生成）。
 *
 * 动作行只保留复制与重新生成——这两个是真的落地功能；原先的赞/踩仅本地高亮、
 * 不落库不发帧、切会话即丢，是误导用户的假按钮，已移除。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { OttoMessage } from 'otto-server';
import { Prose, contentToText } from './Prose.js';
import { attachmentToDataUrl } from '../lib/image.js';
import {
  buildToolCompletionSummary,
  ToolCallsCard,
  type RespondQuestionFn,
} from './ToolCalls.js';
import { OttoSecondaryMark } from './OttoSecondaryMark.js';
import {
  IconCheckCheck,
  IconCheck,
  IconCopy,
  IconRegenerate,
  IconChevron,
  IconClose,
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
  /**
   * 重新生成。携带被点的那条 bot 消息 id，App 据此定位「该条之前最近的一条
   * 用户消息」重发——而非永远重发全会话最后一轮，否则上翻对旧回复点重生成会串轮。
   */
  onRegenerate: (messageId: string) => void;
  /** AskUserQuestion 作答回传（透传到工具卡里的问答卡）。 */
  onRespondQuestion?: RespondQuestionFn;
}

export function Message({
  message,
  onCopy,
  onRegenerate,
  onRespondQuestion,
}: MessageProps): React.JSX.Element {
  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }
  if (message.role === 'system') {
    // 系统气泡：斜杠命令回执 / 本地提示（/help）。ephemeral（不落库），
    // 不带头像与「重新生成」动作——它不是模型回复，重生成无意义。
    return <SystemMessage message={message} />;
  }
  return (
    <BotMessage
      message={message}
      onCopy={onCopy}
      onRegenerate={onRegenerate}
      onRespondQuestion={onRespondQuestion}
    />
  );
}

/** 系统消息（命令回执）：居中窄卡，markdown 正文（Prose），弱化视觉不抢对话主线。 */
function SystemMessage({ message }: { message: OttoMessage }): React.JSX.Element {
  return (
    <div className="otto-msg-system" role="note">
      <div className="otto-msg-system__card">
        <Prose text={contentToText(message.content)} />
      </div>
    </div>
  );
}

function UserMessage({ message }: { message: OttoMessage }): React.JSX.Element {
  const text = contentToText(message.content);
  const images = message.content.filter(
    (
      p,
    ): p is Extract<
      OttoMessage['content'][number],
      { type: 'image_reference' }
    > => p.type === 'image_reference',
  );
  // 点开放大的图（lightbox）：null 时不显示遮罩。存 dataUrl + 文件名两项供大图渲染。
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(
    null,
  );
  return (
    <div className="otto-msg-user">
      {images.length > 0 ? (
        <div className="otto-msg-user__images">
          {images.map((p) => {
            const src = attachmentToDataUrl(p.value);
            return (
              <button
                key={p.value.id}
                type="button"
                className="otto-msg-user__thumb"
                title="点击查看大图"
                aria-label={`查看大图：${p.value.fileName}`}
                onClick={() => setZoomed({ src, alt: p.value.fileName })}
              >
                <img
                  className="otto-msg-user__image"
                  src={src}
                  alt={p.value.fileName}
                />
              </button>
            );
          })}
        </div>
      ) : null}
      {text ? <div className="otto-msg-user__bubble">{text}</div> : null}
      <div className="otto-msg-user__receipt">
        <span>{formatTime(message.timestamp)}</span>
        <IconCheckCheck size={14} className="otto-msg-user__check" />
      </div>
      {zoomed ? (
        <ImageLightbox
          src={zoomed.src}
          alt={zoomed.alt}
          onClose={() => setZoomed(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * 图片放大浮层（lightbox）。点遮罩或按 Esc 关闭；大图用 object-fit: contain
 * 完整显示不裁切。挂载时把焦点移到关闭按钮，便于键盘直接 Esc/Enter 操作。
 */
function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="otto-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        className="otto-lightbox__close"
        aria-label="关闭预览"
        title="关闭"
        onClick={onClose}
      >
        <IconClose size={18} />
      </button>
      {/* 点图本身不关闭：拦截冒泡，只有点遮罩空白处才关。 */}
      <img
        className="otto-lightbox__img"
        src={src}
        alt={alt}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function BotMessage({
  message,
  onCopy,
  onRegenerate,
  onRespondQuestion,
}: MessageProps): React.JSX.Element {
  const text = contentToText(message.content);
  const tools = message.associatedToolCalls ?? [];
  const responding = Boolean(
    message.isStreaming || message.isReasoning || message.isProcessingTools,
  );
  const fallbackSummary =
    !text && !responding && tools.length > 0
      ? buildToolCompletionSummary(tools)
      : '';
  const displayText = text || fallbackSummary;

  return (
    <div className="otto-msg-bot">
      <OttoSecondaryMark active={responding} />
      <div className="otto-msg-bot__body">
        <div className="otto-msg-bot__head">
          <span className="otto-msg-bot__name">Otto</span>
          <span className="otto-msg-bot__time">
            {formatTime(message.timestamp)}
          </span>
        </div>

        {message.reasoning || tools.length > 0 ? (
          <ProcessTrace
            reasoning={message.reasoning}
            reasoningActive={Boolean(message.isReasoning)}
            tools={tools}
            toolsActive={Boolean(message.isProcessingTools)}
            onRespondQuestion={onRespondQuestion}
          />
        ) : null}

        {displayText ? (
          <Prose text={displayText} streaming={message.isStreaming} />
        ) : message.isStreaming && tools.length === 0 ? (
          <TypingIndicator />
        ) : null}

        {!message.isStreaming ? (
          <MessageActions
            onCopy={() => onCopy(displayText)}
            onRegenerate={() => onRegenerate(message.id)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** 首个 chunk 未到时只显示克制文案；动效由左侧回答标记承担。 */
function TypingIndicator(): React.JSX.Element {
  return (
    <div className="otto-typing" role="status" aria-label="Otto 正在输入">
      正在组织回答…
    </div>
  );
}

/**
 * 将模型推理、Skill 与工具调用统一收进一个「深度思考」过程区：
 *   - 推理/工具运行时自动展开，让当前 Skill 短暂可见；
 *   - 整个过程结束后自动收起，不让 Skill 名称持续占据对话主线；
 *   - 待确认卡保持展开，避免把必须由用户处理的交互藏起来；
 *   - 完成后仍可点箭头查看完整过程。
 */
function ProcessTrace({
  reasoning,
  reasoningActive,
  tools,
  toolsActive,
  onRespondQuestion,
}: {
  reasoning?: string;
  reasoningActive: boolean;
  tools: NonNullable<OttoMessage['associatedToolCalls']>;
  toolsActive: boolean;
  onRespondQuestion?: RespondQuestionFn;
}): React.JSX.Element {
  const requiresAttention = tools.some(
    (tool) => tool.status === 'awaiting_approval',
  );
  const active = reasoningActive || toolsActive;
  const automaticOpen = active || requiresAttention;
  const [open, setOpen] = useState(automaticOpen);
  const prevAutomaticOpenRef = useRef(automaticOpen);

  useEffect(() => {
    // 阶段开始时自动露出当前过程；最后一个阶段结束时自动隐藏。
    // 同一阶段里用户手动收起后不反复抢开，尊重用户的即时选择。
    if (prevAutomaticOpenRef.current !== automaticOpen) {
      setOpen(automaticOpen);
    }
    prevAutomaticOpenRef.current = automaticOpen;
  }, [automaticOpen]);

  return (
    <div className="otto-reasoning otto-process-trace">
      <button
        type="button"
        className="otto-reasoning__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="otto-reasoning__title">
          {active ? '正在处理…' : requiresAttention ? '等待确认' : '处理记录'}
        </span>
        {tools.length > 0 ? (
          <span className="otto-process-trace__count">
            {tools.length} 个步骤
          </span>
        ) : null}
        <IconChevron
          size={14}
          className={`otto-reasoning__chev${
            open ? ' otto-reasoning__chev--open' : ''
          }`}
        />
      </button>
      <div className={`otto-collapse${open ? ' otto-collapse--open' : ''}`}>
        <div className="otto-collapse__inner">
          <div className="otto-process-trace__body">
            {reasoning ? (
              <div className="otto-reasoning__body">{reasoning}</div>
            ) : null}
            {tools.length > 0 ? (
              <ToolCallsCard
                toolCalls={tools}
                onRespondQuestion={onRespondQuestion}
              />
            ) : null}
          </div>
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
    </div>
  );
}
