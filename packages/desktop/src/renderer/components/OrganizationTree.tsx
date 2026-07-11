/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import { IconChevronDown } from './icons.js';

export function OrganizationTree({
  workspace,
}: {
  workspace: ProductWorkspaceSnapshot;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const organization = workspace.managerWorkspace?.organization;
  const company = organization?.companies.find(
    (item) => item.id === organization.rootCompanyId,
  );
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

  if (workspace.context.edition !== 'enterprise') return null;

  return (
    <section className="otto-orgtree" aria-label="企业组织架构">
      <button
        type="button"
        className="otto-orgtree__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="otto-orgtree__company">
          {company?.name ?? workspace.managerWorkspace?.profile.companyName ?? '已加入企业'}
        </span>
        <span className="otto-orgtree__role">
          {workspace.context.role === 'company_owner' ? 'CEO' : '企业成员'}
        </span>
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
