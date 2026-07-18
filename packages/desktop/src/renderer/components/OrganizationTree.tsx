/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import { IconChevronDown } from './icons.js';

interface MemberView {
  id: string;
  username: string;
  name: string;
  role: string;
  department: string;
  isAdmin: boolean;
  status: string;
}

interface OrgView {
  organization: { id: string; name: string; status: string } | null;
  members: MemberView[];
  employeeCount: number;
}

export function OrganizationTree({
  workspace,
}: {
  workspace: ProductWorkspaceSnapshot;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [orgView, setOrgView] = useState<OrgView | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const organization = workspace.managerWorkspace?.organization;
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

  // For non-admin enterprise members, fetch org view from enterprise API
  useEffect(() => {
    if (
      workspace.context.edition !== 'enterprise'
      || workspace.managerWorkspace?.organization
      || orgView
      || orgLoading
    ) return;

    let cancelled = false;
    setOrgLoading(true);

    // Try to fetch org view from enterprise API for non-admin members
    const loadOrg = async () => {
      try {
        const session = await window.otto.enterpriseSession();
        if (cancelled) return;
        const { serverUrl, account } = session;
        if (!account || account.isAdmin) return;

        const token =
          typeof (window.otto as any).enterpriseSessionToken === 'function'
            ? await (window.otto as any).enterpriseSessionToken()
            : null;

        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(`${serverUrl}/enterprise/organization/view`, { headers });
        if (cancelled || !res.ok) return;
        const data = await res.json() as OrgView;
        if (!cancelled) setOrgView(data);
      } catch {
        // Enterprise server may not be reachable, fall back to empty state
      } finally {
        if (!cancelled) setOrgLoading(false);
      }
    };

    return () => { cancelled = true; };
  }, [workspace.context.edition, workspace.managerWorkspace?.organization]);

  if (workspace.context.edition !== 'enterprise') return null;

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
          {organization ? (
            <CompanyBranch
              companyId={organization.rootCompanyId}
              organization={organization}
              workspace={workspace}
              positionById={positionById}
              childrenByParent={childrenByParent}
            />
          ) : orgView ? (
            <div className="otto-orgtree__member-list">
              {orgView.organization ? (
                <div className="otto-orgtree__company-node">{orgView.organization.name}</div>
              ) : null}
              {/* Group members by department */}
              {(() => {
                const deptMap = new Map<string, MemberView[]>();
                for (const m of orgView.members) {
                  const dept = m.department || '未分配部门';
                  if (!deptMap.has(dept)) deptMap.set(dept, []);
                  deptMap.get(dept)!.push(m);
                }
                return [...deptMap.entries()].map(([dept, members]) => (
                  <div key={dept} className="otto-orgtree__department">
                    <div className="otto-orgtree__department-name">{dept}</div>
                    {members.map((m) => (
                      <div key={m.id} className="otto-orgtree__member">
                        <span>{m.name}</span>
                        <span>{m.isAdmin ? '管理员' : m.role || '成员'}</span>
                      </div>
                    ))}
                  </div>
                ));
              })()}
            </div>
          ) : orgLoading ? (
            <div className="otto-orgtree__vacant">正在加载组织信息…</div>
          ) : (
            <div className="otto-orgtree__vacant">
              已通过链接加入；组织详情将在企业服务同步后显示。
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

type Organization = NonNullable<
  ProductWorkspaceSnapshot['managerWorkspace']
>['organization'];

function CompanyBranch({
  companyId,
  organization,
  workspace,
  positionById,
  childrenByParent,
}: {
  companyId: string;
  organization: Organization;
  workspace: ProductWorkspaceSnapshot;
  positionById: Map<string, Organization['positions'][number]>;
  childrenByParent: Map<string, string[]>;
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
              {members.map((member) => (
                <div key={member.userId} className="otto-orgtree__member">
                  <span>{member.displayName}</span>
                  <span>{member.positionId ? positionById.get(member.positionId)?.title ?? '成员' : '成员'}</span>
                </div>
              ))}
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
          />
        ))}
      </div>
    </div>
  );
}
