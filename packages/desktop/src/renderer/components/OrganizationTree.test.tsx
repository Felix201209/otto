/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductWorkspaceSnapshot } from 'otto-server';
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

    render(<OrganizationTree workspace={memberWorkspace} />);
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

    render(<OrganizationTree workspace={memberWorkspace} />);
    fireEvent.click(screen.getByRole('button', { name: '企业组织' }));

    expect(await screen.findByText('组织信息加载失败：服务器暂不可用')).toBeTruthy();
    expect(screen.queryByText('正在加载组织信息…')).toBeNull();
    expect(enterpriseOrganizationView).toHaveBeenCalledOnce();
  });
});
