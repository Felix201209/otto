/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 组织架构全页视图（导航一级入口）。
 *
 * 数据源与底层企业目录完全一致：enterpriseOrganizationView IPC 返回的
 * organization / members / structure(EnterpriseOrganizationDepartment[])。
 * 页面按「企业 → 部门 → 岗位 → 成员」渲染真实树状结构；部门、岗位顺序与
 * structure 保持一致，成员按在线状态与姓名排序，未分配部门/岗位的成员会
 * 归入对应兜底节点，不使用任何假数据。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationDepartment,
  EnterpriseOrganizationPosition,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { IconChevronDown } from './icons.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';

const ORGANIZATION_PAGE_REFRESH_MS = 15_000;
const UNASSIGNED_DEPARTMENT = '未分配部门';
const FALLBACK_POSITION = '成员';

type EnterpriseOrganizationMember = EnterpriseOrganizationView['members'][number];

interface OrganizationPositionNode {
  key: string;
  id: string | null;
  title: string;
  roleMapping: EnterpriseOrganizationPosition['roleMapping'] | null;
  order: number;
  members: EnterpriseOrganizationMember[];
}

interface OrganizationDepartmentNode {
  key: string;
  id: string | null;
  name: string;
  order: number;
  /** 优先使用服务端 structure.memberCount；动态兜底部门使用已加载成员数。 */
  memberCount: number;
  members: EnterpriseOrganizationMember[];
  positions: OrganizationPositionNode[];
}

type MutableOrganizationDepartmentNode = OrganizationDepartmentNode & {
  positionMap: Map<string, OrganizationPositionNode>;
};

export interface OrganizationPageProps {
  enterpriseAccount?: EnterpriseAccount;
  organizationRefreshRevision?: number;
  enterpriseUnreadCounts?: EnterpriseUnreadCounts;
  enterpriseDirectChatOpenRequest?: { peerAccountId: string; requestId: number };
  onMessageRead?: (peerAccountId: string) => void;
  onBack: () => void;
}

function memberPositionTitle(member: EnterpriseOrganizationMember): string {
  return member.positionTitle?.trim()
    || (member.isAdmin ? '管理员' : member.role?.trim() || FALLBACK_POSITION);
}

function compareOrganizationMembers(
  left: EnterpriseOrganizationMember,
  right: EnterpriseOrganizationMember,
): number {
  const onlineDiff = Number(Boolean(right.ottoOnline)) - Number(Boolean(left.ottoOnline));
  if (onlineDiff !== 0) return onlineDiff;
  const adminDiff = Number(Boolean(right.isAdmin)) - Number(Boolean(left.isAdmin));
  if (adminDiff !== 0) return adminDiff;
  return left.name.localeCompare(right.name, 'zh-CN');
}

function createDepartmentNode(
  department: EnterpriseOrganizationDepartment | null,
  fallbackName: string,
  order: number,
): MutableOrganizationDepartmentNode {
  const node: MutableOrganizationDepartmentNode = {
    key: department?.id ?? `department:${fallbackName}`,
    id: department?.id ?? null,
    name: department?.name.trim() || fallbackName,
    order,
    memberCount: department?.memberCount ?? 0,
    members: [],
    positions: [],
    positionMap: new Map(),
  };
  department?.positions.forEach((position, positionIndex) => {
    node.positionMap.set(position.id, {
      key: position.id,
      id: position.id,
      title: position.title.trim() || FALLBACK_POSITION,
      roleMapping: position.roleMapping,
      order: positionIndex,
      members: [],
    });
  });
  return node;
}

function buildOrganizationTree(orgView: EnterpriseOrganizationView): OrganizationDepartmentNode[] {
  const structure = orgView.structure ?? [];
  const structureById = new Map(structure.map((department) => [department.id, department]));
  const structureByName = new Map(
    structure.map((department) => [department.name.trim(), department] as const),
  );
  const departments = new Map<string, MutableOrganizationDepartmentNode>();

  structure.forEach((department, index) => {
    departments.set(department.id, createDepartmentNode(department, department.name, index));
  });

  const resolveDepartment = (member: EnterpriseOrganizationMember): MutableOrganizationDepartmentNode => {
    const configured = (member.departmentId ? structureById.get(member.departmentId) : undefined)
      ?? (member.department?.trim() ? structureByName.get(member.department.trim()) : undefined);
    if (configured) return departments.get(configured.id)!;

    const name = member.department?.trim() || UNASSIGNED_DEPARTMENT;
    const key = `department:${name}`;
    let department = departments.get(key);
    if (!department) {
      department = createDepartmentNode(null, name, Number.MAX_SAFE_INTEGER);
      departments.set(key, department);
    }
    return department;
  };

  const resolvePosition = (
    department: MutableOrganizationDepartmentNode,
    member: EnterpriseOrganizationMember,
  ): OrganizationPositionNode => {
    let position = member.positionId
      ? department.positionMap.get(member.positionId)
      : undefined;
    const memberTitle = member.positionTitle?.trim() || '';
    if (!position && memberTitle) {
      position = [...department.positionMap.values()].find(
        (candidate) => candidate.title.trim() === memberTitle,
      );
    }
    if (position) return position;

    const title = memberTitle || memberPositionTitle(member);
    const key = member.positionId
      ? `position:${department.key}:${member.positionId}`
      : `position-title:${department.key}:${title}`;
    position = department.positionMap.get(key) ?? {
      key,
      id: member.positionId ?? null,
      title,
      roleMapping: null,
      order: Number.MAX_SAFE_INTEGER,
      members: [],
    };
    department.positionMap.set(position.key, position);
    return position;
  };

  for (const member of orgView.members) {
    if (member.status !== 'active') continue;
    const department = resolveDepartment(member);
    department.members.push(member);
    resolvePosition(department, member).members.push(member);
  }

  return [...departments.values()]
    .sort((left, right) => (
      left.order - right.order
      || left.name.localeCompare(right.name, 'zh-CN')
    ))
    .map((department) => ({
      ...department,
      memberCount: department.id ? department.memberCount : department.members.length,
      members: [...department.members].sort(compareOrganizationMembers),
      positions: [...department.positionMap.values()]
        .sort((left, right) => (
          left.order - right.order
          || left.title.localeCompare(right.title, 'zh-CN')
        ))
        .map((position) => ({
          ...position,
          members: [...position.members].sort(compareOrganizationMembers),
        })),
    }));
}

function departmentOnlineCount(department: OrganizationDepartmentNode): number {
  return department.members.filter((member) => member.ottoOnline).length;
}

function positionOnlineCount(position: OrganizationPositionNode): number {
  return position.members.filter((member) => member.ottoOnline).length;
}

export function OrganizationPage({
  enterpriseAccount,
  organizationRefreshRevision = 0,
  enterpriseUnreadCounts = {},
  enterpriseDirectChatOpenRequest,
  onMessageRead,
  onBack,
}: OrganizationPageProps): React.JSX.Element {
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [chatMembers, setChatMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const handledChatRequest = useRef(0);
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);

  // —— 数据加载：真实 enterpriseOrganizationView IPC，15 秒后台刷新 ——
  useEffect(() => {
    if (!hasAuth) return;
    let cancelled = false;
    const load = async (showSpinner: boolean): Promise<void> => {
      if (showSpinner) setLoading(true);
      try {
        const view = await window.otto.enterpriseOrganizationView();
        if (cancelled) return;
        setOrgView(view);
        setSyncedAt(new Date());
        setError(null);
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

  // —— 外部直聊请求（通知 / 我的消息进入）——
  useEffect(() => {
    if (!enterpriseDirectChatOpenRequest || !orgView) return;
    if (handledChatRequest.current === enterpriseDirectChatOpenRequest.requestId) return;
    const member = orgView.members.find(
      (candidate) => candidate.id === enterpriseDirectChatOpenRequest.peerAccountId
        && candidate.id !== enterpriseAccount?.id
        && candidate.status === 'active',
    );
    if (!member) return;
    handledChatRequest.current = enterpriseDirectChatOpenRequest.requestId;
    openChat(member);
  }, [enterpriseDirectChatOpenRequest, orgView, enterpriseAccount?.id]);

  const openChat = useCallback((member: EnterpriseOrganizationView['members'][number]) => {
    onMessageRead?.(member.id);
    setChatMembers((current) => [
      ...current.filter((candidate) => candidate.id !== member.id),
      member,
    ]);
  }, [onMessageRead]);

  const closeChat = useCallback((memberId: string) => {
    setChatMembers((current) => current.filter((candidate) => candidate.id !== memberId));
  }, []);

  const toggleNode = useCallback((key: string) => {
    setExpandedNodes((current) => ({
      ...current,
      [key]: !(current[key] !== false),
    }));
  }, []);

  const departments = useMemo(
    () => (orgView ? buildOrganizationTree(orgView) : []),
    [orgView],
  );
  const totalActive = useMemo(
    () => orgView?.members.filter((member) => member.status === 'active').length ?? 0,
    [orgView],
  );
  const totalOnline = useMemo(
    () => orgView?.members.filter((member) => member.status === 'active' && member.ottoOnline).length ?? 0,
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

  const organizationName = orgView?.organization?.name ?? '组织架构';

  return (
    <div className="otto-org-page" role="region" aria-label="组织架构">
      <header className="otto-org-page__header">
        <div>
          <h1>{organizationName}</h1>
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
          <div className="otto-org-page__tree" role="tree" aria-label={`${organizationName}组织架构`}>
            <div className="otto-org-page__tree-root" role="treeitem" aria-expanded="true">
              <span className="otto-org-page__tree-icon otto-org-page__tree-icon--root" aria-hidden>
                {organizationName.slice(0, 1)}
              </span>
              <div className="otto-org-page__tree-heading">
                <strong>{organizationName}</strong>
                <span>{orgView.employeeCount} 位成员 · {departments.length} 个部门</span>
              </div>
            </div>

            <div className="otto-org-page__tree-children" role="group">
              {departments.length === 0 ? (
                <div className="otto-org-page__tree-empty">暂无部门与成员</div>
              ) : departments.map((department) => {
                const departmentExpanded = expandedNodes[department.key] !== false;
                const onlineCount = departmentOnlineCount(department);
                return (
                  <section key={department.key} className="otto-org-page__tree-dept">
                    <button
                      type="button"
                      className="otto-org-page__tree-node otto-org-page__tree-node--dept"
                      onClick={() => toggleNode(department.key)}
                      role="treeitem"
                      aria-expanded={departmentExpanded}
                    >
                      <IconChevronDown
                        size={14}
                        className={departmentExpanded ? '' : 'is-collapsed'}
                      />
                      <span className="otto-org-page__tree-icon otto-org-page__tree-icon--dept" aria-hidden>
                        {department.name.slice(0, 1)}
                      </span>
                      <span className="otto-org-page__tree-title">{department.name}</span>
                      <span className="otto-org-page__tree-meta">
                        {department.memberCount} 人{onlineCount > 0 ? ` · ${onlineCount} 在线` : ''}
                      </span>
                    </button>

                    {departmentExpanded ? (
                      <div className="otto-org-page__tree-position-list" role="group">
                        {department.positions.length === 0 ? (
                          <div className="otto-org-page__position-empty">暂无岗位与成员</div>
                        ) : department.positions.map((position) => {
                          const positionExpanded = expandedNodes[position.key] !== false;
                          const positionOnline = positionOnlineCount(position);
                          return (
                            <div key={position.key} className="otto-org-page__tree-position">
                              <button
                                type="button"
                                className="otto-org-page__tree-node otto-org-page__tree-node--position"
                                onClick={() => toggleNode(position.key)}
                                role="treeitem"
                                aria-expanded={positionExpanded}
                              >
                                <IconChevronDown
                                  size={13}
                                  className={positionExpanded ? '' : 'is-collapsed'}
                                />
                                <span className="otto-org-page__tree-icon otto-org-page__tree-icon--position" aria-hidden>
                                  {position.title.slice(0, 1)}
                                </span>
                                <span className="otto-org-page__tree-title">{position.title}</span>
                                <span className="otto-org-page__tree-meta">
                                  {position.members.length} 人{positionOnline > 0 ? ` · ${positionOnline} 在线` : ''}
                                </span>
                              </button>

                              {positionExpanded ? (
                                <div className="otto-org-page__members" role="group">
                                  {position.members.length === 0 ? (
                                    <div className="otto-org-page__position-empty">暂无成员</div>
                                  ) : position.members.map((member) => {
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
                                          <span>{member.positionTitle || member.role || FALLBACK_POSITION}</span>
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
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 直聊面板：真实 enterpriseMessagesList / enterpriseMessageSend IPC */}
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
      setMessages(msgs.map((message) => ({
        id: message.id,
        content: message.content,
        mine: message.senderAccountId === currentAccount?.id,
        time: new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
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
      const message = await window.otto.enterpriseMessageSend(member.id, text);
      setMessages((current) => [...current, {
        id: message.id,
        content: message.content,
        mine: true,
        time: new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
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
        ) : messages.map((message) => (
          <div key={message.id} className={`otto-org-page__chat-msg${message.mine ? ' is-mine' : ''}`}>
            <span className="otto-org-page__chat-bubble">{message.content}</span>
            <time>{message.time}</time>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form
        className="otto-org-page__chat-composer"
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
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
