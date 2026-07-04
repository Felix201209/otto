/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「查看全部对话」检索面板。浮层 + 搜索框，在全量会话里按标题/末条预览过滤，
 * 点击某条即选中该会话并关闭。数据来自 store 的 selectSortedSessions（已按
 * updatedAt 倒序），纯前端过滤，不额外请求 server。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from 'otto-server';
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

interface AllConversationsProps {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function AllConversations({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
}: AllConversationsProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开即聚焦搜索框；Esc 关闭。
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${s.title ?? ''} ${s.lastMessagePreview ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [query, sessions]);

  const pick = (id: string): void => {
    onSelect(id);
    onClose();
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

        <div className="otto-allconv__list">
          {filtered.length === 0 ? (
            <div className="otto-allconv__empty">
              {sessions.length === 0
                ? '还没有任何对话'
                : '没有匹配的对话'}
            </div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                className={`otto-allconv__item${
                  s.sessionId === activeSessionId
                    ? ' otto-allconv__item--active'
                    : ''
                }`}
                onClick={() => pick(s.sessionId)}
              >
                <div className="otto-allconv__itemtop">
                  <span className="otto-allconv__title">
                    {s.title || '未命名对话'}
                  </span>
                  <span className="otto-allconv__time">
                    {formatWhen(s.updatedAt)}
                  </span>
                </div>
                {s.lastMessagePreview ? (
                  <div className="otto-allconv__preview">
                    {s.lastMessagePreview}
                  </div>
                ) : null}
                <div className="otto-allconv__meta">
                  <SourceBadge source={s.source} />
                </div>
              </button>
            ))
          )}
        </div>

        <div className="otto-allconv__footer">
          共 {sessions.length} 个对话
          {query.trim() ? `，匹配 ${filtered.length} 个` : ''}
        </div>
      </div>
    </div>
  );
}
