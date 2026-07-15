/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_TAG_PRESETS,
  AccountManagementPage,
  applyAccountTemplate,
  formatInviteRemaining,
  toggleAccountTag,
} from './AccountManagementPage.js';

const ADMIN = {
  id: 'acc_admin', organizationId: 'org_acme', organizationName: '星河科技',
  employeeId: null, username: 'admin', phone: '+8613800138000', name: '管理员',
  role: '企业管理员', department: 'IT部', isAdmin: true, status: 'active' as const,
  tags: ['企业管理员'], createdAt: '2026-07-14', updatedAt: '2026-07-14',
};

const INVITE = {
  id: 'invite_1', organizationId: 'org_acme', code: 'ABCD-EFGH',
  link: 'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH', status: 'active' as const,
  issuedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2099-07-14T05:00:00.000Z',
  validHours: 168 as const,
};

const clipboardWrite = vi.fn(async () => undefined);

beforeEach(() => {
  clipboardWrite.mockClear();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseAccounts: vi.fn(async () => [ADMIN]),
      enterpriseOrganizationInviteGet: vi.fn(async () => ({
        organization: { id: 'org_acme', name: '星河科技' }, invite: INVITE,
      })),
      enterpriseOrganizationInviteIssue: vi.fn(async () => ({
        organization: { id: 'org_acme', name: '星河科技' },
        invite: {
          ...INVITE, id: 'invite_2', code: 'WXYZ-2345',
          link: 'https://59.110.154.44:7777/enterprise/join/WXYZ-2345',
        },
      })),
    } as unknown as Window['otto'],
  });
});

describe('企业账号模板与标签预设', () => {
  it('套用 IT 支持模板时一次填好角色、部门与职责标签', () => {
    expect(applyAccountTemplate({
      username: '', password: '', name: '', phone: '', role: '', department: '', tags: '',
      isAdmin: false, status: 'active',
    }, 'it-support')).toMatchObject({
      role: 'IT 支持',
      department: 'IT部',
      tags: 'IT，报修，技术支持',
      isAdmin: false,
    });
  });

  it('预设标签可以无重复地选中和取消', () => {
    expect(ACCOUNT_TAG_PRESETS).toContain('普通成员');
    expect(toggleAccountTag('普通成员，IT', 'IT')).toBe('普通成员');
    expect(toggleAccountTag('普通成员', '审批')).toBe('普通成员，审批');
  });
});

describe('企业引入链接', () => {
  it('倒计时文案精确到秒，失效后明确提示管理员换新', () => {
    expect(formatInviteRemaining('2026-07-14T05:00:00.000Z', Date.parse('2026-07-14T00:00:01.000Z')))
      .toBe('4 小时 59 分 59 秒后失效');
    expect(formatInviteRemaining('2026-07-14T05:00:00.000Z', Date.parse('2026-07-14T05:00:00.000Z')))
      .toBe('已失效，请生成新链接');
  });

  it('管理员可复制完整链接或邀请码，并手动生成会立即替换旧链接', async () => {
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制完整引入链接' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH',
    ));
    fireEvent.click(screen.getByRole('button', { name: '复制企业邀请码' }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('ABCD-EFGH'));

    fireEvent.click(screen.getByRole('button', { name: '生成新引入链接' }));
    expect(await screen.findByText('WXYZ-2345')).toBeTruthy();
    expect(screen.queryByText('ABCD-EFGH')).toBeNull();
  });
});
