/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 左侧栏。1:1 还原 spec §左侧栏：
 *   品牌 otto✦ + compose 按钮 / + 新建对话 / 今天·昨天分组 /
 *   会话项（标题+时间+预览+来源徽章, 选中态 cream 底+左竖条）/ 查看全部对话。
 */

import React from 'react';
import type { SessionSummary } from 'otto-server';
import { type SessionGroup } from '../state/useOttoStore.js';
import { SourceBadge } from './SourceBadge.js';
import {
  IconCompose,
  IconPlus,
  IconList,
  IconChevron,
  IconSparkle,
} from './icons.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface SidebarProps {
  groups: SessionGroup[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onViewAll: () => void;
}

export function Sidebar({
  groups,
  activeSessionId,
  onSelect,
  onNewChat,
  onViewAll,
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="otto-sidebar">
      <div className="otto-sidebar__traffic" />

      <div className="otto-sidebar__brandrow">
        <span className="otto-brand">
          otto
          <IconSparkle size={12} className="otto-brand__sparkle" />
        </span>
        <button
          type="button"
          className="otto-iconbtn"
          title="新建对话"
          aria-label="新建对话"
          onClick={onNewChat}
        >
          <IconCompose size={17} />
        </button>
      </div>

      <button type="button" className="otto-newchat" onClick={onNewChat}>
        <IconPlus size={15} />
        新建对话
      </button>

      <div className="otto-sessions">
        {groups.length === 0 ? (
          <div className="otto-group__label">暂无对话</div>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <div className="otto-group__label">{g.label}</div>
              {g.sessions.map((s) => (
                <SessionItem
                  key={s.sessionId}
                  session={s}
                  active={s.sessionId === activeSessionId}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="otto-sidebar__footer">
        <button type="button" className="otto-viewall" onClick={onViewAll}>
          <IconList size={16} />
          查看全部对话
          <IconChevron size={15} className="otto-viewall__chev" />
        </button>
      </div>
    </aside>
  );
}

function SessionItem({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`otto-session${active ? ' otto-session--active' : ''}`}
      onClick={() => onSelect(session.sessionId)}
      aria-current={active ? 'true' : undefined}
    >
      <div className="otto-session__top">
        <span className="otto-session__title">{session.title || '未命名对话'}</span>
        <span className="otto-session__time">{formatTime(session.updatedAt)}</span>
      </div>
      {session.lastMessagePreview ? (
        <div className="otto-session__preview">{session.lastMessagePreview}</div>
      ) : null}
      <div className="otto-session__meta">
        <SourceBadge source={session.source} />
      </div>
    </button>
  );
}
