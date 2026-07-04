/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 左侧栏。1:1 还原 spec §左侧栏：
 *   品牌 otto✦ + compose 按钮 / + 新建对话 / 今天·昨天分组 /
 *   会话项（标题+时间+预览+来源徽章, 选中态 cream 底+左竖条）/ 查看全部对话。
 *
 * 会话项支持 hover 溢出菜单（⋯ → 重命名 / 删除）：
 *   - 重命名走 inline 输入框（双击标题 或 菜单「重命名」→ 变输入框，Enter 提交、Esc 取消）。
 *   - 删除**二次确认**（inline「确定删除?」条），删除不可逆。
 * 会话项因此从 <button> 改为 role=button 的 <div>：按钮不能嵌按钮/输入框（无效 HTML）。
 */

import React, { useEffect, useRef, useState } from 'react';
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
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  groups,
  activeSessionId,
  onSelect,
  onNewChat,
  onViewAll,
  onRename,
  onDelete,
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
                  onRename={onRename}
                  onDelete={onDelete}
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

/** 溢出菜单三点图标（内联，避免动 icons.tsx）。 */
function IconMoreDots(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}

/** 会话项本地交互态：普通 / 菜单打开 / 重命名中 / 删除确认中。 */
type ItemMode = 'idle' | 'menu' | 'rename' | 'confirm';

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<ItemMode>('idle');
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 进入重命名态即聚焦并全选，让用户直接改写。
  useEffect(() => {
    if (mode === 'rename') {
      const el = inputRef.current;
      el?.focus();
      el?.select();
    }
  }, [mode]);

  // 菜单/确认态打开时，点击本项之外则收起（回 idle），避免菜单悬挂。
  useEffect(() => {
    if (mode !== 'menu' && mode !== 'confirm') return;
    const onDoc = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMode('idle');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [mode]);

  const startRename = (): void => {
    setDraft(session.title);
    setMode('rename');
  };

  const commitRename = (): void => {
    const clean = draft.trim();
    // 有变化且非空才提交；否则当作取消（回 idle）。
    if (clean && clean !== session.title) onRename(session.sessionId, clean);
    setMode('idle');
  };

  const cancelRename = (): void => {
    setDraft(session.title);
    setMode('idle');
  };

  // —— 重命名态：整行换成 inline 输入框 ——
  if (mode === 'rename') {
    return (
      <div
        ref={rootRef}
        className={`otto-session otto-session--editing${active ? ' otto-session--active' : ''}`}
      >
        <input
          ref={inputRef}
          className="otto-session__renameinput"
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelRename();
            }
          }}
          onBlur={commitRename}
          aria-label="重命名会话"
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`otto-session${active ? ' otto-session--active' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(session.sessionId);
        }
      }}
    >
      <div className="otto-session__top">
        <span
          className="otto-session__title"
          onDoubleClick={(e) => {
            // 双击标题直接进重命名（不触发选中冒泡）。
            e.stopPropagation();
            startRename();
          }}
        >
          {session.title || '未命名对话'}
        </span>
        <span className="otto-session__time">{formatTime(session.updatedAt)}</span>
        <button
          type="button"
          className="otto-session__more"
          title="更多操作"
          aria-label="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            setMode((m) => (m === 'menu' ? 'idle' : 'menu'));
          }}
        >
          <IconMoreDots />
        </button>
      </div>
      {session.lastMessagePreview ? (
        <div className="otto-session__preview">{session.lastMessagePreview}</div>
      ) : null}
      <div className="otto-session__meta">
        <SourceBadge source={session.source} />
      </div>

      {mode === 'menu' ? (
        <div
          className="otto-session__menu"
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="otto-session__menuitem"
            onClick={() => startRename()}
          >
            重命名
          </button>
          <button
            type="button"
            role="menuitem"
            className="otto-session__menuitem otto-session__menuitem--danger"
            onClick={() => setMode('confirm')}
          >
            删除
          </button>
        </div>
      ) : null}

      {mode === 'confirm' ? (
        <div
          className="otto-session__confirm"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="otto-session__confirmtext">删除此对话？不可撤销。</span>
          <div className="otto-session__confirmbtns">
            <button
              type="button"
              className="otto-session__confirmcancel"
              onClick={() => setMode('idle')}
            >
              取消
            </button>
            <button
              type="button"
              className="otto-session__confirmdel"
              onClick={() => {
                onDelete(session.sessionId);
                setMode('idle');
              }}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
