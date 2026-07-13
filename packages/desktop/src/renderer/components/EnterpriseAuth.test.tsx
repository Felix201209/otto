/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseLoginPage } from './EnterpriseLoginPage.js';
import { AccountManagementPage } from './AccountManagementPage.js';
import type { EnterpriseAccount } from '../../preload/index.js';

const ADMIN: EnterpriseAccount = {
  id: 'admin-1', employeeId: null, username: 'admin', name: '系统管理员',
  role: '管理员', department: 'IT', isAdmin: true, status: 'active', tags: ['IT'],
  createdAt: '2026-07-12', updatedAt: '2026-07-12',
};

beforeEach(() => {
  window.otto = {
    enterpriseAccounts: vi.fn(async () => [ADMIN]),
    enterpriseAccountCreate: vi.fn(async (input) => ({
      ...ADMIN,
      id: 'new-1', username: input.username, name: input.name,
      role: input.role ?? null, department: input.department ?? null,
      isAdmin: input.isAdmin ?? false, tags: input.tags ?? [],
    })),
    enterpriseAccountUpdate: vi.fn(async () => ADMIN),
  } as unknown as Window['otto'];
});

describe('EnterpriseLoginPage', () => {
  it('显示 Ubuntu-wysn 地址并提交账号密码，不出现邮箱或验证码流程', async () => {
    const onLogin = vi.fn(async () => undefined);
    render(
      <EnterpriseLoginPage
        initialServerUrl="http://59.110.154.44:7777"
        busy={false}
        error={null}
        onLogin={onLogin}
      />,
    );

    expect(screen.queryByLabelText(/邮箱/)).toBeNull();
    expect((screen.getByLabelText('企业服务器') as HTMLInputElement).value).toBe('http://59.110.154.44:7777');
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'staff01' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'staff-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录 Otto' }));

    await waitFor(() => expect(onLogin).toHaveBeenCalledWith({
      serverUrl: 'http://59.110.154.44:7777', username: 'staff01', password: 'staff-password',
    }));
  });
});

describe('AccountManagementPage', () => {
  it('能查看账号并从完整表单新增带标签的预设账号', async () => {
    render(<AccountManagementPage currentAccount={ADMIN} onBack={() => undefined} />);
    expect(await screen.findByText('系统管理员')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '新增账号' }));
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'it01' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'IT 一号' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'it-password-1' } });
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: '桌面支持' } });
    fireEvent.change(screen.getByLabelText('部门'), { target: { value: 'IT' } });
    fireEvent.change(screen.getByLabelText('账号标签'), { target: { value: 'IT，报修' } });
    fireEvent.click(screen.getByRole('button', { name: '保存账号' }));

    await waitFor(() => expect(window.otto.enterpriseAccountCreate).toHaveBeenCalledWith({
      username: 'it01', name: 'IT 一号', password: 'it-password-1', role: '桌面支持',
      department: 'IT', tags: ['IT', '报修'], isAdmin: false,
    }));
    expect(await screen.findByText('IT 一号')).toBeTruthy();
  });
});
