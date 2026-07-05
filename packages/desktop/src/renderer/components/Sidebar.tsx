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
 *   - 删除**二次确认**走居中弹窗 ConfirmDialog（半透明遮罩 + 居中卡片），删除不可逆。
 * 会话项因此从 <button> 改为 role=button 的 <div>：按钮不能嵌按钮/输入框（无效 HTML）。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from 'otto-server';
import { type SessionGroup } from '../state/useOttoStore.js';
import { EXPERTS, type Expert } from '../agents/experts.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SourceBadge } from './SourceBadge.js';
import {
  IconCompose,
  IconPlus,
  IconList,
  IconChevron,
  IconSparkle,
  IconAgent,
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
  /** 当前是否停在「智能体」页（高亮该入口）。 */
  agentsActive?: boolean;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenAgents: () => void;
  onLaunchExpert: (expert: Expert) => void;
  onViewAll: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

export function Sidebar({
  groups,
  activeSessionId,
  agentsActive = false,
  onSelect,
  onNewChat,
  onOpenAgents,
  onLaunchExpert,
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

      <div className="otto-common-tasks" aria-label="常见任务">
        <div className="otto-common-tasks__head">常见任务</div>
        {EXPERTS.map((expert) => (
          <button
            key={expert.id}
            type="button"
            className="otto-common-task"
            onClick={() => onLaunchExpert(expert)}
            title={expert.tagline}
          >
            <span className="otto-common-task__icon" style={{ color: expert.accent }}>
              <IconAgent size={14} />
            </span>
            <span className="otto-common-task__body">
              <span className="otto-common-task__name">{expert.name}</span>
              <span className="otto-common-task__desc">{expert.tagline}</span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className={
            'otto-agents-entry' + (agentsActive ? ' is-active' : '')
          }
          onClick={onOpenAgents}
          aria-current={agentsActive ? 'page' : undefined}
          title="查看完整智能体画廊"
        >
          <span className="otto-agents-entry__label">全部智能体</span>
          <span className="otto-agents-entry__hint">画廊</span>
          <IconChevron size={15} className="otto-agents-entry__chev" />
        </button>
      </div>

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

  // 菜单态打开时，点击本项之外则收起（回 idle），避免菜单悬挂。
  // 确认态由 ConfirmDialog 弹窗自己管开关（点遮罩/Esc/取消），不走这套外点收起——
  // 否则点弹窗卡片（在本项 DOM 之外）会被误判为外点而把弹窗关掉。
  useEffect(() => {
    if (mode !== 'menu') return;
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

      <ConfirmDialog
        open={mode === 'confirm'}
        title="删除对话"
        message={`确定删除「${session.title || '未命名对话'}」吗？此操作不可撤销。`}
        onCancel={() => setMode('idle')}
        onConfirm={() => {
          onDelete(session.sessionId);
          setMode('idle');
        }}
      />
    </div>
  );
}
