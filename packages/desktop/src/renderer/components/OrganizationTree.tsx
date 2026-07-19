/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { buildAtoaRequest, displayDirectMessageContent } from '../atoaProtocol.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { IconChevronDown } from './icons.js';

export function OrganizationTree({
  workspace,
  enterpriseAccount,
  openRequest = 0,
  onAskOttoFromDirectChat,
}: {
  workspace: ProductWorkspaceSnapshot | null;
  enterpriseAccount?: EnterpriseAccount;
  /** 右侧企业入口递增该值时，展开这里唯一的真实组织树。 */
  openRequest?: number;
  onAskOttoFromDirectChat?: (input: DirectChatOttoRequest) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
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
      result.set(normalizeChatKey(member.id), member);
      result.set(normalizeChatKey(member.username), member);
      result.set(normalizeChatKey(member.name), member);
    }
    return result;
  }, [orgView?.members]);
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
    setOrgLoading(true);
    setOrgError(null);
    setOrgView(null);
    void window.otto.enterpriseOrganizationView()
      .then((view) => {
        if (!cancelled) setOrgView(view);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setOrgError(`组织信息加载失败：${message}`);
      })
      .finally(() => {
        if (!cancelled) setOrgLoading(false);
      });

    return () => { cancelled = true; };
  }, [
    hasAuthenticatedOrganization,
    enterpriseAccount?.organizationId,
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
              onOpenChat={setChatMember}
            />
          ) : orgView ? (
            <div className="otto-orgtree__member-list">
              {orgView.organization ? (
                <div className="otto-orgtree__company-node">{orgView.organization.name}</div>
              ) : null}
              {/* Group members by department */}
              {(() => {
                const deptMap = new Map<string, EnterpriseOrganizationView['members']>();
                for (const member of orgView.members) {
                  const dept = member.department || '未分配部门';
                  if (!deptMap.has(dept)) deptMap.set(dept, []);
                  deptMap.get(dept)!.push(member);
                }
                return [...deptMap.entries()].map(([dept, members]) => (
                  <div key={dept} className="otto-orgtree__department">
                    <div className="otto-orgtree__department-name">{dept}</div>
                    {members.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        className="otto-orgtree__member otto-orgtree__member-button"
                        onClick={() => setChatMember(member)}
                      >
                        <span>{member.name}</span>
                        <span>{member.isAdmin ? '管理员' : member.role || '成员'}</span>
                      </button>
                    ))}
                  </div>
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
          onClose={() => setChatMember(null)}
          onAskOtto={onAskOttoFromDirectChat}
        />
      ) : null}
    </section>
  );
}

export interface DirectChatOttoRequest {
  member: EnterpriseOrganizationView['members'][number];
  messages: EnterpriseDirectMessage[];
  question?: string;
}

function DirectMessagePanel({ member, onClose, onAskOtto }: {
  member: EnterpriseOrganizationView['members'][number];
  onClose: () => void;
  onAskOtto?: (input: DirectChatOttoRequest) => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [askingPeerOtto, setAskingPeerOtto] = useState(false);

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

  const askOtto = (question?: string) => {
    onAskOtto?.({
      member,
      messages,
      question: question?.trim() || undefined,
    });
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
      askOtto(ottoShortcut[1] || undefined);
      setDraft('');
      setError('');
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

  return (
    <div className="otto-direct-chat" role="dialog" aria-label={`与 ${member.name} 聊天`}>
      <header>
        <strong>{member.name}</strong>
        {onAskOtto ? (
          <button
            type="button"
            className="otto-direct-chat__otto"
            onClick={() => askOtto(draft)}
          >
            问 Otto
          </button>
        ) : null}
        <button
          type="button"
          className="otto-direct-chat__otto"
          disabled={askingPeerOtto}
          onClick={() => void askPeerOtto(draft)}
        >
          问对方 Otto
        </button>
        <button type="button" onClick={onClose} aria-label="关闭聊天">×</button>
      </header>
      <div className="otto-direct-chat__messages">
        {messages.length === 0 ? <p>还没有消息，开始聊聊吧。</p> : messages.map((message) => (
          <div
            key={message.id}
            className={'otto-direct-chat__message' + (message.senderAccountId === member.id ? ' is-peer' : ' is-me')}
          >
            {displayDirectMessageContent(message.content)}
          </div>
        ))}
      </div>
      {error ? <div className="otto-direct-chat__error" role="alert">{error}</div> : null}
      <form onSubmit={send}>
        <input
          value={draft}
          maxLength={4000}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入消息"
          aria-label="消息内容"
        />
        <button type="submit" disabled={!draft.trim() || sending}>{sending ? '发送中' : '发送'}</button>
      </form>
    </div>
  );
}

type Organization = NonNullable<
  ProductWorkspaceSnapshot['managerWorkspace']
>['organization'];

function normalizeChatKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function CompanyBranch({
  companyId,
  organization,
  workspace,
  positionById,
  childrenByParent,
  chatMemberByWorkspaceKey,
  onOpenChat,
}: {
  companyId: string;
  organization: Organization;
  workspace: ProductWorkspaceSnapshot;
  positionById: Map<string, Organization['positions'][number]>;
  childrenByParent: Map<string, string[]>;
  chatMemberByWorkspaceKey: Map<string, EnterpriseOrganizationView['members'][number]>;
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
            <div key={department.id} className="otto-orgtree__department">
              <div className="otto-orgtree__department-name">{department.name}</div>
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
            </div>
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
            onOpenChat={onOpenChat}
          />
        ))}
      </div>
    </div>
  );
}
