/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductWorkspaceSnapshot } from 'otto-server';
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

describe('OrganizationPanel', () => {
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
});
