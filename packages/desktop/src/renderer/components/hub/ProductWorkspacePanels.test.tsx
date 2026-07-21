/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import type { EnterpriseAccount } from '../../../preload/index.js';
import type { UseProductWorkspace } from '../../state/useProductWorkspace.js';
import { OrganizationPanel } from './ProductWorkspacePanels.js';

afterEach(cleanup);

function product(workspace: ProductWorkspaceSnapshot) {
  const configureEnterprise = vi.fn();
  const acceptCompanyLink = vi.fn();
  const actions = {
    configureEnterprise,
    acceptCompanyLink,
    switchToPersonal: vi.fn(),
    joinEnterprise: vi.fn(),
    createInvite: vi.fn(),
  };
  return {
    value: {
      state: {
        workspace,
        schedules: [],
        pendingAutoSkills: [],
        lastAutoSkillAction: null,
        selectedDate: null,
        lastInvite: null,
        loading: false,
        error: null,
      },
      actions,
    } as unknown as UseProductWorkspace,
    configureEnterprise,
    acceptCompanyLink,
  };
}

const personal: ProductWorkspaceSnapshot = {
  schemaVersion: 1,
  context: {
    edition: 'personal', role: 'personal', userId: 'u1',
    capabilities: ['agent:base', 'model:byok', 'skill:auto-create'],
  },
  members: [], friends: [],
  credits: { balance: 0, frozen: 0, status: 'design-preview' },
};

function enterprise(): ProductWorkspaceSnapshot {
  return {
    ...personal,
    context: {
      edition: 'enterprise', role: 'company_owner', userId: 'u1', companyId: 'c1',
      capabilities: ['organization:manage', 'invite:issue'],
    },
    managerWorkspace: {
      profile: {
        managerId: 'u1', managerName: 'Felix', companyName: '北辰科技',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
      context: {
        edition: 'enterprise', role: 'company_owner', userId: 'u1', companyId: 'c1',
        capabilities: ['organization:manage', 'invite:issue'],
      },
      organization: {
        rootCompanyId: 'c1',
        companies: [{ id: 'c1', name: '北辰科技', ownerUserId: 'u1' }],
        departments: [{ id: 'd1', companyId: 'c1', name: 'CEO 办公室' }],
        positions: [{ id: 'p1', companyId: 'c1', departmentId: 'd1', title: 'CEO' }],
      },
    },
  };
}

const centralMember: EnterpriseAccount = {
  id: 'account-1',
  organizationId: 'central-org',
  organizationName: '中心企业',
  employeeId: 'E-009',
  username: 'member',
  phone: null,
  name: '中心成员',
  role: 'CEO',
  department: '研发部',
  positionId: 'central-position',
  positionTitle: '研发工程师',
  isAdmin: false,
  status: 'active',
  tags: ['超级管理员'],
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

describe('OrganizationPanel', () => {
  it('中心账号存在时只显示中心身份，并隐藏全部本机自声明入口', () => {
    const { value } = product(enterprise());
    render(
      <OrganizationPanel
        product={value}
        enterpriseAccount={centralMember}
        onManageAccounts={vi.fn()}
      />,
    );

    expect(screen.getByText('中心企业')).toBeTruthy();
    expect(screen.getByText('中心成员')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('研发工程师')).toBeTruthy();
    expect(screen.getByText('普通成员')).toBeTruthy();
    expect(screen.queryByText('北辰科技')).toBeNull();
    expect(screen.queryByRole('button', { name: '切回个人版' })).toBeNull();
    expect(screen.queryByText('我是企业管理者')).toBeNull();
    expect(screen.queryByText('我要加入一个公司')).toBeNull();
    expect(screen.queryByText('生成职位邀请链接')).toBeNull();
    expect(screen.queryByText(/本机成员总览/)).toBeNull();
    expect(screen.queryByText(/总分公司关系/)).toBeNull();
    expect(screen.queryByRole('button', { name: '管理员工职位' })).toBeNull();
  });

  it('中心企业管理员可从企业与身份页直达真实员工职位管理', () => {
    const { value } = product(enterprise());
    const onManageAccounts = vi.fn();
    render(
      <OrganizationPanel
        product={value}
        enterpriseAccount={{ ...centralMember, isAdmin: true }}
        onManageAccounts={onManageAccounts}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '管理员工职位' }));
    expect(onManageAccounts).toHaveBeenCalledOnce();
  });

  it('个人版管理者建档会提交企业信息并构建框架', () => {
    const { value, configureEnterprise } = product(personal);
    render(<OrganizationPanel product={value} />);
    fireEvent.click(screen.getByRole('button', { name: /我是企业管理者/ }));
    fireEvent.change(screen.getByLabelText('管理者姓名'), { target: { value: 'Felix' } });
    fireEvent.change(screen.getByLabelText('企业名称'), { target: { value: '北辰科技' } });
    fireEvent.click(screen.getByRole('button', { name: '构建我的企业框架' }));
    expect(configureEnterprise).toHaveBeenCalledWith(expect.objectContaining({
      managerName: 'Felix', companyName: '北辰科技',
    }));
  });

  it('CEO 可输入签名链接接入总公司或子公司', () => {
    const { value, acceptCompanyLink } = product(enterprise());
    render(<OrganizationPanel product={value} />);
    const link = 'otto://enterprise/join?token=signed&key=public';
    fireEvent.change(screen.getByLabelText('待接入的总分公司链接'), { target: { value: link } });
    fireEvent.click(screen.getByRole('button', { name: '验证并接入企业框架' }));
    expect(acceptCompanyLink).toHaveBeenCalledWith(link);
  });

  it('本机职位邀请如实说明 24 小时有效、需手工粘贴且不会跨设备同步', () => {
    const { value } = product(enterprise());
    render(<OrganizationPanel product={value} />);

    expect(screen.queryByRole('button', { name: '生成公司加入链接' })).toBeNull();
    expect(screen.getByText(/默认 24 小时/)).toBeTruthy();
    expect(screen.getByText(/在 Otto「企业与身份」中手工粘贴/)).toBeTruthy();
    expect(screen.getByText(/不会自动同步回管理者这台设备/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '引入子公司关系' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '接入总公司关系' })).toBeTruthy();
  });
});
