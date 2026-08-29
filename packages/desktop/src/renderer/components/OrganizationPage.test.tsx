/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseAccount } from '../../preload/index.js';
import { OrganizationPage } from './OrganizationPage.js';

const account: EnterpriseAccount = {
  id: 'account-a', organizationId: 'org-a', organizationName: '测试企业',
  accountType: 'enterprise', employeeId: null, username: 'alice', phone: null,
  name: 'Alice', role: '成员', department: '产品部', positionId: null,
  positionTitle: null, isAdmin: false, status: 'active', tags: [],
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  Object.assign(window.otto, {
    enterpriseOrganizationView: vi.fn(async () => ({
      organization: {
        id: 'org-a', name: '测试企业', status: 'active' as const,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      members: [],
      employeeCount: 0,
      structure: [],
    })),
  });
});

describe('OrganizationPage contacts integration', () => {
  it('renders Product Workspace friends inside the organization page', async () => {
    render(<OrganizationPage
      enterpriseAccount={account}
      friends={[{
        id: 'friend-a', displayName: '常用同事', note: '财务',
        createdAt: '2026-08-01T00:00:00.000Z',
      }]}
      onBack={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByText('常用同事')).toBeTruthy());
    expect(screen.getByText('财务')).toBeTruthy();
  });

  it('delegates contact creation to the existing Product Workspace action', async () => {
    const onAddFriend = vi.fn();
    render(<OrganizationPage
      enterpriseAccount={account}
      friends={[]}
      onAddFriend={onAddFriend}
      onBack={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByRole('heading', { name: '常用联系人' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('联系人姓名'), { target: { value: '李雷' } });
    fireEvent.change(screen.getByLabelText('联系人备注'), { target: { value: '合作伙伴' } });
    fireEvent.click(screen.getByRole('button', { name: '添加联系人' }));

    expect(onAddFriend).toHaveBeenCalledWith('李雷', '合作伙伴');
  });
});
