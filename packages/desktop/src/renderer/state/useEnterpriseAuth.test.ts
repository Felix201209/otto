/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseAccount } from '../../preload/index.js';
import { useEnterpriseAuth } from './useEnterpriseAuth.js';

const ACCOUNT: EnterpriseAccount = {
  id: 'acc_1',
  organizationId: 'org_acme',
  organizationName: '星河科技',
  employeeId: null,
  username: 'staff01',
  phone: '+8613800138000',
  name: '员工一号',
  role: null,
  department: null,
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active' as const,
  tags: [],
  createdAt: '2026-07-14',
  updatedAt: '2026-07-14',
};

const PERSONAL_ACCOUNT = {
  ...ACCOUNT,
  organizationId: 'personal_acc_1',
  organizationName: '员工一号的个人空间',
  accountType: 'personal' as const,
};

const UPGRADED_ACCOUNT = {
  ...ACCOUNT,
  accountType: 'enterprise' as const,
  department: '产品部',
  positionTitle: '产品经理',
};

let intentHandler: ((intent: { inviteCode: string; serverUrl?: string }) => void) | null = null;
let invalidatedHandler: (() => void) | null = null;
let accountUpdatedHandler: ((account: typeof ACCOUNT) => void) | null = null;
let bridge: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  intentHandler = null;
  invalidatedHandler = null;
  accountUpdatedHandler = null;
  bridge = {
    enterpriseSession: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
    })),
    enterpriseRegistrationIntent: vi.fn(async () => ({ inviteCode: 'Ab3D-k9Pq-Z7xY' })),
    onEnterpriseRegistrationIntent: vi.fn((
      handler: (intent: { inviteCode: string; serverUrl?: string }) => void,
    ) => {
      intentHandler = handler;
      return () => { intentHandler = null; };
    }),
    onEnterpriseSessionInvalidated: vi.fn((handler: () => void) => {
      invalidatedHandler = handler;
      return () => { invalidatedHandler = null; };
    }),
    onEnterpriseAccountUpdated: vi.fn((handler: (account: typeof ACCOUNT) => void) => {
      accountUpdatedHandler = handler;
      return () => { accountUpdatedHandler = null; };
    }),
    enterprisePasswordLogin: vi.fn(),
    enterpriseSmsLoginRequest: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      challengeId: 'sms_login_1',
      message: '验证码已发送',
      expiresAt: '2099-01-01',
      retryAfterSeconds: 60,
    })),
    enterpriseSmsLoginVerify: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
      expiresAt: '2099-01-01',
    })),
    enterpriseRegistrationRequest: vi.fn(),
    enterpriseRegister: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
      expiresAt: '2099-01-01',
    })),
    enterpriseJoinOrganization: vi.fn(async () => ({
      serverUrl: 'https://enterprise.otto.test',
      account: UPGRADED_ACCOUNT,
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

    expect(view.result.current.state.registrationIntent).toEqual({ inviteCode: 'Ab3D-k9Pq-Z7xY' });
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

    act(() => intentHandler?.({ inviteCode: 'Wz8Y-m3Na-Q5pB' }));
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.id).toBe('acc_1');
    expect(view.result.current.state.registrationIntent).toBeNull();
  });

  it('运行中的 second-instance/open-url intent 先切到已规范化服务器，再替换待注册邀请码', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));
    expect(view.result.current.state.serverUrl).toBe('https://enterprise.otto.test');

    act(() => intentHandler?.({
      inviteCode: 'Wz8Y-m3Na-Q5pB',
      serverUrl: 'https://new-enterprise.otto.test',
    }));
    expect(view.result.current.state.serverUrl).toBe('https://new-enterprise.otto.test');
    expect(view.result.current.state.registrationIntent).toEqual({
      inviteCode: 'Wz8Y-m3Na-Q5pB',
      serverUrl: 'https://new-enterprise.otto.test',
    });
    expect(view.result.current.state.status).toBe('signed-out');
  });

  it('中心注册成功后清除 intent 并进入新企业账号', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.registrationIntent).not.toBeNull());

    await act(async () => {
      await view.result.current.actions.register({
        challengeId: 'sms_1', code: '123456', name: '员工一号', password: 'password-1', legalConsent: true,
      });
    });
    expect(view.result.current.state.registrationIntent).toBeNull();
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.organizationId).toBe('org_acme');
  });

  it('短信验证码登录成功后进入账号，并清除企业邀请意图', async () => {
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));

    let challenge!: Awaited<ReturnType<typeof view.result.current.actions.requestLoginCode>>;
    await act(async () => {
      challenge = await view.result.current.actions.requestLoginCode({
        serverUrl: 'https://enterprise.otto.test',
        phone: '13800138000',
      });
    });
    expect(challenge.challengeId).toBe('sms_login_1');

    await act(async () => {
      await view.result.current.actions.loginWithSms({
        challengeId: challenge.challengeId,
        code: '042731',
      });
    });
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.id).toBe(ACCOUNT.id);
    expect(view.result.current.state.registrationIntent).toBeNull();
  });

  it('个人账号可用企业邀请码升级，并立即刷新为企业身份', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: PERSONAL_ACCOUNT,
    });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    await act(async () => {
      await view.result.current.actions.joinEnterprise({ inviteCode: 'Ab3D-k9Pq-Z7xY' });
    });

    expect(bridge.enterpriseJoinOrganization).toHaveBeenCalledWith({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
    });
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account).toMatchObject({
      accountType: 'enterprise',
      organizationId: 'org_acme',
      department: '产品部',
      positionTitle: '产品经理',
    });
    expect(view.result.current.state.registrationIntent).toBeNull();
  });

  it('个人账号升级失败时保留当前登录身份，允许原地改邀请码重试', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: PERSONAL_ACCOUNT,
    });
    bridge.enterpriseJoinOrganization.mockRejectedValueOnce(new Error('企业邀请码无效或已失效'));
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    let failure: unknown;
    await act(async () => {
      try {
        await view.result.current.actions.joinEnterprise({ inviteCode: 'Wz8Y-m3Na-Q5pB' });
      } catch (cause) {
        failure = cause;
      }
    });

    expect(failure).toEqual(new Error('企业邀请码无效或已失效'));
    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.accountType).toBe('personal');
    expect(view.result.current.state.error).toBe('企业邀请码无效或已失效');
    expect(view.result.current.state.busy).toBe(false);
  });

  it('中心已完成升级但本机身份同步失败时退出旧个人身份，避免卡在不可重试的分裂态', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: PERSONAL_ACCOUNT,
    });
    bridge.enterpriseJoinOrganization.mockRejectedValueOnce(
      new Error('企业已成功加入，但本机身份同步失败，请重新登录以完成企业切换：本机控制面不可用'),
    );
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    await act(async () => {
      await expect(
        view.result.current.actions.joinEnterprise({ inviteCode: 'Ab3D-k9Pq-Z7xY' }),
      ).rejects.toThrow('企业已成功加入');
    });

    expect(view.result.current.state.status).toBe('signed-out');
    expect(view.result.current.state.account).toBeNull();
    expect(view.result.current.state.error).toContain('请重新登录以完成企业切换');
    expect(view.result.current.state.busy).toBe(false);
  });

  it('恢复会话断网时仍保留服务器地址，让用户无需重启即可重试', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: '连接企业服务器超时',
    });
    const view = renderHook(() => useEnterpriseAuth());

    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));

    expect(view.result.current.state.serverUrl).toBe('https://enterprise.otto.test');
    expect(view.result.current.state.error).toBe('连接企业服务器超时');
  });

  it('后台操作使 token 失效时立即退回登录页，而不是保留过期管理员界面', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
    });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    act(() => invalidatedHandler?.());

    expect(view.result.current.state.status).toBe('signed-out');
    expect(view.result.current.state.account).toBeNull();
    expect(view.result.current.state.error).toBe('登录已失效，请重新登录');
  });

  it('后台身份刷新后立即更新员工部门与职位，不要求退出重登', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
    });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    act(() => accountUpdatedHandler?.({
      ...ACCOUNT,
      department: '产品部',
      positionTitle: '产品经理',
      role: '产品负责人',
    }));

    expect(view.result.current.state.account).toMatchObject({
      department: '产品部',
      positionTitle: '产品经理',
      role: '产品负责人',
    });
  });

  it('忽略同一账号较旧的后台身份事件，避免延迟事件覆盖新职位', async () => {
    bridge.enterpriseSession.mockResolvedValueOnce({
      serverUrl: 'https://enterprise.otto.test',
      account: { ...ACCOUNT, updatedAt: '2026-07-20T12:00:00.000Z' },
    });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-in'));

    act(() => accountUpdatedHandler?.({
      ...ACCOUNT,
      department: '旧部门',
      positionTitle: '旧职位',
      updatedAt: '2026-07-20T11:59:00.000Z',
    }));

    expect(view.result.current.state.account).toMatchObject({
      department: null,
      positionTitle: null,
      updatedAt: '2026-07-20T12:00:00.000Z',
    });
  });

  it('会话失效事件发生后，较早发起的登录响应不能把过期界面重新登录', async () => {
    let finishLogin!: (value: {
      serverUrl: string;
      account: typeof ACCOUNT;
      expiresAt: string;
    }) => void;
    bridge.enterprisePasswordLogin.mockImplementationOnce(() => new Promise((resolve) => {
      finishLogin = resolve;
    }));
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));

    let loginPromise!: Promise<void>;
    act(() => {
      loginPromise = view.result.current.actions.loginWithPassword({
        serverUrl: 'https://enterprise.otto.test',
        identifier: 'staff01',
        password: 'password-1',
      });
    });
    expect(view.result.current.state.busy).toBe(true);

    act(() => invalidatedHandler?.());
    expect(view.result.current.state.status).toBe('signed-out');
    expect(view.result.current.state.busy).toBe(false);

    finishLogin({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
      expiresAt: '2099-01-01',
    });
    await act(async () => loginPromise);

    expect(view.result.current.state.status).toBe('signed-out');
    expect(view.result.current.state.account).toBeNull();
    expect(view.result.current.state.error).toBe('登录已失效，请重新登录');
  });

  it('并发登录只接受最后一次请求的结果，较慢的旧响应不能覆盖新账号', async () => {
    const newerAccount = { ...ACCOUNT, id: 'acc_2', username: 'staff02', name: '员工二号' };
    let finishFirst!: (value: {
      serverUrl: string;
      account: typeof ACCOUNT;
      expiresAt: string;
    }) => void;
    bridge.enterprisePasswordLogin
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce({
        serverUrl: 'https://enterprise.otto.test',
        account: newerAccount,
        expiresAt: '2099-01-01',
      });
    const view = renderHook(() => useEnterpriseAuth());
    await waitFor(() => expect(view.result.current.state.status).toBe('signed-out'));

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = view.result.current.actions.loginWithPassword({
        serverUrl: 'https://enterprise.otto.test',
        identifier: 'staff01',
        password: 'password-1',
      });
      second = view.result.current.actions.loginWithPassword({
        serverUrl: 'https://enterprise.otto.test',
        identifier: 'staff02',
        password: 'password-2',
      });
    });
    await act(async () => second);
    expect(view.result.current.state.account?.id).toBe('acc_2');

    finishFirst({
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
      expiresAt: '2099-01-01',
    });
    await act(async () => first);

    expect(view.result.current.state.status).toBe('signed-in');
    expect(view.result.current.state.account?.id).toBe('acc_2');
  });
});
