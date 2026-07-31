/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 组织架构全页视图（导航一级入口）。
 *
 * 从 OrganizationTree 的侧栏小组件提升为完整页面：
 * 部门卡片 + 成员列表 + 在线状态 + 直聊入口。
 * 数据源与 OrganizationTree 相同（enterpriseOrganizationView IPC），
 * 但布局适配主内容区。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduleItemInfo } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { IconChevronDown } from './icons.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';

const ORGANIZATION_PAGE_REFRESH_MS = 15_000;

export interface OrganizationPageProps {
  enterpriseAccount?: EnterpriseAccount;
  organizationRefreshRevision?: number;
  schedules?: readonly ScheduleItemInfo[];
  enterpriseUnreadCounts?: EnterpriseUnreadCounts;
  enterpriseDirectChatOpenRequest?: { peerAccountId: string; requestId: number };
  onMessageRead?: (peerAccountId: string) => void;
  onBack: () => void;
}

export function OrganizationPage({
  enterpriseAccount,
  organizationRefreshRevision = 0,
  schedules = [],
  enterpriseUnreadCounts = {},
  enterpriseDirectChatOpenRequest,
  onMessageRead,
  onBack,
}: OrganizationPageProps): React.JSX.Element {
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>({});
  const [chatMembers, setChatMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const handledChatRequest = useRef(0);
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);

  // —— 数据加载 ——
  useEffect(() => {
    if (!hasAuth) return;
    let cancelled = false;
    const load = async (showSpinner: boolean): Promise<void> => {
      if (showSpinner) { setLoading(true); }
      try {
        const view = await window.otto.enterpriseOrganizationView();
        if (cancelled) return;
        setOrgView(view);
        setSyncedAt(new Date());
        setError(null);
        // 默认展开所有部门
        const depts: Record<string, boolean> = {};
        for (const m of view.members) {
          if (m.status === 'active') depts[m.department || '未分配部门'] = true;
        }
        setExpandedDepts((prev) => ({ ...depts, ...prev }));
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), ORGANIZATION_PAGE_REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [hasAuth, enterpriseAccount?.organizationId, enterpriseAccount?.updatedAt, organizationRefreshRevision]);

  // —— 外部直聊请求 ——
  useEffect(() => {
    if (!enterpriseDirectChatOpenRequest || !orgView) return;
    if (handledChatRequest.current === enterpriseDirectChatOpenRequest.requestId) return;
    const member = orgView.members.find(
      (m) => m.id === enterpriseDirectChatOpenRequest.peerAccountId
        && m.id !== enterpriseAccount?.id && m.status === 'active',
    );
    if (!member) return;
    handledChatRequest.current = enterpriseDirectChatOpenRequest.requestId;
    openChat(member);
  }, [enterpriseDirectChatOpenRequest, orgView, enterpriseAccount?.id]);

  const openChat = useCallback((member: EnterpriseOrganizationView['members'][number]) => {
    onMessageRead?.(member.id);
    setChatMembers((cur) => [
      ...cur.filter((c) => c.id !== member.id),
      member,
    ]);
  }, [onMessageRead]);

  const closeChat = useCallback((memberId: string) => {
    setChatMembers((cur) => cur.filter((c) => c.id !== memberId));
  }, []);

  // —— 部门分组 ——
  const departments = useMemo(() => {
    if (!orgView) return [];
    const map = new Map<string, EnterpriseOrganizationView['members']>();
    for (const m of orgView.members) {
      if (m.status !== 'active') continue;
      const dept = m.department || '未分配部门';
      if (!map.has(dept)) map.set(dept, []);
      map.get(dept)!.push(m);
    }
    return [...map.entries()].map(([name, members]) => ({
      name,
      members: members.sort((a, b) => {
        const onlineDiff = Number(Boolean(b.ottoOnline)) - Number(Boolean(a.ottoOnline));
        if (onlineDiff !== 0) return onlineDiff;
        return a.name.localeCompare(b.name, 'zh-CN');
      }),
      onlineCount: members.filter((m) => m.ottoOnline).length,
    }));
  }, [orgView]);

  const totalActive = useMemo(
    () => orgView?.members.filter((m) => m.status === 'active').length ?? 0,
    [orgView],
  );
  const totalOnline = useMemo(
    () => orgView?.members.filter((m) => m.status === 'active' && m.ottoOnline).length ?? 0,
    [orgView],
  );

  if (!hasAuth) {
    return (
      <div className="otto-org-page" role="region" aria-label="组织架构">
        <header className="otto-org-page__header">
          <div>
            <h1>组织架构</h1>
            <p>需要企业账号登录后查看</p>
          </div>
          <button type="button" onClick={onBack}>返回</button>
        </header>
        <div className="otto-org-page__empty">当前账号未关联企业组织。</div>
      </div>
    );
  }

  return (
    <div className="otto-org-page" role="region" aria-label="组织架构">
      <header className="otto-org-page__header">
        <div>
          <h1>{orgView?.organization?.name ?? '组织架构'}</h1>
          <p>
            {totalActive} 位成员 · {departments.length} 个部门
            {totalOnline > 0 ? ` · ${totalOnline} 人在线` : ''}
            {syncedAt ? ` · 同步于 ${syncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </p>
        </div>
        <button type="button" onClick={onBack}>返回对话</button>
      </header>

      {loading && !orgView ? (
        <div className="otto-org-page__empty">正在加载组织信息…</div>
      ) : error ? (
        <div className="otto-org-page__empty" role="alert">{error}</div>
      ) : !orgView ? (
        <div className="otto-org-page__empty">组织信息不可用</div>
      ) : (
        <div className="otto-org-page__body">
          {departments.map((dept) => {
            const expanded = expandedDepts[dept.name] !== false;
            return (
              <section key={dept.name} className="otto-org-page__dept">
                <button
                  type="button"
                  className="otto-org-page__dept-head"
                  onClick={() => setExpandedDepts((prev) => ({ ...prev, [dept.name]: !expanded }))}
                  aria-expanded={expanded}
                >
                  <strong>{dept.name}</strong>
                  <span>{dept.members.length} 人{dept.onlineCount > 0 ? ` · ${dept.onlineCount} 在线` : ''}</span>
                  <IconChevronDown size={14} className={expanded ? '' : 'is-collapsed'} />
                </button>
                {expanded ? (
                  <div className="otto-org-page__members">
                    {dept.members.map((member) => {
                      const isSelf = member.id === enterpriseAccount?.id;
                      const unread = enterpriseUnreadCounts[`enterprise:message:${member.id}`] ?? 0;
                      return (
                        <div key={member.id} className={`otto-org-page__member${isSelf ? ' is-self' : ''}`}>
                          <span className="otto-org-page__avatar" aria-hidden>
                            {member.name.slice(0, 1)}
                          </span>
                          <div className="otto-org-page__member-info">
                            <strong>
                              {member.name}
                              {isSelf ? <small>（我）</small> : null}
                              {member.isAdmin ? <small className="otto-org-page__admin-badge">管理员</small> : null}
                            </strong>
                            <span>{member.positionTitle || member.role || '成员'}</span>
                          </div>
                          <span className={`otto-org-page__presence${member.ottoOnline ? ' is-online' : ''}`}>
                            {member.ottoOnline ? '在线' : '离线'}
                          </span>
                          {unread > 0 ? (
                            <span className="otto-org-page__unread" role="status" aria-label={`${unread} 条未读`}>
                              {unread}
                            </span>
                          ) : null}
                          {!isSelf ? (
                            <button
                              type="button"
                              className="otto-org-page__chat-btn"
                              onClick={() => openChat(member)}
                              aria-label={`与 ${member.name} 聊天`}
                            >
                              发消息
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      )}

      {/* 直聊面板：复用 OrganizationTree 的 DirectMessagePanel */}
      {chatMembers.map((member, index) => (
        <OrganizationDirectChat
          key={member.id}
          member={member}
          currentAccount={enterpriseAccount}
          cascadeIndex={index}
          onClose={() => closeChat(member.id)}
        />
      ))}
    </div>
  );
}

/** 轻量直聊面板（全页模式下的浮窗） */
function OrganizationDirectChat({
  member,
  currentAccount,
  cascadeIndex,
  onClose,
}: {
  member: EnterpriseOrganizationView['members'][number];
  currentAccount?: EnterpriseAccount;
  cascadeIndex: number;
  onClose: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<Array<{
    id: string; content: string; mine: boolean; time: string;
  }>>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const cascade = (cascadeIndex % 6) * 24;

  // 加载历史消息
  useEffect(() => {
    let cancelled = false;
    void window.otto.enterpriseMessagesList(member.id).then((msgs) => {
      if (cancelled) return;
      setMessages(msgs.map((m) => ({
        id: m.id,
        content: m.content,
        mine: m.senderAccountId === currentAccount?.id,
        time: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      })));
    }).catch(() => { /* 消息加载失败不阻断 */ });
    return () => { cancelled = true; };
  }, [member.id, currentAccount?.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const msg = await window.otto.enterpriseMessageSend(member.id, text);
      setMessages((cur) => [...cur, {
        id: msg.id,
        content: msg.content,
        mine: true,
        time: new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
      }]);
      setInput('');
    } catch { /* 发送失败保留输入 */ } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="otto-org-page__chat-panel"
      role="dialog"
      aria-label={`与 ${member.name} 聊天`}
      style={{
        left: Math.min(260 + cascade, Math.max(12, window.innerWidth - 520)) + 'px',
        top: (60 + cascade) + 'px',
        zIndex: 60 + cascadeIndex,
      }}
    >
      <header className="otto-org-page__chat-header">
        <strong>{member.name}</strong>
        <span>{member.department || ''} · {member.positionTitle || member.role || ''}</span>
        <button type="button" onClick={onClose} aria-label="关闭聊天">×</button>
      </header>
      <div className="otto-org-page__chat-messages">
        {messages.length === 0 ? (
          <div className="otto-org-page__chat-empty">开始与 {member.name} 对话</div>
        ) : messages.map((msg) => (
          <div key={msg.id} className={`otto-org-page__chat-msg${msg.mine ? ' is-mine' : ''}`}>
            <span className="otto-org-page__chat-bubble">{msg.content}</span>
            <time>{msg.time}</time>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form
        className="otto-org-page__chat-composer"
        onSubmit={(e) => { e.preventDefault(); void send(); }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="输入消息…"
          rows={2}
          maxLength={4000}
          aria-label="消息内容"
        />
        <button type="submit" disabled={!input.trim() || sending}>
          {sending ? '发送中' : '发送'}
        </button>
      </form>
    </div>
  );
}
