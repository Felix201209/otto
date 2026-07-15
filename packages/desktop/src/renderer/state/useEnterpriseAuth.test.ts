/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnterpriseAuth } from './useEnterpriseAuth.js';

const ACCOUNT = {
  id: 'acc_1',
  organizationId: 'org_acme',
  organizationName: '星河科技',
  employeeId: null,
  username: 'staff01',
  phone: '+8613800138000',
  name: '员工一号',
  role: null,
  department: null,
  isAdmin: false,
  status: 'active' as const,
  tags: [],
  createdAt: '2026-07-14',
  updatedAt: '2026-07-14',
};

let intentHandler: ((intent: { inviteCode: string }) => void) | null = null;
let bridge: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  intentHandler = null;
  bridge = {
    enterpriseSession: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
    })),
    enterpriseRegistrationIntent: vi.fn(async () => ({ inviteCode: 'ABCD-EFGH' })),
    onEnterpriseRegistrationIntent: vi.fn((handler: (intent: { inviteCode: string }) => void) => {
      intentHandler = handler;
      return () => { intentHandler = null; };
    }),
    enterprisePasswordLogin: vi.fn(),
    enterpriseRegistrationRequest: vi.fn(),
    enterpriseRegister: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
      expiresAt: '2099-01-01',
    })),
    enterpriseLogout: vi.fn(),
  };
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: bridge as unknown as Window['otto'],
  });
});

describe('企业注册链接进入中心注册', () => {
  it('未登录时 cold-start intent 进入首次注册，但不允许链接替换 App 内置服务器', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));

    expect(view.result.current.state.registrationIntent).toEqual({ inviteCode: 'ABCD-EFGH' });
    expect(view.result.current.state.serverUrl).toBe('https://enterprise.otto.test');
    expect(view.result.current.state.account).toBeNull();
  });

  it('已有有效自动登录账号时忽略 cold-start 与运行中链接，不静默退出或换企', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
    });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));
    expect(view.result.current.state.registrationIntent).toBeNull();

    act(() => intentHandler?.({ inviteCode: 'WXYZ-2345' }));
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.id).toBe('acc_1');
    expect(view.result.current.state.registrationIntent).toBeNull();
  });

  it('运行中的 second-instance/open-url intent 会实时替换待注册邀请码', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(intentHandler).not.toBeNull());

    act(() => intentHandler?.({ inviteCode: 'WXYZ-2345' }));
    expect(view.result.current.state.registrationIntent).toEqual({ inviteCode: 'WXYZ-2345' });
    expect(view.result.current.state.status).toBe('signed-out');
  });

  it('中心注册成功后清除 intent 并进入新企业账号', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.registrationIntent).not.toBeNull());

    await act(async () => {
      await view.result.current.actions.register({
        challengeId: 'sms_1', code: '123456', name: '员工一号', password: 'password-1',
      });
    });
    expect(view.result.current.state.registrationIntent).toBeNull();
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.organizationId).toBe('org_acme');
  });
});
