/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('OrganizationTree', () => {
  it('默认只显示一行，点击后展开公司、部门、姓名和职位', () => {
    render(<OrganizationTree workspace={workspace} />);
    const toggle = screen.getByRole('button', { name: /北辰科技/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('CEO 办公室')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('CEO 办公室')).toBeTruthy();
    expect(screen.getByText('Felix')).toBeTruthy();
    expect(screen.getAllByText('CEO').length).toBeGreaterThan(0);
  });
});
