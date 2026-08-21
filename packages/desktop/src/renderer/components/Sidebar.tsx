/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 左侧栏。以会话列表为主体：
 *   品牌 otto✦ / + 新建对话 / 今天·昨天分组会话列表（flex:1 主体）/
 *   底部账号区（辅助入口与当前账号）。
 *   常用工具（企业专家入口、全部智能体）已迁往右侧 RightPanel。
 *
 * 会话项支持 hover 溢出菜单（⋯ → 重命名 / 删除）：
 *   - 重命名走 inline 输入框（双击标题 或 菜单「重命名」→ 变输入框，Enter 提交、Esc 取消）。
 *   - 删除**二次确认**走居中弹窗 ConfirmDialog（半透明遮罩 + 居中卡片），删除不可逆。
 * 会话项因此从 <button> 改为 role=button 的 <div>：按钮不能嵌按钮/输入框（无效 HTML）。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from 'otto-server';
import { type SessionGroup } from '../state/useOttoStore.js';
import { computeNavBadgeCounts } from '../attentionCenter.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  IconPlus,
  IconChevronDown,
  IconUserAvatar,
} from './icons.js';
import { LogoutConfirmDialog } from './LogoutConfirmDialog.js';
import {
  JoinEnterpriseDialog,
  type EnterpriseVerificationHandlers,
} from './JoinEnterpriseDialog.js';
import type { EnterpriseAccount } from '../../preload/index.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 按用户本地自然日计算相对日期，避免跨时区或夏令时把“昨天”算成同一天。 */
function formatRelativeDay(ts: number, now = Date.now()): string {
  const current = new Date(now);
  const target = new Date(ts);
  const currentDay = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
  const targetDay = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const days = Math.max(0, Math.round((currentDay - targetDay) / 86_400_000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days}天前`;
}

function relativeSessionGroups(groups: SessionGroup[]): SessionGroup[] {
  const result: SessionGroup[] = [];
  const byLabel = new Map<string, SessionSummary[]>();
  const now = Date.now();
  const sessions = groups
    .flatMap((group) => group.sessions)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const session of sessions) {
    const label = formatRelativeDay(session.updatedAt, now);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(session);
    else {
      const first = [session];
      byLabel.set(label, first);
      result.push({ label, sessions: first });
    }
  }
  return result;
}

interface SidebarProps extends EnterpriseVerificationHandlers {
  groups: SessionGroup[];
  activeSessionId: string | null;
  /** 当前是否停在「设置」页（高亮该入口）。 */
  hubActive?: boolean;
  /** 当前主内容区视图，用于导航高亮。 */
  activeView?: string;
  accountManagementActive?: boolean;
  /** 静默检查发现新版 → 设置入口亮一个不打扰的小圆点（无弹窗）。 */
  updateBadge?: boolean;
  enterpriseAccount?: EnterpriseAccount;
  enterpriseUnreadCounts?: EnterpriseUnreadCounts;
  /** 园区工单未读总数（待处理 + 有更新的申请）。 */
  parkTicketUnreadCount?: number;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenHub: () => void;
  onOpenAccounts?: () => void;
  onNavigate?: (view: 'chat' | 'organization' | 'inbox' | 'work' | 'hub') => void;
  onJoinEnterprise?: (input: { inviteCode: string }) => Promise<void>;
  onLogout?: () => void | Promise<void>;
  onViewAll: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** 未读会话 ID 列表（桌面通知闪烁点数据源）。 */
  unreadSessions?: string[];
}

export function Sidebar({
  groups,
  activeSessionId,
  activeView = 'chat',
  accountManagementActive = false,
  enterpriseAccount,
  enterpriseUnreadCounts = {},
  parkTicketUnreadCount = 0,
  onSelect,
  onNewChat,
  onOpenAccounts,
  onNavigate,
  onJoinEnterprise,
  onSubmitEnterpriseVerification,
  onGetEnterpriseVerification,
  onCancelEnterpriseVerification,
  onReloadEnterpriseIdentity,
  onLogout,
  onRename,
  onDelete,
  unreadSessions,
}: SidebarProps): React.JSX.Element {
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [joinEnterpriseOpen, setJoinEnterpriseOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const sessionGroups = relativeSessionGroups(groups);
  const sessionCount = sessionGroups.reduce((total, group) => total + group.sessions.length, 0);
  const enterpriseUnreadTotal = Object.values(enterpriseUnreadCounts)
    .reduce((total, count) => total + count, 0);
  const countedEnterpriseSessions = new Set(
    Object.entries(enterpriseUnreadCounts)
      .filter(([, count]) => count > 0)
      .map(([sessionId]) => sessionId),
  );
  const unreadSessionRemainder = unreadSessions
    ?.filter((sessionId) => !countedEnterpriseSessions.has(sessionId)).length ?? 0;
  const unreadCount = enterpriseUnreadTotal + unreadSessionRemainder;

  return (
    <aside className="otto-sidebar">
      <div className="otto-sidebar__traffic" />

      <div className="otto-sidebar__brandrow">
        <span className="otto-brand">Otto</span>
        {unreadCount > 0 ? (
          <span
            className="otto-brand__unread"
            role="status"
            aria-label={`${unreadCount} 条未读消息`}
            title={`${unreadCount} 条未读消息`}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </div>

      <button type="button" className="otto-newchat" onClick={onNewChat}>
        <IconPlus size={15} />
        新建对话
      </button>

      {/* 主导航：五个一级入口，各自映射到主内容区的完整页面。 */}
      {onNavigate ? (
        <NavItems
          activeView={activeView}
          enterpriseUnreadCounts={enterpriseUnreadCounts}
          parkTicketUnreadCount={parkTicketUnreadCount}
          unreadSessions={unreadSessions}
          onNavigate={onNavigate}
        />
      ) : null}

      <div className="otto-sidebar__workspace">
        <section className="otto-conversations" aria-label="任务">
          <button
            type="button"
            className="otto-conversations__toggle"
            onClick={() => setSessionsOpen((value) => !value)}
            aria-expanded={sessionsOpen}
            aria-label={`任务（${sessionCount}）`}
          >
            <span>任务（{sessionCount}）</span>
            <IconChevronDown
              size={13}
              className={'otto-conversations__chevron' + (sessionsOpen ? '' : ' is-collapsed')}
            />
          </button>

          {sessionsOpen ? (
            <div className="otto-sessions">
              {sessionGroups.length === 0 ? (
                <div className="otto-group__label">暂无对话</div>
              ) : (
                sessionGroups.map((g) => (
                  <div key={g.label}>
                    <div className="otto-group__label">{g.label}</div>
                    {g.sessions.map((s) => (
                      <SessionItem
                        key={s.sessionId}
                        session={s}
                        active={s.sessionId === activeSessionId}
                        unread={unreadSessions?.includes(s.sessionId) ?? false}
                        onSelect={onSelect}
                        onRename={onRename}
                        onDelete={onDelete}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </section>
      </div>

      <div className="otto-sidebar__footer">
        {enterpriseAccount?.accountType !== 'personal'
          && enterpriseAccount?.isAdmin
          && onOpenAccounts ? (
          <button
            type="button"
            className={'otto-viewall otto-viewall--accounts' + (accountManagementActive ? ' is-active' : '')}
            onClick={onOpenAccounts}
            aria-current={accountManagementActive ? 'page' : undefined}
            title="CEO 企业管理中心"
          >
            <span className="otto-viewall__accounticon" aria-hidden>◎</span>
            CEO 管理
          </button>
        ) : null}
        {enterpriseAccount?.accountType === 'personal' && onJoinEnterprise ? (
          <button
            type="button"
            className="otto-viewall otto-viewall--upgrade"
            onClick={() => setJoinEnterpriseOpen(true)}
            title="使用邀请码加入企业，或直接创建企业"
          >
            <span className="otto-viewall__accounticon" aria-hidden>↗</span>
            加入企业
          </button>
        ) : null}
        {enterpriseAccount ? (
          <div className="otto-sidebar-account">
            <span className="otto-sidebar-account__avatar" aria-hidden>
              <IconUserAvatar size={34} />
            </span>
            <span className="otto-sidebar-account__copy">
              <strong>{enterpriseAccount.name}</strong>
              <small>{enterpriseAccount.department || '个人空间'}</small>
            </span>
            {onLogout ? (
              <button
                type="button"
                className="otto-sidebar-account__logout"
                onClick={() => setLogoutConfirmOpen(true)}
                aria-label="退出登录"
                title="退出登录"
              >
                退出
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {enterpriseAccount && onLogout ? (
        <LogoutConfirmDialog
          open={logoutConfirmOpen}
          accountName={enterpriseAccount.name}
          busy={logoutBusy}
          onCancel={() => setLogoutConfirmOpen(false)}
          onConfirm={() => {
            void (async () => {
              setLogoutBusy(true);
              try {
                await onLogout();
                setLogoutConfirmOpen(false);
              } finally {
                setLogoutBusy(false);
              }
            })();
          }}
        />
      ) : null}
      {enterpriseAccount?.accountType === 'personal' && onJoinEnterprise ? (
        <JoinEnterpriseDialog
          open={joinEnterpriseOpen}
          onCancel={() => setJoinEnterpriseOpen(false)}
          onConfirm={async (input) => {
            await onJoinEnterprise(input);
            setJoinEnterpriseOpen(false);
          }}
          onSubmitEnterpriseVerification={onSubmitEnterpriseVerification}
          onGetEnterpriseVerification={onGetEnterpriseVerification}
          onCancelEnterpriseVerification={onCancelEnterpriseVerification}
          onReloadEnterpriseIdentity={onReloadEnterpriseIdentity}
        />
      ) : null}
    </aside>
  );
}

function NavItems({
  activeView,
  enterpriseUnreadCounts,
  parkTicketUnreadCount,
  unreadSessions,
  onNavigate,
}: {
  activeView: string;
  enterpriseUnreadCounts: EnterpriseUnreadCounts;
  parkTicketUnreadCount: number;
  unreadSessions?: string[];
  onNavigate: (view: 'chat' | 'organization' | 'inbox' | 'work' | 'hub') => void;
}): React.JSX.Element {
  const { inboxUnread, workUnread } = computeNavBadgeCounts(
    enterpriseUnreadCounts,
    { actionableCount: parkTicketUnreadCount, creatorUpdateCount: 0, latestTimestamp: '', latestPreview: '' },
    unreadSessions,
  );

  // 追踪各入口的未读计数，变化时触发短暂 attention 动画。
  const [attentionKeys, setAttentionKeys] = useState<Set<string>>(new Set());
  const prevCounts = useRef<Record<string, number>>({ inbox: 0, work: 0 });

  useEffect(() => {
    const next: Record<string, number> = { inbox: inboxUnread, work: workUnread };
    const prev = prevCounts.current;
    const pulsed = new Set<string>();
    for (const key of ['inbox', 'work'] as const) {
      if (next[key] > prev[key]) pulsed.add(key);
    }
    if (pulsed.size === 0) return;
    prevCounts.current = next;
    setAttentionKeys(pulsed);
    const timer = window.setTimeout(() => setAttentionKeys(new Set()), 3000);
    return () => window.clearTimeout(timer);
  }, [inboxUnread, workUnread]);

  const navItems = [
    { key: 'chat', label: '工作台', view: 'chat', unread: 0 },
    { key: 'organization', label: '组织架构', view: 'organization', unread: 0 },
    { key: 'inbox', label: '我的消息', view: 'inbox', unread: inboxUnread },
    { key: 'work', label: '我的工作', view: 'work', unread: workUnread },
    { key: 'hub', label: '设置', view: 'hub', unread: 0 },
  ] as const;

  return (
    <nav className="otto-sidebar__nav" aria-label="主导航">
      {navItems.map((item) => {
        const isActive = activeView === item.view;
        const hasAttention = attentionKeys.has(item.key) && !isActive;
        return (
          <button
            key={item.key}
            type="button"
            className={
              'otto-sidebar__navitem'
              + (isActive ? ' is-active' : '')
              + (hasAttention ? ' is-attention' : '')
            }
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onNavigate(item.view)}
          >
            <span>{item.label}</span>
            {item.unread > 0 ? (
              <b
                className="otto-attention-badge"
                role="status"
                aria-label={`${item.unread} 条未读`}
              >
                {item.unread > 99 ? '99+' : item.unread}
              </b>
            ) : null}
          </button>
        );
      })}
    </nav>
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
  unread,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  unread?: boolean;
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
      {unread ? <span className="otto-session__unread" aria-label="未读消息" /> : null}
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
