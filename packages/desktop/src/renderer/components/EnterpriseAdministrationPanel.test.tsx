/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationFeatures,
  EnterprisePark,
  EnterpriseParkService,
  EnterpriseParkSpecialist,
} from '../../preload/index.js';
import { EnterpriseAdministrationPanel } from './EnterpriseAdministrationPanel.js';

afterEach(() => {
  cleanup();
  for (const key of [
    'enterpriseOrganizationFeaturesGet',
    'enterpriseOrganizationDepartments',
    'enterpriseParkView',
    'enterpriseParkServices',
    'enterpriseParkSpecialists',
    'enterpriseParkSpecialistSet',
    'enterpriseParkSpecialistRemove',
    'enterpriseOrganizationDepartmentCreate',
    'enterpriseOrganizationDepartmentUpdate',
    'enterpriseOrganizationDepartmentDelete',
    'enterpriseOrganizationPositionCreate',
    'enterpriseOrganizationPositionUpdate',
    'enterpriseOrganizationPositionDelete',
  ]) {
    delete (window.otto as unknown as Record<string, unknown>)[key];
  }
});

const features: EnterpriseOrganizationFeatures = {
  enterprise_tree: false,
  park_service: true,
  feishu_auto_reply: false,
  direct_messages: false,
  atoa: false,
  knowledge: false,
};

const park: EnterprisePark = {
  id: 'park-1',
  name: 'Technology Tower',
  slug: 'technology-tower',
  brandName: 'Technology Tower Services',
  adminOrganizationId: 'org-1',
  status: 'active',
  createdAt: '2026-07-20',
  updatedAt: '2026-07-20',
  isAdminOrganization: true,
};

const service: EnterpriseParkService = {
  parkId: park.id,
  id: 'repair',
  name: 'Repair',
  enabled: true,
  config: {},
  updatedAt: '2026-07-20',
};

function account(id: string, name: string): EnterpriseAccount {
  return {
    id,
    organizationId: 'org-1',
    organizationName: 'Park Operations',
    employeeId: null,
    username: id,
    phone: null,
    name,
    role: 'Support',
    department: 'Park Services',
    positionId: null,
    positionTitle: null,
    isAdmin: false,
    status: 'active',
    tags: ['Support'],
    createdAt: '2026-07-20',
    updatedAt: '2026-07-20',
  };
}

describe('park service specialist assignments', () => {
  it('adds another specialist without replacing existing assignments', async () => {
    const accounts = [account('alice', 'Alice'), account('bob', 'Bob'), account('carol', 'Carol')];
    let specialists: EnterpriseParkSpecialist[] = [
      { parkId: park.id, serviceId: service.id, accountId: 'alice', name: 'Alice' },
      { parkId: park.id, serviceId: service.id, accountId: 'bob', name: 'Bob' },
    ];
    const setSpecialist = vi.fn(async (serviceId: string, accountId: string) => {
      const specialist = {
        parkId: park.id,
        serviceId,
        accountId,
        name: accounts.find((item) => item.id === accountId)?.name || accountId,
      };
      specialists = [...specialists, specialist];
      return specialist;
    });
    const removeSpecialist = vi.fn(async (serviceId: string, accountId: string) => {
      specialists = specialists.filter((item) => item.serviceId !== serviceId || item.accountId !== accountId);
      return true;
    });

    Object.assign(window.otto, {
      enterpriseOrganizationFeaturesGet: vi.fn(async () => features),
      enterpriseOrganizationDepartments: vi.fn(async () => []),
      enterpriseParkView: vi.fn(async () => park),
      enterpriseParkServices: vi.fn(async () => [service]),
      enterpriseParkSpecialists: vi.fn(async () => specialists),
      enterpriseParkSpecialistSet: setSpecialist,
      enterpriseParkSpecialistRemove: removeSpecialist,
    });

    render(<EnterpriseAdministrationPanel accounts={accounts} />);
    const assignedLabel = `Repair\u5df2\u5206\u914d\u4e13\u5458`;
    const addLabel = `Repair\u6dfb\u52a0\u670d\u52a1\u4e13\u5458`;
    const assigned = await screen.findByLabelText(assignedLabel);
    expect(within(assigned).getByText('Alice')).toBeTruthy();
    expect(within(assigned).getByText('Bob')).toBeTruthy();

    fireEvent.change(screen.getByLabelText(addLabel), { target: { value: 'carol' } });
    fireEvent.click(screen.getByRole('button', { name: '\u6dfb\u52a0' }));
    await waitFor(() => expect(setSpecialist).toHaveBeenCalledWith('repair', 'carol'));
    expect(removeSpecialist).not.toHaveBeenCalled();
    await waitFor(() => expect(within(screen.getByLabelText(assignedLabel)).getByText('Carol')).toBeTruthy());
    expect(screen.getByText(`3 \u540d\u670d\u52a1\u4e13\u5458`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `\u4eceRepair\u79fb\u9664Alice` }));
    await waitFor(() => expect(removeSpecialist).toHaveBeenCalledWith('repair', 'alice'));
    await waitFor(() => expect(within(screen.getByLabelText(assignedLabel)).queryByText('Alice')).toBeNull());
    expect(within(screen.getByLabelText(assignedLabel)).getByText('Bob')).toBeTruthy();
    expect(within(screen.getByLabelText(assignedLabel)).getByText('Carol')).toBeTruthy();
  });
});

describe('organization structure editor', () => {
  it('keeps each department and its positions in one editable group', async () => {
    const organizationFeatures: EnterpriseOrganizationFeatures = {
      ...features,
      enterprise_tree: true,
      park_service: false,
    };
    const departments = [{
      id: 'dept-party',
      organizationId: 'org-1',
      name: '党群工作部',
      memberCount: 2,
      positions: [{
        id: 'position-organizer',
        organizationId: 'org-1',
        departmentId: 'dept-party',
        title: '组织干事',
        roleMapping: 'member' as const,
        createdAt: '2026-07-20',
        updatedAt: '2026-07-20',
      }],
      createdAt: '2026-07-20',
      updatedAt: '2026-07-20',
    }, {
      id: 'dept-incubator',
      organizationId: 'org-1',
      name: '孵化服务部',
      memberCount: 3,
      positions: [{
        id: 'position-specialist',
        organizationId: 'org-1',
        departmentId: 'dept-incubator',
        title: '专员',
        roleMapping: 'member' as const,
        createdAt: '2026-07-20',
        updatedAt: '2026-07-20',
      }],
      createdAt: '2026-07-20',
      updatedAt: '2026-07-20',
    }];
    const createPosition = vi.fn(async () => departments[0].positions[0]);
    const updatePosition = vi.fn(async () => departments[0].positions[0]);
    Object.assign(window.otto, {
      enterpriseOrganizationFeaturesGet: vi.fn(async () => organizationFeatures),
      enterpriseOrganizationDepartments: vi.fn(async () => departments),
      enterpriseOrganizationPositionCreate: createPosition,
      enterpriseOrganizationPositionUpdate: updatePosition,
      enterpriseOrganizationPositionDelete: vi.fn(async () => true),
      enterpriseOrganizationDepartmentCreate: vi.fn(async () => departments[0]),
      enterpriseOrganizationDepartmentUpdate: vi.fn(async () => departments[0]),
      enterpriseOrganizationDepartmentDelete: vi.fn(async () => true),
    });

    render(<EnterpriseAdministrationPanel accounts={[]} />);

    const partyDepartment = await screen.findByRole('region', { name: '党群工作部部门设置' });
    const incubatorDepartment = screen.getByRole('region', { name: '孵化服务部部门设置' });
    expect(within(partyDepartment).getByDisplayValue('组织干事')).toBeTruthy();
    expect(within(partyDepartment).queryByDisplayValue('专员')).toBeNull();
    expect(within(incubatorDepartment).getByDisplayValue('专员')).toBeTruthy();
    expect(within(partyDepartment).getByText('2 名在职成员 · 1 个职位')).toBeTruthy();

    fireEvent.click(within(partyDepartment).getByRole('button', { name: '保存职位' }));
    await waitFor(() => expect(updatePosition).toHaveBeenCalledWith('position-organizer', {
      title: '组织干事',
      roleMapping: 'member',
    }));

    const form = within(partyDepartment).getByRole('form', { name: '为党群工作部新增职位' });
    fireEvent.change(within(form).getByPlaceholderText('例如：产品经理'), {
      target: { value: '宣传主管' },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(createPosition).toHaveBeenCalledWith({
      departmentId: 'dept-party',
      title: '宣传主管',
      roleMapping: 'member',
    }));
  });
});
