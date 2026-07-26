/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProductWorkspaceSnapshot, ScheduleItemInfo } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { buildAtoaRequest, displayDirectMessageContent } from '../atoaProtocol.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { askLocalPeerOtto } from '../peerOttoRunner.js';
import { IconChevronDown, IconPlus } from './icons.js';
import { AtoaConsultDialog } from './AtoaConsultDialog.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';

const ORGANIZATION_REFRESH_MS = 10_000;

export function OrganizationTree({
  workspace,
  schedules = [],
  enterpriseAccount,
  openRequest = 0,
  refreshRevision = 0,
  unreadCounts = {},
  onMessageRead,
}: {
  workspace: ProductWorkspaceSnapshot | null;
  schedules?: readonly ScheduleItemInfo[];
  enterpriseAccount?: EnterpriseAccount;
  /** 右侧企业入口递增该值时，展开这里唯一的真实组织树。 */
  openRequest?: number;
  /** 企业管理员提交成员/职位变化后递增，强制重读服务端组织目录。 */
  refreshRevision?: number;
  unreadCounts?: EnterpriseUnreadCounts;
  onMessageRead?: (peerAccountId: string) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgSyncedAt, setOrgSyncedAt] = useState<Date | null>(null);
  const [manualRefreshRequest, setManualRefreshRequest] = useState(0);
  const [chatMember, setChatMember] = useState<EnterpriseOrganizationView['members'][number] | null>(null);
  const hasLocalEnterpriseWorkspace = workspace?.context.edition === 'enterprise';
  const hasAuthenticatedOrganization = isAuthenticatedEnterpriseAccount(enterpriseAccount);
  // 真实中心账号以服务端目录为权威，不能被机器上残留的本机企业树覆盖。
  // 只有没有真实中心账号时，才展示本机 ProductWorkspace 的组织框架。
  const organization = hasLocalEnterpriseWorkspace && !hasAuthenticatedOrganization
    ? workspace?.managerWorkspace?.organization
    : undefined;
  const chatMemberByWorkspaceKey = useMemo(() => {
    const result = new Map<string, EnterpriseOrganizationView['members'][number]>();
    for (const member of orgView?.members ?? []) {
      if (member.status !== 'active') continue;
      if (member.id === enterpriseAccount?.id) continue;
      result.set(normalizeChatKey(member.id), member);
      result.set(normalizeChatKey(member.username), member);
      result.set(normalizeChatKey(member.name), member);
    }
    return result;
  }, [enterpriseAccount?.id, orgView?.members]);
  const openDirectChat = useCallback((member: EnterpriseOrganizationView['members'][number]): void => {
    onMessageRead?.(member.id);
    setChatMember(member);
  }, [onMessageRead]);
  const positionById = useMemo(
    () => new Map(organization?.positions.map((item) => [item.id, item]) ?? []),
    [organization?.positions],
  );
  const childrenByParent = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const item of organization?.companies ?? []) {
      if (!item.parentCompanyId) continue;
      result.set(item.parentCompanyId, [...(result.get(item.parentCompanyId) ?? []), item.id]);
    }
    return result;
  }, [organization?.companies]);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  // 本地 workspace 没有管理员组织快照时，经 preload -> main 读取企业组织。
  // 会话 token 始终只保留在 main 的 EnterpriseClient 内。
  useEffect(() => {
    // 远程组织目录只允许真实企业账号触发；本机企业成员或内测假身份没有
    // Bearer 会话时展示占位信息，不调用 IPC，也不产生无意义的 401。
    if (!hasAuthenticatedOrganization) return;

    let cancelled = false;
    const loadOrganization = async (showLoading: boolean): Promise<void> => {
      if (showLoading) {
        setOrgLoading(true);
        setOrgView(null);
      }
      try {
        const view = await window.otto.enterpriseOrganizationView();
        if (cancelled) return;
        setOrgView(view);
        setOrgSyncedAt(new Date());
        setOrgError(null);
      } catch (error: unknown) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setOrgError(`组织信息加载失败：${message}`);
      } finally {
        if (!cancelled) setOrgLoading(false);
      }
    };

    void loadOrganization(true);
    const timer = window.setInterval(() => {
      void loadOrganization(false);
    }, ORGANIZATION_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    hasAuthenticatedOrganization,
    enterpriseAccount?.organizationId,
    enterpriseAccount?.updatedAt,
    refreshRevision,
    manualRefreshRequest,
  ]);

  if (!hasLocalEnterpriseWorkspace && !hasAuthenticatedOrganization) return null;

  return (
    <section className="otto-orgtree" aria-label="企业组织架构">
      <button
        type="button"
        className="otto-orgtree__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="otto-orgtree__company">企业组织</span>
        <IconChevronDown
          size={13}
          className={'otto-orgtree__chevron' + (open ? '' : ' is-collapsed')}
        />
      </button>

      {open ? (
        <div className="otto-orgtree__body">
          {organization && workspace ? (
            <CompanyBranch
              companyId={organization.rootCompanyId}
              organization={organization}
              workspace={workspace}
              positionById={positionById}
              childrenByParent={childrenByParent}
              chatMemberByWorkspaceKey={chatMemberByWorkspaceKey}
              unreadCounts={unreadCounts}
              onOpenChat={openDirectChat}
            />
          ) : orgView ? (
            <div className="otto-orgtree__member-list">
              {orgView.organization ? (
                <div className="otto-orgtree__company-node">{orgView.organization.name}</div>
              ) : null}
              <OrganizationPresenceSummary
                members={orgView.members}
                syncedAt={orgSyncedAt}
                refreshing={orgLoading}
                onRefresh={() => setManualRefreshRequest((value) => value + 1)}
              />
              {/* Group members by department */}
              {(() => {
                const deptMap = new Map<string, EnterpriseOrganizationView['members']>();
                for (const member of orgView.members) {
                  if (member.status !== 'active') continue;
                  const dept = member.department || '未分配部门';
                  if (!deptMap.has(dept)) deptMap.set(dept, []);
                  deptMap.get(dept)!.push(member);
                }
                return [...deptMap.entries()].map(([dept, members]) => (
                  <DepartmentSection key={dept} name={dept}>
                    {[...members].sort(compareEnterpriseMembers).map((member) => (
                      member.id === enterpriseAccount?.id ? (
                        <div
                          key={member.id}
                          className="otto-orgtree__member"
                          aria-label={`${member.name}（我）`}
                        >
                          <span>{member.name}</span>
                          <span>
                            {member.positionTitle ||
                              (member.isAdmin ? '管理员' : member.role || '成员')}
                          </span>
                          <small>我</small>
                        </div>
                      ) : (
                        <button
                          key={member.id}
                          type="button"
                          className="otto-orgtree__member otto-orgtree__member-button"
                          onClick={() => {
                            openDirectChat(member);
                          }}
                        >
                          <span>{member.name}</span>
                          <span>
                            {member.positionTitle ||
                              (member.isAdmin ? '管理员' : member.role || '成员')}
                          </span>
                          <PresenceBadge
                            online={member.ottoOnline}
                            lastSeenAt={member.ottoLastSeenAt}
                          />
                          <UnreadBadge count={unreadCounts[`enterprise:message:${member.id}`] ?? 0} />
                        </button>
                      )
                    ))}
                  </DepartmentSection>
                ));
              })()}
            </div>
          ) : orgLoading ? (
            <div className="otto-orgtree__vacant">正在加载组织信息…</div>
          ) : orgError ? (
            <div className="otto-orgtree__vacant">{orgError}</div>
          ) : (
            <div className="otto-orgtree__vacant">
              已通过链接加入；组织详情将在企业服务同步后显示。
            </div>
          )}
        </div>
      ) : null}
      {chatMember ? (
        <DirectMessagePanel
          member={chatMember}
          currentAccount={enterpriseAccount}
          schedules={schedules}
          onClose={() => setChatMember(null)}
        />
      ) : null}
    </section>
  );
}

function OrganizationPresenceSummary({
  members,
  syncedAt,
  refreshing,
  onRefresh,
}: {
  members: EnterpriseOrganizationView['members'];
  syncedAt: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const activeMembers = members.filter((member) => member.status === 'active');
  const onlineCount = activeMembers.filter((member) => member.ottoOnline).length;
  const knownPresenceCount = activeMembers.filter((member) =>
    member.ottoOnline !== undefined || member.ottoLastSeenAt !== undefined,
  ).length;
  return (
    <div className="otto-orgtree__presence-summary" aria-label="Otto 在线状态">
      <span>
        {knownPresenceCount > 0
          ? `${onlineCount}/${activeMembers.length} 在线`
          : '等待在线状态'}
      </span>
      {syncedAt ? (
        <small title={syncedAt.toLocaleString('zh-CN')}>
          {formatSyncedAt(syncedAt)}
        </small>
      ) : null}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="刷新企业组织在线状态"
        title="刷新企业组织在线状态"
      >
        {refreshing ? '同步中' : '刷新'}
      </button>
    </div>
  );
}

function compareEnterpriseMembers(
  a: EnterpriseOrganizationView['members'][number],
  b: EnterpriseOrganizationView['members'][number],
): number {
  const onlineRank = Number(Boolean(b.ottoOnline)) - Number(Boolean(a.ottoOnline));
  if (onlineRank !== 0) return onlineRank;
  const unreadRank = Number(Boolean(b.ottoLastSeenAt)) - Number(Boolean(a.ottoLastSeenAt));
  if (unreadRank !== 0) return unreadRank;
  return a.name.localeCompare(b.name, 'zh-CN');
}

function formatSyncedAt(date: Date): string {
  return `同步 ${date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatDirectMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function memberInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return 'OT';
  const chars = Array.from(clean);
  return chars.slice(0, 2).join('').toUpperCase();
}

function DirectMessagePanel({
  member,
  currentAccount,
  schedules,
  onClose,
}: {
  member: EnterpriseOrganizationView['members'][number];
  currentAccount?: EnterpriseAccount;
  schedules: readonly ScheduleItemInfo[];
  onClose: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [askingOwnOtto, setAskingOwnOtto] = useState(false);
  const [askingPeerOtto, setAskingPeerOtto] = useState(false);
  const [collaborationMenuOpen, setCollaborationMenuOpen] = useState(false);
  const [consultOpen, setConsultOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await window.otto.enterpriseMessagesList(member.id);
        if (active) { setMessages(next); setError(''); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [member.id]);

  const buildTranscriptContext = (): string => {
    const myName = currentAccount?.name || '我';
    const transcript = messages.slice(-40).map((message) => {
      const speaker = message.senderAccountId === member.id ? member.name : myName;
      const createdAt = message.createdAt
        ? new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })
        : '';
      return `- ${createdAt} ${speaker}: ${message.content}`;
    }).join('\n');
    return [
      '当前是在企业一对一聊天窗口中询问自己的 Otto；本次回答会发送给聊天对方可见。',
      '请结合当前聊天记录和我本机 Otto 已获授权的资料回答，不要编造。',
      '',
      '当前聊天记录：',
      transcript || '（当前还没有可用聊天记录）',
    ].join('\n');
  };

  const askOtto = async (question?: string) => {
    const cleanQuestion = (question?.trim() || draft.trim()).slice(0, 1200);
    if (!cleanQuestion || askingOwnOtto) return;
    setAskingOwnOtto(true);
    try {
      const answer = await askLocalPeerOtto({
        question: cleanQuestion,
        workContext: buildTranscriptContext(),
        requestId: `own-a2a-${crypto.randomUUID()}`,
        clientMessageId: `own-a2a-message-${crypto.randomUUID()}`,
      });
      const content = [
        `我问了自己的 Otto（基于：我的 Otto 可用资料）：${cleanQuestion}`,
        '',
        'Otto：',
        answer,
      ].join('\n');
      const message = await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAskingOwnOtto(false);
    }
  };

  const askPeerOtto = async (question?: string) => {
    const content = buildAtoaRequest(question?.trim() || draft.trim());
    setAskingPeerOtto(true);
    try {
      const message = await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAskingPeerOtto(false);
    }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    const ottoShortcut = content.match(/^@otto(?:\s+|$)([\s\S]*)$/i);
    if (ottoShortcut) {
      await askOtto(ottoShortcut[1] || undefined);
      return;
    }
    const peerOttoShortcut = content.match(/^@peer-otto(?:\s+|$)([\s\S]*)$/i);
    if (peerOttoShortcut) {
      await askPeerOtto(peerOttoShortcut[1] || undefined);
      return;
    }
    setSending(true);
    try {
      const message = await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const subtitle = [member.department, member.role].filter(Boolean).join(' · ') || member.username;
  const presenceLabel = member.ottoOnline ? '在线' : member.ottoLastSeenAt ? '最近在线' : '离线';

  return (
    <div className="otto-direct-chat" role="dialog" aria-label={`与 ${member.name} 聊天`}>
      <header className="otto-direct-chat__header">
        <div className="otto-direct-chat__identity">
          <div className="otto-direct-chat__avatar" aria-hidden="true">{memberInitials(member.name)}</div>
          <div className="otto-direct-chat__titleblock">
            <strong>{member.name}</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <div className="otto-direct-chat__header-actions">
          <span className={'otto-direct-chat__presence' + (member.ottoOnline ? ' is-online' : '')}>{presenceLabel}</span>
          <button
            type="button"
            className="otto-direct-chat__icon"
            onClick={onClose}
            aria-label="关闭聊天"
            title="关闭聊天"
          >
            ×
          </button>
        </div>
      </header>

      <div className="otto-direct-chat__actionbar" aria-label="Otto 协作操作">
        <button
          type="button"
          className="otto-direct-chat__otto"
          disabled={askingOwnOtto || !draft.trim()}
          onClick={() => void askOtto(draft)}
        >
          {askingOwnOtto ? '询问中' : '问 Otto'}
        </button>
        <button
          type="button"
          className="otto-direct-chat__otto"
          disabled={askingPeerOtto}
          onClick={() => void askPeerOtto(draft)}
        >
          问对方 Otto
        </button>
        {currentAccount ? (
          <div className="otto-direct-chat__a2a-menu">
            <button
              type="button"
              className="otto-direct-chat__plus"
              aria-label="更多 Otto 协作"
              aria-expanded={collaborationMenuOpen}
              onClick={() => setCollaborationMenuOpen((value) => !value)}
            >
              <IconPlus size={15} />
            </button>
            {collaborationMenuOpen ? (
              <div className="otto-direct-chat__a2a-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCollaborationMenuOpen(false);
                    setConsultOpen(true);
                  }}
                >
                  <strong>双方 Otto 协商</strong>
                  <small>会议时间、合作计划与双方日程</small>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="otto-direct-chat__messages">
        {messages.length === 0 ? (
          <div className="otto-direct-chat__empty">
            <strong>还没有消息，开始聊聊吧。</strong>
            <span>企业私聊只同步当前会话；需要自动整理上下文时可使用 Otto 协作。</span>
          </div>
        ) : messages.map((message) => {
          const mine = message.senderAccountId !== member.id;
          return (
            <article
              key={message.id}
              className={'otto-direct-chat__message' + (mine ? ' is-me' : ' is-peer')}
            >
              <div className="otto-direct-chat__message-meta">
                <span>{mine ? '我' : member.name}</span>
                {message.createdAt ? <time dateTime={message.createdAt}>{formatDirectMessageTime(message.createdAt)}</time> : null}
              </div>
              <div className="otto-direct-chat__bubble">{displayDirectMessageContent(message.content)}</div>
            </article>
          );
        })}
      </div>
      {error ? <div className="otto-direct-chat__error" role="alert">{error}</div> : null}
      <form className="otto-direct-chat__composer" onSubmit={send}>
        <textarea
          value={draft}
          maxLength={4000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入消息"
          aria-label="消息内容"
        />
        <div className="otto-direct-chat__composer-footer">
          <span>{draft.trim().length > 0 ? draft.trim().length + '/4000' : 'Enter 发送'}</span>
          <button type="submit" disabled={!draft.trim() || sending}>{sending ? '发送中' : '发送'}</button>
        </div>
      </form>
      {consultOpen && currentAccount ? (
        <AtoaConsultDialog
          account={currentAccount}
          member={member}
          schedules={schedules}
          initialQuestion={draft}
          onClose={() => setConsultOpen(false)}
          onSent={(message) => {
            setMessages((current) => [...current, message]);
            setDraft('');
            setError('');
          }}
        />
      ) : null}
    </div>
  );
}

type Organization = NonNullable<
  ProductWorkspaceSnapshot['managerWorkspace']
>['organization'];

function DepartmentSection({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="otto-orgtree__department">
      <button
        type="button"
        className="otto-orgtree__department-name otto-orgtree__department-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <IconChevronDown
          size={11}
          className={'otto-orgtree__chevron' + (expanded ? '' : ' is-collapsed')}
        />
        <span>{name}</span>
      </button>
      {expanded ? children : null}
    </div>
  );
}

function normalizeChatKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function UnreadBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      className="otto-orgtree__unread"
      aria-label={`${label} 条未读消息`}
      title={`${label} 条未读消息`}
    >
      {label}
    </span>
  );
}

function PresenceBadge({
  online,
  lastSeenAt,
}: {
  online?: boolean;
  lastSeenAt?: string | null;
}): React.JSX.Element | null {
  if (online === undefined && lastSeenAt === undefined) return null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const recentlySeen = !online
    && Number.isFinite(lastSeenMs)
    && Date.now() - lastSeenMs <= 5 * 60_000;
  const label = online ? '在线' : recentlySeen ? '刚刚在线' : '离线';
  return (
    <span
      className={
        'otto-orgtree__presence'
        + (online ? ' is-online' : recentlySeen ? ' is-recent' : '')
      }
      title={lastSeenAt ? `${label} · ${new Date(lastSeenAt).toLocaleString('zh-CN')}` : label}
    >
      {label}
    </span>
  );
}

function CompanyBranch({
  companyId,
  organization,
  workspace,
  positionById,
  childrenByParent,
  chatMemberByWorkspaceKey,
  unreadCounts,
  onOpenChat,
}: {
  companyId: string;
  organization: Organization;
  workspace: ProductWorkspaceSnapshot;
  positionById: Map<string, Organization['positions'][number]>;
  childrenByParent: Map<string, string[]>;
  chatMemberByWorkspaceKey: Map<string, EnterpriseOrganizationView['members'][number]>;
  unreadCounts: EnterpriseUnreadCounts;
  onOpenChat: (member: EnterpriseOrganizationView['members'][number]) => void;
}): React.JSX.Element | null {
  const company = organization.companies.find((item) => item.id === companyId);
  if (!company) return null;
  const departments = organization.departments.filter((item) => item.companyId === company.id);
  const childIds = childrenByParent.get(company.id) ?? [];

  return (
    <div className="otto-orgtree__company-branch">
      <div className="otto-orgtree__company-node">{company.name}</div>
      <div className="otto-orgtree__company-content">
        {departments.map((department) => {
          const members = workspace.members.filter(
            (member) => member.companyId === company.id && member.departmentId === department.id,
          );
          const positions = organization.positions.filter(
            (position) => position.departmentId === department.id,
          );
          return (
            <DepartmentSection key={department.id} name={department.name}>
              {members.map((member) => {
                const chatMember = chatMemberByWorkspaceKey.get(normalizeChatKey(member.userId))
                  ?? chatMemberByWorkspaceKey.get(normalizeChatKey(member.displayName));
                const content = (
                  <>
                    <span>{member.displayName}</span>
                    <span>{member.positionId ? positionById.get(member.positionId)?.title ?? '成员' : '成员'}</span>
                  </>
                );
                return chatMember ? (
                  <button
                    key={member.userId}
                    type="button"
                    className="otto-orgtree__member otto-orgtree__member-button"
                    onClick={() => onOpenChat(chatMember)}
                  >
                    {content}
                    <PresenceBadge
                      online={chatMember.ottoOnline}
                      lastSeenAt={chatMember.ottoLastSeenAt}
                    />
                    <UnreadBadge count={unreadCounts[`enterprise:message:${chatMember.id}`] ?? 0} />
                  </button>
                ) : (
                  <div key={member.userId} className="otto-orgtree__member">
                    {content}
                  </div>
                );
              })}
              {members.length === 0
                ? positions.map((position) => (
                    <div key={position.id} className="otto-orgtree__vacant">
                      {position.title} · 待加入
                    </div>
                  ))
                : null}
            </DepartmentSection>
          );
        })}
        {departments.length === 0 ? (
          <div className="otto-orgtree__vacant">组织详情等待企业服务同步</div>
        ) : null}
        {childIds.map((childId) => (
          <CompanyBranch
            key={childId}
            companyId={childId}
            organization={organization}
            workspace={workspace}
            positionById={positionById}
            childrenByParent={childrenByParent}
            chatMemberByWorkspaceKey={chatMemberByWorkspaceKey}
            unreadCounts={unreadCounts}
            onOpenChat={onOpenChat}
          />
        ))}
      </div>
    </div>
  );
}
