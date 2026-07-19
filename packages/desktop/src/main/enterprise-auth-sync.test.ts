/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { EnterpriseAccount, EnterpriseSessionResult } from './enterprise-client.js';
import type { AuthenticatedEnterpriseAccountInput } from './enterprise-identity.js';
import {
  authenticateAndSyncEnterpriseAccount,
  clearInvalidatedEnterpriseIdentity,
  EnterpriseAuthOperationQueue,
  logoutAndClearEnterpriseIdentity,
  refreshEnterpriseIdentityLease,
  restoreAndSyncEnterpriseSession,
  syncVerifiedEnterpriseAccount,
} from './enterprise-auth-sync.js';

const ACCOUNT: EnterpriseAccount = {
  id: 'acc_1',
  organizationId: 'org_1',
  organizationName: 'Otto 企业',
  employeeId: 'OTTO-001',
  username: 'staff01',
  phone: '13800000000',
  name: '员工一号',
  role: 'member',
  department: '产品与研发部',
  positionId: 'pos_engineer',
  positionTitle: '工程师',
  isAdmin: false,
  status: 'active',
  tags: ['engineering'],
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

const LOCAL_ACCOUNT = {
  id: 'acc_1',
  organizationId: 'org_1',
  organizationName: 'Otto 企业',
  name: '员工一号',
  isAdmin: false,
  role: 'member',
  tags: ['engineering'],
  department: '产品与研发部',
  positionId: 'pos_engineer',
  positionTitle: '工程师',
};

describe('enterprise auth identity synchronization', () => {
  it('从远端请求开始就串行化认证事务，旧退出不能在新登录后补写本机清理', async () => {
    const queue = new EnterpriseAuthOperationQueue();
    const order: string[] = [];
    let releaseLogout!: () => void;
    const logoutPending = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });

    const logout = queue.run(async () => {
      order.push('logout:start');
      await logoutPending;
      order.push('logout:clear-local');
    });
    const login = queue.run(async () => {
      order.push('login:start');
      order.push('login:set-local');
    });

    await vi.waitFor(() => {
      expect(order).toEqual(['logout:start']);
    });
    releaseLogout();
    await Promise.all([logout, login]);
    expect(order).toEqual([
      'logout:start',
      'logout:clear-local',
      'login:start',
      'login:set-local',
    ]);
  });

  it('前一个认证事务失败后仍会执行队列中的下一次登录', async () => {
    const queue = new EnterpriseAuthOperationQueue();
    const first = queue.run(async () => {
      throw new Error('logout failed');
    });
    const second = queue.run(async () => 'login ok');

    await expect(first).rejects.toThrow('logout failed');
    await expect(second).resolves.toBe('login ok');
  });

  it('密码登录只有在本机 server 应用服务端认证账号后才持久化并返回', async () => {
    const order: string[] = [];
    const authenticate = vi.fn(async () => {
      order.push('authenticate');
      return { account: ACCOUNT, expiresAt: '2099-01-01' };
    });
    const synchronize = vi.fn(async (account) => {
      order.push('synchronize');
      expect(account).toEqual({
        ...LOCAL_ACCOUNT,
        leaseExpiresAt: expect.any(String),
      });
    });
    const persist = vi.fn(() => order.push('persist'));
    const client = { logout: vi.fn(async () => undefined) };

    await expect(authenticateAndSyncEnterpriseAccount(
      authenticate,
      client,
      synchronize,
      persist,
    )).resolves.toEqual({ account: ACCOUNT, expiresAt: '2099-01-01' });

    expect(order).toEqual(['authenticate', 'synchronize', 'persist']);
    expect(client.logout).not.toHaveBeenCalled();
  });

  it('登录后的本机身份同步失败会清中心 token、持久化退出态并保持登录页', async () => {
    const synchronize = vi.fn()
      .mockRejectedValueOnce(new Error('旧版本本机 OttoServer，请重启'))
      .mockRejectedValueOnce(new Error('旧 server 无法清理'));
    const logout = vi.fn(async () => undefined);
    const persist = vi.fn();

    await expect(authenticateAndSyncEnterpriseAccount(
      async () => ({ account: ACCOUNT, expiresAt: '2099-01-01' }),
      { logout },
      synchronize,
      persist,
    )).rejects.toThrow('旧版本本机 OttoServer，请重启');

    expect(logout).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenNthCalledWith(1, {
      ...LOCAL_ACCOUNT,
      leaseExpiresAt: expect.any(String),
    });
    expect(synchronize).toHaveBeenNthCalledWith(2, null);
  });

  it('恢复会话必须先同步本机身份；同步失败返回未登录和明确错误', async () => {
    const session: EnterpriseSessionResult = {
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
    };
    const synchronize = vi.fn()
      .mockRejectedValueOnce(new Error('本机 OttoServer 身份同步失败，请重启'))
      .mockResolvedValueOnce(undefined);
    const logout = vi.fn(async () => undefined);
    const persist = vi.fn();

    const result = await restoreAndSyncEnterpriseSession(
      session,
      { logout },
      synchronize,
      persist,
    );

    expect(result).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: expect.stringContaining('本机 OttoServer 身份同步失败，请重启'),
    });
    expect(logout).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenNthCalledWith(1, {
      ...LOCAL_ACCOUNT,
      leaseExpiresAt: expect.any(String),
    });
    expect(synchronize).toHaveBeenNthCalledWith(2, null);
  });

  it('恢复到未登录态时也会清除本机 server 残留身份', async () => {
    const synchronize = vi.fn(async () => undefined);
    const session: EnterpriseSessionResult = {
      serverUrl: 'https://enterprise.otto.test',
      account: null,
    };

    await expect(restoreAndSyncEnterpriseSession(
      session,
      { logout: vi.fn(async () => undefined) },
      synchronize,
      vi.fn(),
    )).resolves.toEqual(session);

    expect(synchronize).toHaveBeenCalledWith(null);
  });

  it('退出即使中心 logout 失败也会持久化退出态并清本机身份', async () => {
    const logoutError = new Error('中心服务暂不可达');
    const logout = vi.fn(async () => { throw logoutError; });
    const persist = vi.fn();
    const synchronize = vi.fn(async () => undefined);

    await expect(logoutAndClearEnterpriseIdentity(
      { logout },
      synchronize,
      persist,
    )).rejects.toThrow('中心服务暂不可达');

    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledWith(null);
  });

  it('401 失效回调会先持久化已清 token，再清本机身份', async () => {
    const order: string[] = [];
    const persist = vi.fn(() => order.push('persist'));
    const synchronize = vi.fn(async () => { order.push('clear-local'); });

    await clearInvalidatedEnterpriseIdentity(synchronize, persist);

    expect(order).toEqual(['persist', 'clear-local']);
    expect(synchronize).toHaveBeenCalledWith(null);
  });

  it('自降权导致中心会话撤销时只清本机身份，不沿用更新响应继续授权', async () => {
    const synchronize = vi.fn(async () => undefined);
    const logout = vi.fn(async () => undefined);

    await syncVerifiedEnterpriseAccount(
      null,
      { logout },
      synchronize,
      vi.fn(),
    );

    expect(synchronize).toHaveBeenCalledWith(null);
    expect(logout).not.toHaveBeenCalled();
  });

  it('后台 /auth/me 成功时刷新本机身份短租约', async () => {
    const synchronize = vi.fn(
      async (_account: AuthenticatedEnterpriseAccountInput | null) => undefined,
    );
    const before = Date.now();

    await expect(refreshEnterpriseIdentityLease(
      { serverUrl: 'https://enterprise.otto.test', account: ACCOUNT },
      { logout: vi.fn(async () => undefined) },
      synchronize,
      vi.fn(),
    )).resolves.toBe('refreshed');

    const synced = synchronize.mock.calls[0]?.[0];
    expect(synced).toEqual({
      ...LOCAL_ACCOUNT,
      leaseExpiresAt: expect.any(String),
    });
    expect(Date.parse(synced?.leaseExpiresAt ?? '')).toBeGreaterThan(before);
  });

  it('后台刷新遇到临时网络错误时不延长也不主动清除租约', async () => {
    const synchronize = vi.fn(async () => undefined);
    const persist = vi.fn();
    const logout = vi.fn(async () => undefined);

    await expect(refreshEnterpriseIdentityLease(
      {
        serverUrl: 'https://enterprise.otto.test',
        account: null,
        connectionError: '连接超时',
      },
      { logout },
      synchronize,
      persist,
    )).resolves.toBe('deferred');

    expect(synchronize).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('后台刷新确认中心会话失效时立即清本机身份并持久化退出态', async () => {
    const synchronize = vi.fn(async () => undefined);
    const persist = vi.fn();

    await expect(refreshEnterpriseIdentityLease(
      { serverUrl: 'https://enterprise.otto.test', account: null },
      { logout: vi.fn(async () => undefined) },
      synchronize,
      persist,
    )).resolves.toBe('signed-out');

    expect(synchronize).toHaveBeenCalledWith(null);
    expect(persist).toHaveBeenCalledOnce();
  });
});
