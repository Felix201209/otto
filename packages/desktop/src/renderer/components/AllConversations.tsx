/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「查看全部对话」检索面板。浮层 + 搜索框，在全量会话里按标题/末条预览过滤，
 * 点击某条即选中该会话并关闭。数据来自 store 的 selectSortedSessions（已按
 * updatedAt 倒序），纯前端过滤，不额外请求 server。
 *
 * 键盘导航（与 Composer 模型菜单看齐）：↑↓ 移动高亮、Enter 打开当前高亮、Esc 关闭。
 * 焦点留在搜索框（边打边过滤），方向键 / Enter 由搜索框 onKeyDown 统一分流。
 * 每行 hover 出删除按钮 → 居中弹窗 ConfirmDialog 二次确认，删除不可逆。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from 'otto-server';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SourceBadge } from './SourceBadge.js';
import { IconClose, IconList } from './icons.js';

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hh}:${mm}`;
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const DD = String(d.getDate()).padStart(2, '0');
  return `${MM}-${DD} ${hh}:${mm}`;
}

/** 垃圾桶图标（内联，避免动 icons.tsx）。 */
function IconTrash(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

interface AllConversationsProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  unreadSessions?: string[];
  onSelect: (id: string) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
}

export function AllConversations({
  sessions,
  activeSessionId,
  unreadSessions = [],
  onSelect,
  onClose,
  onDelete,
}: AllConversationsProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  // 键盘高亮下标（对齐 filtered 列表）。查询变化时复位到 0。
  const [highlight, setHighlight] = useState(0);
  // 正处于删除确认态的 sessionId（居中弹窗二次确认，删除不可逆）。null = 无弹窗。
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${s.title ?? ''} ${s.lastMessagePreview ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, sessions]);

  // 打开即聚焦搜索框。
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 过滤结果变化时把高亮钳在有效范围内（复位到 0，避免越界高亮空行）。
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // 高亮项滚动进视野（列表长到需要滚动时）。jsdom 无 scrollIntoView，存在才调。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '.otto-allconv__item--highlight',
    );
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight]);

  const pick = (id: string): void => {
    onSelect(id);
    onClose();
  };

  // 搜索框键盘分流：↑↓ 移高亮、Enter 打开高亮项、Esc 关闭（含先撤销删除确认）。
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) =>
        filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[highlight];
      if (target) pick(target.sessionId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (confirmId) setConfirmId(null);
      else onClose();
    }
  };

  return (
    <div className="otto-allconv-overlay" onClick={onClose}>
      <div
        className="otto-allconv"
        role="dialog"
        aria-label="全部对话"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="otto-allconv__head">
          <IconList size={16} className="otto-allconv__searchicon" />
          <input
            ref={inputRef}
            className="otto-allconv__search"
            type="text"
            placeholder="搜索对话标题或内容…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          <button
            type="button"
            className="otto-allconv__close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="otto-allconv__list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="otto-allconv__empty">
              {sessions.length === 0
                ? '还没有任何对话'
                : '没有匹配的对话'}
            </div>
          ) : (
            filtered.map((s, i) => {
              const unread = unreadSessions.includes(s.sessionId);
              return (
              <div
                key={s.sessionId}
                role="button"
                tabIndex={-1}
                data-unread={unread ? 'true' : undefined}
                aria-current={
                  s.sessionId === activeSessionId ? 'true' : undefined
                }
                className={`otto-allconv__item${
                  s.sessionId === activeSessionId
                    ? ' otto-allconv__item--active'
                    : ''
                }${i === highlight ? ' otto-allconv__item--highlight' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(s.sessionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(s.sessionId);
                  }
                }}
              >
                <div className="otto-allconv__itemtop">
                  {unread ? (
                    <span
                      className="otto-allconv__unread"
                      aria-label="未读消息"
                      title="未读消息"
                    />
                  ) : null}
                  <span className="otto-allconv__title">
                    {s.title || '未命名对话'}
                  </span>
                  <span className="otto-allconv__time">
                    {formatWhen(s.updatedAt)}
                  </span>
                  <button
                    type="button"
                    className="otto-allconv__del"
                    title="删除对话"
                    aria-label="删除对话"
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId(s.sessionId);
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
                {s.lastMessagePreview ? (
                  <div className="otto-allconv__preview">
                    {s.lastMessagePreview}
                  </div>
                ) : null}
                <div className="otto-allconv__meta">
                  <SourceBadge source={s.source} />
                </div>
              </div>
              );
            })
          )}
        </div>

        <div className="otto-allconv__footer">
          共 {sessions.length} 个对话
          {query.trim() ? `，匹配 ${filtered.length} 个` : ''}
        </div>
      </div>

      <ConfirmDialog
        open={confirmId !== null}
        title="删除对话"
        message={`确定删除「${
          sessions.find((s) => s.sessionId === confirmId)?.title || '未命名对话'
        }」吗？此操作不可撤销。`}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => {
          if (confirmId) onDelete(confirmId);
          setConfirmId(null);
        }}
      />
    </div>
  );
}
