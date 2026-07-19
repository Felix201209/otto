/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { IconChevronDown } from './icons.js';

export function OrganizationTree({
  workspace,
  enterpriseAccount,
}: {
  workspace: ProductWorkspaceSnapshot;
  enterpriseAccount?: EnterpriseAccount;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const hasLocalEnterpriseWorkspace = workspace.context.edition === 'enterprise';
  const hasAuthenticatedOrganization = isAuthenticatedEnterpriseAccount(enterpriseAccount);
  // 真实中心账号以服务端目录为权威，不能被机器上残留的本机企业树覆盖。
  // 只有没有真实中心账号时，才展示本机 ProductWorkspace 的组织框架。
  const organization = hasLocalEnterpriseWorkspace && !hasAuthenticatedOrganization
    ? workspace.managerWorkspace?.organization
    : undefined;
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

  // 本地 workspace 没有管理者组织快照时，经 preload → main 读取企业组织。
  // 会话 token 始终只保留在 main 的 EnterpriseClient 内。
  useEffect(() => {
    // 远程组织目录只允许真实企业账号触发。本机企业成员或内测假身份没有
    // Bearer 会话时展示占位信息，不调用 IPC、更不会产生无意义的 401。
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
                const deptMap = new Map<string, EnterpriseOrganizationView['members']>();
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
          ) : orgError ? (
            <div className="otto-orgtree__vacant">{orgError}</div>
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
