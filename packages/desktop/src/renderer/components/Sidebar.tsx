/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 左侧栏。以会话列表为主体：
 *   品牌 Otto / + 新建对话 / 可按时间或工作目录分组的会话列表（flex:1 主体）/
 *   底部账号区（辅助入口与当前账号）。
 *   常用工具（企业专家入口、全部智能体）已迁往右侧 RightPanel。
 *
 * 会话项支持 hover 溢出菜单（⋯ → 重命名 / 删除）：
 *   - 重命名走 inline 输入框（双击标题 或 菜单「重命名」→ 变输入框，Enter 提交、Esc 取消）。
 *   - 删除**二次确认**走居中弹窗 ConfirmDialog（半透明遮罩 + 居中卡片），删除不可逆。
 * 会话项因此从 <button> 改为 role=button 的 <div>：按钮不能嵌按钮/输入框（无效 HTML）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionSummary } from 'otto-server';
import { computeNavBadgeCounts } from '../attentionCenter.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  IconPlus,
  IconChevronDown,
  IconUserAvatar,
  IconSettings,
  IconLogOut,
  IconFolder,
  IconCheck,
  IconPersonalization,
} from './icons.js';
import { LogoutConfirmDialog } from './LogoutConfirmDialog.js';
import { JoinEnterpriseDialog } from './JoinEnterpriseDialog.js';
import type { EnterpriseAccount } from '../../preload/index.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';
import type { UiModePreferenceScope } from '../uiModePreference.js';
import {
  groupSessionsForSidebar,
  readSessionListPreference,
  sessionListPreferenceStorageKey,
  writeSessionListPreference,
  type SessionListPreference,
} from '../sessionListView.js';

const GROUPING_MENU_WIDTH = 218;
const GROUPING_MENU_VIEWPORT_MARGIN = 12;
const GROUPING_MENU_TRIGGER_GAP = 4;

function getGroupingMenuPosition(rect: DOMRect): { top: number; left: number } {
  const maxLeft = Math.max(
    GROUPING_MENU_VIEWPORT_MARGIN,
    window.innerWidth - GROUPING_MENU_WIDTH - GROUPING_MENU_VIEWPORT_MARGIN,
  );
  return {
    top: rect.bottom + GROUPING_MENU_TRIGGER_GAP,
    left: Math.min(Math.max(GROUPING_MENU_VIEWPORT_MARGIN, rect.left), maxLeft),
  };
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface SidebarProps {
  sessions: SessionSummary[];
  preferenceScope: UiModePreferenceScope;
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
  sessions,
  preferenceScope,
  activeSessionId,
  hubActive = false,
  updateBadge = false,
  activeView = 'chat',
  accountManagementActive = false,
  enterpriseAccount,
  enterpriseUnreadCounts = {},
  parkTicketUnreadCount = 0,
  onSelect,
  onNewChat,
  onOpenHub,
  onOpenAccounts,
  onNavigate,
  onJoinEnterprise,
  onLogout,
  onRename,
  onDelete,
  unreadSessions,
}: SidebarProps): React.JSX.Element {
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [workspaceScrollbarActive, setWorkspaceScrollbarActive] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [joinEnterpriseOpen, setJoinEnterpriseOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [groupingMenuOpen, setGroupingMenuOpen] = useState(false);
  const [groupingMenuPosition, setGroupingMenuPosition] = useState({ top: 0, left: 0 });
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuItemRef = useRef<HTMLButtonElement>(null);
  const groupingMenuRef = useRef<HTMLDivElement>(null);
  const groupingMenuSurfaceRef = useRef<HTMLDivElement>(null);
  const groupingMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const groupingMenuItemRef = useRef<HTMLButtonElement>(null);
  const workspaceScrollbarHideTimerRef = useRef<number | null>(null);
  const preferenceKey = sessionListPreferenceStorageKey(preferenceScope);
  const [preferenceState, setPreferenceState] = useState<{
    key: string;
    preference: SessionListPreference;
  }>(() => ({
    key: preferenceKey,
    preference: readSessionListPreference(preferenceScope),
  }));
  const preference = preferenceState.key === preferenceKey
    ? preferenceState.preference
    : readSessionListPreference(preferenceScope);
  const sessionGroups = useMemo(
    () => groupSessionsForSidebar(sessions, preference.mode),
    [preference.mode, sessions],
  );
  const sessionCount = sessions.length;
  const collapsedWorkspaceKeys = useMemo(
    () => new Set(preference.collapsedWorkspaceKeys),
    [preference.collapsedWorkspaceKeys],
  );
  const activeWorkspaceGroupKey = preference.mode === 'workspace'
    ? sessionGroups.find((group) => group.sessions.some(
      (session) => session.sessionId === activeSessionId,
    ))?.key
    : undefined;
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

  const revealWorkspaceScrollbar = (): void => {
    setWorkspaceScrollbarActive(true);
    if (workspaceScrollbarHideTimerRef.current !== null) {
      window.clearTimeout(workspaceScrollbarHideTimerRef.current);
    }
    workspaceScrollbarHideTimerRef.current = window.setTimeout(() => {
      setWorkspaceScrollbarActive(false);
      workspaceScrollbarHideTimerRef.current = null;
    }, 900);
  };

  const commitPreference = (next: SessionListPreference): void => {
    setPreferenceState({ key: preferenceKey, preference: next });
    writeSessionListPreference(preferenceScope, next);
  };

  useEffect(() => {
    if (preferenceState.key === preferenceKey) return;
    setPreferenceState({
      key: preferenceKey,
      preference: readSessionListPreference(preferenceScope),
    });
  }, [preferenceKey, preferenceScope, preferenceState.key]);

  useEffect(() => () => {
    if (workspaceScrollbarHideTimerRef.current !== null) {
      window.clearTimeout(workspaceScrollbarHideTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!activeWorkspaceGroupKey
      || !preference.collapsedWorkspaceKeys.includes(activeWorkspaceGroupKey)) return;
    commitPreference({
      ...preference,
      collapsedWorkspaceKeys: preference.collapsedWorkspaceKeys.filter(
        (key) => key !== activeWorkspaceGroupKey,
      ),
    });
    // 只在当前会话、工作目录组或模式变化时自动展开；用户之后仍可手动折叠。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeWorkspaceGroupKey, preference.mode, preferenceKey]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    accountMenuItemRef.current?.focus();

    const onDocumentMouseDown = (event: MouseEvent): void => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setAccountMenuOpen(false);
      accountMenuTriggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!groupingMenuOpen) return;
    groupingMenuItemRef.current?.focus();

    const onDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!groupingMenuRef.current?.contains(target)
        && !groupingMenuSurfaceRef.current?.contains(target)) {
        setGroupingMenuOpen(false);
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setGroupingMenuOpen(false);
      groupingMenuTriggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    const repositionMenu = (): void => {
      const rect = groupingMenuTriggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setGroupingMenuPosition(getGroupingMenuPosition(rect));
    };
    window.addEventListener('resize', repositionMenu);
    window.addEventListener('scroll', repositionMenu, true);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('resize', repositionMenu);
      window.removeEventListener('scroll', repositionMenu, true);
    };
  }, [groupingMenuOpen]);

  const toggleGroupingMenu = (): void => {
    if (groupingMenuOpen) {
      setGroupingMenuOpen(false);
      return;
    }
    const rect = groupingMenuTriggerRef.current?.getBoundingClientRect();
    if (rect) {
      setGroupingMenuPosition(getGroupingMenuPosition(rect));
    }
    setGroupingMenuOpen(true);
  };

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

      {/* 主导航：四个一级业务入口，设置已迁移到底部账户区。 */}
      {onNavigate ? (
        <NavItems
          activeView={activeView}
          enterpriseUnreadCounts={enterpriseUnreadCounts}
          parkTicketUnreadCount={parkTicketUnreadCount}
          unreadSessions={unreadSessions}
          onNavigate={onNavigate}
        />
      ) : null}

      <div
        className={`otto-sidebar__workspace${workspaceScrollbarActive ? ' is-scrollbar-active' : ''}`}
        onPointerMove={revealWorkspaceScrollbar}
        onScroll={revealWorkspaceScrollbar}
        onWheel={revealWorkspaceScrollbar}
        onKeyDown={revealWorkspaceScrollbar}
      >
        <section className="otto-conversations" aria-label="任务">
          <div className="otto-conversations__header">
            <button
              type="button"
              className="otto-conversations__toggle"
              onClick={() => setSessionsOpen((value) => !value)}
              aria-expanded={sessionsOpen}
              aria-label={`任务（${sessionCount}）`}
            >
              <span className="otto-conversations__title">
                <span>任务</span>
                <span className="otto-conversations__count" aria-hidden="true">
                  {sessionCount}
                </span>
              </span>
              <IconChevronDown
                size={13}
                className={'otto-conversations__chevron' + (sessionsOpen ? '' : ' is-collapsed')}
              />
            </button>
            <div className="otto-session-grouping" ref={groupingMenuRef}>
              <button
                ref={groupingMenuTriggerRef}
                type="button"
                className="otto-session-grouping__trigger"
                aria-label="视图选项"
                aria-haspopup="menu"
                aria-expanded={groupingMenuOpen}
                onClick={toggleGroupingMenu}
              >
                <IconPersonalization size={16} />
              </button>
              {groupingMenuOpen ? createPortal(
                <div
                  ref={groupingMenuSurfaceRef}
                  className="otto-session-grouping__menu"
                  role="menu"
                  aria-label="视图选项"
                  style={groupingMenuPosition}
                >
                  <div className="otto-session-grouping__menulabel" role="presentation">
                    分组方式
                  </div>
                  {([
                    ['time', '按时间'],
                    ['workspace', '按工作目录'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      ref={mode === preference.mode ? groupingMenuItemRef : undefined}
                      type="button"
                      role="menuitemradio"
                      aria-checked={preference.mode === mode}
                      className="otto-session-grouping__menuitem"
                      onClick={() => {
                        commitPreference({ ...preference, mode });
                        setGroupingMenuOpen(false);
                        groupingMenuTriggerRef.current?.focus();
                      }}
                    >
                      <span>{label}</span>
                      {preference.mode === mode ? <IconCheck size={16} /> : null}
                    </button>
                  ))}
                </div>,
                document.body,
              ) : null}
            </div>
          </div>

          {sessionsOpen ? (
            <div className="otto-sessions">
              {sessionGroups.length === 0 ? (
                <div className="otto-group__label">暂无对话</div>
              ) : (
                sessionGroups.map((group) => {
                  const collapsed = group.collapsible && collapsedWorkspaceKeys.has(group.key);
                  const groupUnreadCount = group.sessions.filter(
                    (session) => unreadSessions?.includes(session.sessionId),
                  ).length;
                  return (
                    <div
                      key={group.key}
                      className={`otto-session-group${group.collapsible ? ' otto-session-group--workspace' : ''}`}
                    >
                      {group.collapsible ? (
                        <button
                          type="button"
                          className="otto-workspace-group__toggle"
                          aria-expanded={!collapsed}
                          aria-label={
                            `${group.label}，${group.sessions.length} 个任务`
                            + (groupUnreadCount > 0 ? `，${groupUnreadCount} 个未读任务` : '')
                          }
                          title={group.fullPath}
                          onClick={() => {
                            const nextCollapsed = collapsed
                              ? preference.collapsedWorkspaceKeys.filter((key) => key !== group.key)
                              : [...preference.collapsedWorkspaceKeys, group.key];
                            commitPreference({
                              ...preference,
                              collapsedWorkspaceKeys: nextCollapsed,
                            });
                          }}
                        >
                          <IconChevronDown
                            size={12}
                            className={'otto-conversations__chevron' + (collapsed ? ' is-collapsed' : '')}
                          />
                          <IconFolder size={14} />
                          <span className="otto-workspace-group__label">{group.label}</span>
                          <span className="otto-workspace-group__count">{group.sessions.length}</span>
                          {groupUnreadCount > 0 ? (
                            <span
                              className="otto-workspace-group__unread"
                              aria-hidden="true"
                            >
                              {groupUnreadCount > 99 ? '99+' : groupUnreadCount}
                            </span>
                          ) : null}
                        </button>
                      ) : (
                        <div className="otto-group__label">{group.label}</div>
                      )}
                      {!collapsed ? group.sessions.map((session) => (
                        <SessionItem
                          key={session.sessionId}
                          session={session}
                          active={session.sessionId === activeSessionId}
                          unread={unreadSessions?.includes(session.sessionId) ?? false}
                          onSelect={onSelect}
                          onRename={onRename}
                          onDelete={onDelete}
                        />
                      )) : null}
                    </div>
                  );
                })
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
            title="使用企业邀请码升级"
          >
            <span className="otto-viewall__accounticon" aria-hidden>↗</span>
            升级企业版
          </button>
        ) : null}
        {enterpriseAccount ? (
          <div className="otto-sidebar-account" ref={accountMenuRef}>
            <button
              ref={accountMenuTriggerRef}
              type="button"
              className="otto-sidebar-account__identity"
              aria-label={`${enterpriseAccount.name}，${enterpriseAccount.department || '个人空间'}`}
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((open) => !open)}
            >
              <span className="otto-sidebar-account__avatar" aria-hidden>
                <IconUserAvatar size={34} />
              </span>
              <span className="otto-sidebar-account__copy">
                <strong>{enterpriseAccount.name}</strong>
                <small>{enterpriseAccount.department || '个人空间'}</small>
              </span>
            </button>
            <button
              type="button"
              className={'otto-sidebar-account__settings' + (hubActive || activeView === 'hub' ? ' is-active' : '')}
              onClick={() => {
                setAccountMenuOpen(false);
                onOpenHub();
              }}
              aria-label="设置"
              aria-current={hubActive || activeView === 'hub' ? 'page' : undefined}
              title="设置"
            >
              <IconSettings size={17} />
              {updateBadge ? <span className="otto-sidebar-account__update" aria-label="有可用更新" /> : null}
            </button>
            {accountMenuOpen ? (
              <div className="otto-sidebar-account__menu" role="menu" aria-label="账户菜单">
                {onLogout ? (
                  <button
                    ref={accountMenuItemRef}
                    type="button"
                    role="menuitem"
                    className="otto-sidebar-account__menuitem otto-sidebar-account__menuitem--danger"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      setLogoutConfirmOpen(true);
                    }}
                  >
                    <IconLogOut size={16} />
                    <span>退出登录</span>
                  </button>
                ) : null}
              </div>
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
