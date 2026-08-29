/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 组织架构全页视图（导航一级入口）。
 *
 * 数据源与底层企业目录完全一致：enterpriseOrganizationView IPC 返回的
 * organization / members / structure(EnterpriseOrganizationDepartment[])。
 * 页面按「企业 → 部门 → 子部门 → 成员」渲染真实树状结构；部门顺序与
 * structure 保持一致，成员按在线状态与姓名排序，岗位只作为员工信息展示，未分配部门的成员会
 * 归入对应兜底节点，不使用任何假数据。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationDepartment,
  EnterpriseOrganizationPosition,
  EnterpriseOrganizationView,
  EnterpriseParkTenantOrganization,
} from '../../preload/index.js';
import type { ProductWorkspaceSnapshot, ScheduleItemInfo } from 'otto-server';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { DirectMessagePanel } from './OrganizationTree.js';
import { IconBuilding, IconChevronDown, IconFolder, IconSearch } from './icons.js';
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
  parentDepartmentId: string | null;
  order: number;
  /** 优先使用服务端 structure.memberCount；动态兜底部门使用已加载成员数。 */
  memberCount: number;
  members: EnterpriseOrganizationMember[];
  positions: OrganizationPositionNode[];
  children: OrganizationDepartmentNode[];
}

type MutableOrganizationDepartmentNode = OrganizationDepartmentNode & {
  positionMap: Map<string, OrganizationPositionNode>;
};

export interface OrganizationPageProps {
  enterpriseAccount?: EnterpriseAccount;
  schedules?: readonly ScheduleItemInfo[];
  organizationRefreshRevision?: number;
  enterpriseUnreadCounts?: EnterpriseUnreadCounts;
  enterpriseDirectChatOpenRequest?: { peerAccountId: string; requestId: number };
  onMessageRead?: (peerAccountId: string) => void;
  friends?: ReadonlyArray<ProductWorkspaceSnapshot['friends'][number]>;
  onAddFriend?: (name: string, note?: string) => void;
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
    parentDepartmentId: department?.parentDepartmentId ?? null,
    order,
    memberCount: department?.memberCount ?? 0,
    members: [],
    positions: [],
    children: [],
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

  const flat = [...departments.values()]
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
  const byKey = new Map(flat.map((department) => [department.key, department]));
  const roots: OrganizationDepartmentNode[] = [];
  flat.forEach((department) => {
    const parent = department.parentDepartmentId
      ? byKey.get(department.parentDepartmentId)
      : undefined;
    if (parent && parent !== department) parent.children.push(department);
    else roots.push(department);
  });
  return roots;
}

function departmentOnlineCount(department: OrganizationDepartmentNode): number {
  return department.members.filter((member) => member.ottoOnline).length
    + department.children.reduce((sum, child) => sum + departmentOnlineCount(child), 0);
}

function departmentMemberCount(department: OrganizationDepartmentNode): number {
  return department.members.length
    + department.children.reduce((sum, child) => sum + departmentMemberCount(child), 0);
}

function flattenDepartments(departments: OrganizationDepartmentNode[]): OrganizationDepartmentNode[] {
  return departments.flatMap((department) => [department, ...flattenDepartments(department.children)]);
}

function departmentMatchesQuery(department: OrganizationDepartmentNode, query: string): boolean {
  if (!query) return true;
  const haystack = [department.name, ...department.members.flatMap((member) => [
    member.name,
    member.role ?? '',
    member.positionTitle ?? '',
  ])].join(' ').toLocaleLowerCase('zh-CN');
  return haystack.includes(query) || department.children.some((child) => departmentMatchesQuery(child, query));
}

export function OrganizationPage({
  enterpriseAccount,
  schedules = [],
  organizationRefreshRevision = 0,
  enterpriseUnreadCounts = {},
  enterpriseDirectChatOpenRequest,
  onMessageRead,
  friends = [],
  onAddFriend,
  onBack,
}: OrganizationPageProps): React.JSX.Element {
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [chatMembers, setChatMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [parkTenants, setParkTenants] = useState<EnterpriseParkTenantOrganization[]>([]);
  const [parkTenantsLoading, setParkTenantsLoading] = useState(false);
  const [parkTenantsError, setParkTenantsError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [friendName, setFriendName] = useState('');
  const [friendNote, setFriendNote] = useState('');
  const handledChatRequest = useRef(0);
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);

  useEffect(() => {
    if (!hasAuth) return;
    let cancelled = false;
    const load = async (showSpinner: boolean): Promise<void> => {
      if (showSpinner) setLoading(true);
      try {
        const view = await window.otto.enterpriseOrganizationView(selectedOrganizationId ?? undefined);
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
  }, [hasAuth, enterpriseAccount?.organizationId, enterpriseAccount?.updatedAt, organizationRefreshRevision, selectedOrganizationId]);

  const openChat = useCallback((member: EnterpriseOrganizationView['members'][number]) => {
    onMessageRead?.(member.id);
    setChatMembers((current) => [
      ...current.filter((candidate) => candidate.id !== member.id),
      member,
    ]);
  }, [onMessageRead]);

  useEffect(() => {
    const isParkAdmin = Boolean(
      !selectedOrganizationId && enterpriseAccount?.isAdmin && orgView?.park?.isAdminOrganization,
    );
    if (!isParkAdmin) {
      setParkTenants([]);
      setParkTenantsError(null);
      return;
    }
    let cancelled = false;
    setParkTenantsLoading(true);
    void window.otto.enterpriseParkTenants().then((organizations) => {
      if (cancelled) return;
      setParkTenants(organizations);
      setParkTenantsError(null);
    }).catch((cause: unknown) => {
      if (!cancelled) setParkTenantsError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (!cancelled) setParkTenantsLoading(false);
    });
    return () => { cancelled = true; };
  }, [enterpriseAccount?.isAdmin, orgView?.park?.isAdminOrganization, selectedOrganizationId]);

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
  }, [enterpriseDirectChatOpenRequest, orgView, enterpriseAccount?.id, openChat]);

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

  const organizationName = orgView?.organization?.name ?? '组织架构';
  const isParkAdmin = Boolean(
    !selectedOrganizationId && enterpriseAccount?.isAdmin && orgView?.park?.isAdminOrganization,
  );
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const flatDepartments = useMemo(() => flattenDepartments(departments), [departments]);
  const defaultExpandedKeys = useMemo(() => {
    const keys = new Set<string>(departments.map((department) => department.key));
    const currentDepartment = flatDepartments.find((department) => (
      department.id === enterpriseAccount?.departmentId
      || department.name === enterpriseAccount?.department
    ));
    if (currentDepartment) {
      keys.add(currentDepartment.key);
      if (currentDepartment.parentDepartmentId) keys.add(currentDepartment.parentDepartmentId);
    }
    return keys;
  }, [departments, enterpriseAccount?.department, enterpriseAccount?.departmentId, flatDepartments]);
  const visibleDepartments = useMemo(
    () => departments.filter((department) => departmentMatchesQuery(department, normalizedQuery)),
    [departments, normalizedQuery],
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
  const backFromCurrentView = (): void => {
    if (selectedOrganizationId) {
      setSelectedOrganizationId(null);
      setExpandedNodes({});
      setQuery('');
    } else {
      onBack();
    }
  };

  const renderMember = (member: EnterpriseOrganizationView['members'][number], departmentMatches: boolean): React.JSX.Element | null => {
    const memberMatches = !normalizedQuery || departmentMatches || [member.name, member.role ?? '', member.positionTitle ?? '']
      .join(' ').toLocaleLowerCase('zh-CN').includes(normalizedQuery);
    if (!memberMatches) return null;
    const isSelf = member.id === enterpriseAccount?.id;
    const unread = enterpriseUnreadCounts[`enterprise:message:${member.id}`] ?? 0;
    return (
      <div key={member.id} className={`otto-org-page__member${isSelf ? ' is-self' : ''}`}>
        <span className="otto-org-page__avatar" aria-hidden>
          {member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : member.name.slice(0, 1)}
          <i className={member.ottoOnline ? 'is-online' : ''} />
        </span>
        <div className="otto-org-page__member-info">
          <strong>
            {member.name}
            {isSelf ? <small>（我）</small> : null}
            {member.isAdmin ? <small className="otto-org-page__admin-badge">管理员</small> : null}
          </strong>
          <span>{member.positionTitle || member.role || FALLBACK_POSITION}</span>
        </div>
        <span className={`otto-org-page__presence${member.ottoOnline ? ' is-online' : ''}`} aria-label={member.ottoOnline ? '在线' : '离线'} />
        {unread > 0 ? <span className="otto-org-page__unread" role="status" aria-label={`${unread} 条未读`}>{unread}</span> : null}
        {!isSelf ? (
          <button type="button" className="otto-org-page__chat-btn" onClick={() => openChat(member)} aria-label={`与 ${member.name} 聊天`}>
            发消息
          </button>
        ) : null}
      </div>
    );
  };

  const renderDepartment = (department: OrganizationDepartmentNode, depth = 0): React.JSX.Element | null => {
    const departmentMatches = Boolean(normalizedQuery && department.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
    const departmentExpanded = expandedNodes[department.key] ?? (defaultExpandedKeys.has(department.key) || Boolean(normalizedQuery));
    const onlineCount = departmentOnlineCount(department);
    const memberCount = departmentMemberCount(department);
    const visibleMembers = department.members.map((member) => renderMember(member, departmentMatches)).filter(Boolean);
    return (
      <section key={department.key} className={`otto-org-page__tree-dept${depth > 0 ? ' is-nested' : ''}`}>
        <button type="button" className="otto-org-page__tree-node otto-org-page__tree-node--dept" onClick={() => toggleNode(department.key)} role="treeitem" aria-expanded={departmentExpanded}>
          <IconChevronDown size={14} className={departmentExpanded ? '' : 'is-collapsed'} />
          <IconFolder size={16} className="otto-org-page__department-icon" />
          <span className="otto-org-page__tree-title">{department.name}</span>
          <span className="otto-org-page__tree-meta">{memberCount} 人{onlineCount > 0 ? ` · ${onlineCount} 在线` : ''}</span>
        </button>
        {departmentExpanded ? (
          <div className="otto-org-page__tree-position-list" role="group">
            {department.children.filter((child) => departmentMatchesQuery(child, normalizedQuery)).map((child) => renderDepartment(child, depth + 1))}
            {visibleMembers.length ? <div className="otto-org-page__members" role="group">{visibleMembers}</div> : null}
            {!department.children.length && !visibleMembers.length ? <div className="otto-org-page__position-empty">暂无成员</div> : null}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className="otto-org-page" role="region" aria-label="组织架构">
      <header className="otto-org-page__header">
        <div>
          {isParkAdmin ? <span className="otto-org-page__eyebrow">园区总览</span> : null}
          <h1>{isParkAdmin ? (orgView?.park?.name ?? '园区总览') : organizationName}</h1>
          <p>{isParkAdmin
            ? `${parkTenants.length} 家入驻企业${syncedAt ? ` · 同步于 ${syncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`
            : `${totalActive} 位成员 · ${flatDepartments.length} 个部门${orgView?.organization?.industry ? ` · ${orgView.organization.industry}` : ''}${totalOnline > 0 ? ` · ${totalOnline} 人在线` : ''}`}</p>
        </div>
        <button type="button" onClick={backFromCurrentView}>{selectedOrganizationId ? '返回园区总览' : '返回对话'}</button>
      </header>

      {loading && !orgView ? <div className="otto-org-page__empty">正在加载组织信息…</div>
        : error ? <div className="otto-org-page__empty" role="alert">{error}</div>
          : !orgView ? <div className="otto-org-page__empty">组织信息不可用</div>
            : isParkAdmin ? (
              <ParkOrganizationOverview tenants={parkTenants} loading={parkTenantsLoading} error={parkTenantsError} onSelect={(id) => setSelectedOrganizationId(id)} />
            ) : (
              <div className="otto-org-page__body">
                <section className="otto-org-page__contacts" aria-label="常用联系人">
                  <header><div><h2>常用联系人</h2><p>个人常用联系人，与企业成员目录分开管理。</p></div></header>
                  <div className="otto-org-page__contact-list">
                    {friends.map((friend) => <div key={friend.id}><strong>{friend.displayName}</strong>{friend.note ? <span>{friend.note}</span> : null}</div>)}
                    {!friends.length ? <p>暂未添加常用联系人。</p> : null}
                  </div>
                  {onAddFriend ? <form onSubmit={(event) => {
                    event.preventDefault();
                    const name = friendName.trim();
                    if (!name) return;
                    onAddFriend(name, friendNote.trim() || undefined);
                    setFriendName(''); setFriendNote('');
                  }}>
                    <input aria-label="联系人姓名" value={friendName} onChange={(event) => setFriendName(event.target.value)} placeholder="联系人姓名"/>
                    <input aria-label="联系人备注" value={friendNote} onChange={(event) => setFriendNote(event.target.value)} placeholder="备注（可选）"/>
                    <button type="submit" disabled={!friendName.trim()}>添加联系人</button>
                  </form> : null}
                </section>
                <div className="otto-org-page__toolbar">
                  <label className="otto-org-page__search">
                    <IconSearch size={16} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名或部门" aria-label="搜索姓名或部门" />
                  </label>
                  <span>{query ? `${visibleDepartments.length} 个匹配部门` : '默认展开当前部门及直属上级'}</span>
                </div>
                <div className="otto-org-page__tree" role="tree" aria-label={`${organizationName}组织架构`}>
                  {visibleDepartments.length ? visibleDepartments.map((department) => renderDepartment(department)) : <div className="otto-org-page__tree-empty">没有找到匹配的姓名或部门</div>}
                </div>
              </div>
            )}

      {chatMembers.map((member, index) => (
        <DirectMessagePanel
          key={member.id}
          member={member}
          currentAccount={enterpriseAccount}
          schedules={schedules}
          initialPosition={{
            left: (typeof window !== 'undefined' && window.innerWidth <= 760 ? 12 : 232) + ((index % 7) * 28),
            top: (typeof window !== 'undefined' && window.innerWidth <= 760 ? 12 : 48) + ((index % 7) * 28),
          }}
          stackOrder={50 + index}
          onActivate={() => undefined}
          onMessageRead={onMessageRead}
          onClose={() => closeChat(member.id)}
        />
      ))}
    </div>
  );
}

function ParkOrganizationOverview({
  tenants,
  loading,
  error,
  onSelect,
}: {
  tenants: EnterpriseParkTenantOrganization[];
  loading: boolean;
  error: string | null;
  onSelect: (organizationId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleTenants = tenants.filter((tenant) => (
    !normalizedQuery || [tenant.name, tenant.slug, tenant.industry ?? '']
      .join(' ').toLocaleLowerCase('zh-CN').includes(normalizedQuery)
  ));
  const totalEmployees = tenants.reduce((sum, tenant) => sum + (tenant.employeeCount ?? 0), 0);
  const totalOnline = tenants.reduce((sum, tenant) => sum + (tenant.onlineCount ?? 0), 0);
  const totalDepartments = tenants.reduce((sum, tenant) => sum + (tenant.departmentCount ?? 0), 0);

  return (
    <div className="otto-org-page__body otto-org-page__body--park">
      <div className="otto-org-page__park-metrics" aria-label="园区概览数据">
        <div><span>入驻企业</span><strong>{tenants.length}</strong><small>家</small></div>
        <div><span>企业员工</span><strong>{totalEmployees}</strong><small>人</small></div>
        <div><span>当前在线</span><strong>{totalOnline}</strong><small>人</small></div>
        <div><span>部门总数</span><strong>{totalDepartments}</strong><small>个</small></div>
      </div>
      <div className="otto-org-page__toolbar otto-org-page__toolbar--park">
        <label className="otto-org-page__search">
          <IconSearch size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索企业或产业类型" aria-label="搜索企业或产业类型" />
        </label>
        <span>{normalizedQuery ? `${visibleTenants.length} 家匹配企业` : '选择企业查看组织架构'}</span>
      </div>
      {loading ? <div className="otto-org-page__empty">正在加载入驻企业…</div>
        : error ? <div className="otto-org-page__empty" role="alert">{error}</div>
          : visibleTenants.length ? (
            <div className="otto-org-page__tenant-grid">
              {visibleTenants.map((tenant) => (
                <button key={tenant.id} type="button" className="otto-org-page__tenant-card" onClick={() => onSelect(tenant.id)}>
                  <span className="otto-org-page__tenant-brand"><IconBuilding size={18} /></span>
                  <span className="otto-org-page__tenant-copy">
                    <strong>{tenant.name}</strong>
                    <small>{tenant.industry || '产业类型待完善'}</small>
                  </span>
                  <span className={`otto-org-page__tenant-status${tenant.status === 'active' ? ' is-active' : ''}`}>
                    {tenant.status === 'active' ? '正常' : '已停用'}
                  </span>
                  <span className="otto-org-page__tenant-stats">
                    <span>{tenant.employeeCount ?? 0} 人 · {tenant.departmentCount ?? 0} 个部门</span>
                    <span><i className="otto-org-page__online-dot" />{tenant.onlineCount ?? 0} 人在线</span>
                  </span>
                  <span className="otto-org-page__tenant-action">查看架构 <IconChevronDown size={14} /></span>
                </button>
              ))}
            </div>
          ) : <div className="otto-org-page__empty">暂无匹配的入驻企业</div>}
    </div>
  );
}
