/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import type { EnterpriseAccount } from '../../preload/index.js';
import { OrganizationTree } from './OrganizationTree.js';

afterEach(cleanup);

const workspace: ProductWorkspaceSnapshot = {
  schemaVersion: 1,
  context: {
    edition: 'enterprise', role: 'company_owner', userId: 'u1', companyId: 'c1',
    departmentId: 'd1', positionId: 'p1', capabilities: ['organization:read'],
  },
  managerWorkspace: {
    profile: {
      managerId: 'u1', managerName: 'Felix', companyName: '北辰科技',
      createdAt: '2026-07-11T00:00:00.000Z',
    },
    context: {
      edition: 'enterprise', role: 'company_owner', userId: 'u1',
      companyId: 'c1', capabilities: ['organization:read'],
    },
    organization: {
      rootCompanyId: 'c1',
      companies: [{ id: 'c1', name: '北辰科技', ownerUserId: 'u1' }],
      departments: [{ id: 'd1', companyId: 'c1', name: 'CEO 办公室' }],
      positions: [{ id: 'p1', companyId: 'c1', departmentId: 'd1', title: 'CEO', incumbentUserId: 'u1' }],
    },
  },
  members: [{
    userId: 'u1', displayName: 'Felix', companyId: 'c1', departmentId: 'd1',
    positionId: 'p1', role: 'company_owner',
  }],
  friends: [],
  credits: { balance: 0, frozen: 0, status: 'design-preview' },
};

const memberWorkspace: ProductWorkspaceSnapshot = {
  ...workspace,
  context: {
    ...workspace.context,
    role: 'member',
    capabilities: ['organization:read'],
  },
  managerWorkspace: undefined,
  members: [],
};

const personalWorkspace: ProductWorkspaceSnapshot = {
  ...workspace,
  context: {
    edition: 'personal',
    role: 'personal',
    userId: 'local-user',
    capabilities: ['agent:base'],
  },
  managerWorkspace: undefined,
  members: [],
};

const authenticatedEnterpriseAccount: EnterpriseAccount = {
  id: 'acc_1',
  organizationId: 'org_acme',
  organizationName: '星河科技',
  employeeId: null,
  username: 'staff01',
  phone: '+8613800138000',
  name: '员工一号',
  role: '工程师',
  department: '研发部',
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active',
  tags: [],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
};

const internalTestAccount: EnterpriseAccount = {
  ...authenticatedEnterpriseAccount,
  id: 'local_internal_test',
  organizationId: 'local-internal-test',
  organizationName: '内部测试',
  username: 'internal-test',
  phone: null,
  name: '内部测试',
  role: '测试成员',
  department: '内部测试',
};

describe('OrganizationTree', () => {
  it('收起时只显示“企业组织”，点击后完整展开公司、部门、姓名和职位', () => {
    render(<OrganizationTree workspace={workspace} />);
    const toggle = screen.getByRole('button', { name: '企业组织' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('北辰科技')).toBeNull();
    expect(screen.queryByText('CEO 办公室')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('北辰科技')).toBeTruthy();
    expect(screen.getByText('CEO 办公室')).toBeTruthy();
    expect(screen.getByText('Felix')).toBeTruthy();
    expect(screen.getAllByText('CEO').length).toBeGreaterThan(0);
  });

  it('右栏请求打开组织树时展开左侧真实组织入口', () => {
    const { rerender } = render(
      <OrganizationTree workspace={workspace} openRequest={0} />,
    );
    const toggle = screen.getByRole('button', { name: '企业组织' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    rerender(<OrganizationTree workspace={workspace} openRequest={1} />);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('北辰科技')).toBeTruthy();
  });

  it('成员视图挂载即通过 preload 加载组织架构，并正确显示 loading 和数据', async () => {
    let resolveOrganization!: (value: {
      organization: { id: string; name: string; status: 'active'; createdAt: string };
      members: Array<{
        id: string; username: string; name: string; role: string;
        department: string; isAdmin: boolean; status: 'active';
      }>;
      employeeCount: number;
    }) => void;
    const pending = new Promise<Parameters<typeof resolveOrganization>[0]>((resolve) => {
      resolveOrganization = resolve;
    });
    const enterpriseOrganizationView = vi.fn(() => pending);
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));
    expect(screen.getByText('正在加载组织信息…')).toBeTruthy();

    resolveOrganization({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active',
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active',
      }],
      employeeCount: 1,
    });

    expect(await screen.findByText('星河科技')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('员工一号')).toBeTruthy();
    expect(screen.getByText('工程师')).toBeTruthy();
  });

  it('组织架构请求失败时结束 loading 并显示明确错误', async () => {
    const enterpriseOrganizationView = vi.fn(async () => {
      throw new Error('服务器暂不可用');
    });
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));

    expect(await screen.findByText('组织信息加载失败：服务器暂不可用')).toBeTruthy();
    expect(screen.queryByText('正在加载组织信息…')).toBeNull();
    expect(enterpriseOrganizationView).toHaveBeenCalledOnce();
  });

  it('邀请码认证后的真实企业账号可从默认个人工作区连接远程组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));
    expect(await screen.findByText('星河科技')).toBeTruthy();
    expect(screen.getByText('研发部')).toBeTruthy();
    expect(screen.getByText('员工一号')).toBeTruthy();
  });

  it('本地 ProductWorkspace 尚未连接时，真实企业账号仍可加载远程组织树', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={null}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));
    expect(await screen.findByText('星河科技')).toBeTruthy();
  });

  it('默认免登录的本地测试身份不会冒充企业账号或触发组织请求', () => {
    const enterpriseOrganizationView = vi.fn();
    Object.assign(window.otto, { enterpriseOrganizationView });

    const { container } = render(
      <OrganizationTree
        workspace={personalWorkspace}
        enterpriseAccount={internalTestAccount}
      />,
    );

    expect(container.innerHTML).toBe('');
    expect(enterpriseOrganizationView).not.toHaveBeenCalled();
  });

  it('真实企业账号覆盖机器上残留的本机企业树，以服务端组织为权威', async () => {
    const enterpriseOrganizationView = vi.fn(async () => ({
      organization: {
        id: 'org_acme',
        name: '服务端星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    }));
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={workspace}
        enterpriseAccount={authenticatedEnterpriseAccount}
      />,
    );

    await waitFor(() => expect(enterpriseOrganizationView).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));
    expect(await screen.findByText('服务端星河科技')).toBeTruthy();
    expect(screen.queryByText('北辰科技')).toBeNull();
  });

  it('本机企业成员只有内测假身份时不调用远程接口', () => {
    const enterpriseOrganizationView = vi.fn();
    Object.assign(window.otto, { enterpriseOrganizationView });

    render(
      <OrganizationTree
        workspace={memberWorkspace}
        enterpriseAccount={internalTestAccount}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));

    expect(enterpriseOrganizationView).not.toHaveBeenCalled();
    expect(screen.getByText('已通过链接加入；组织详情将在企业服务同步后显示。'))
      .toBeTruthy();
  });
});
