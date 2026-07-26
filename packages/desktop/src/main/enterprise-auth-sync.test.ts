/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EnterpriseAccount, EnterpriseSessionResult } from './enterprise-client.js';
import type { AuthenticatedEnterpriseAccountInput } from './enterprise-identity.js';
import {
  authenticateAndSyncEnterpriseAccount,
  clearInvalidatedEnterpriseIdentity,
  ENTERPRISE_IDENTITY_LEASE_MS,
  EnterpriseAuthOperationQueue,
  failClosedUncertainEnterpriseJoin,
  logoutAndClearEnterpriseIdentity,
  refreshEnterpriseIdentityLease,
  restoreAndSyncEnterpriseSession,
  syncJoinedEnterpriseAccount,
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

const ORGANIZATION_VIEW = {
  organization: {
    id: 'org_1',
    name: 'Otto 企业',
    status: 'active' as const,
    createdAt: '2026-07-01T00:00:00.000Z',
  },
  members: [
    {
      id: 'acc_1',
      username: 'staff01',
      name: '远端目录里的旧姓名',
      role: 'member',
      department: '旧部门',
      positionId: 'old-position',
      positionTitle: '旧职位',
      isAdmin: false,
      status: 'active' as const,
    },
    {
      id: 'acc_2',
      username: '  staff02  ',
      name: '  员工二号  ',
      role: 'member',
      department: '  销售部  ',
      positionId: '  pos_sales  ',
      positionTitle: '  销售经理  ',
      isAdmin: false,
      status: 'active' as const,
    },
    {
      id: 'acc_disabled',
      username: 'disabled',
      name: '停用员工',
      role: 'member',
      department: null,
      positionId: null,
      positionTitle: null,
      isAdmin: false,
      status: 'disabled' as const,
    },
  ],
  employeeCount: 3,
};

describe('enterprise auth identity synchronization', () => {
  it('keeps enterprise center token at 30 days and local identity lease at 10 minutes with 2 minute refresh', () => {
    expect(ENTERPRISE_IDENTITY_LEASE_MS).toBe(10 * 60_000);

    const mainSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    expect(mainSource).toContain('const ENTERPRISE_IDENTITY_REFRESH_INTERVAL_MS = 2 * 60_000');

    const enterpriseDbSource = readFileSync(
      resolve(__dirname, '../../../server/src/enterprise/db.ts'),
      'utf8',
    );
    expect(enterpriseDbSource).toContain('ttlMs = 30 * 24 * 60 * 60 * 1000');
  });

  it('主进程退出处理只清企业身份，不删除本机对话、模型、知识库或 Skill', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const handlerStart = source.indexOf('ipcMain.handle(IPC.enterpriseLogout');
    const handlerEnd = source.indexOf('ipcMain.handle(IPC.enterprisePair', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const logoutHandler = source.slice(handlerStart, handlerEnd);
    expect(logoutHandler).toContain('logoutAndClearEnterpriseIdentity');
    expect(logoutHandler).toContain('fileAccessGrants.clear()');
    expect(logoutHandler).toContain('notificationService.clearAll()');
    expect(logoutHandler).not.toMatch(/\brmSync\b|promises\.rm|\bunlink\b|\.otto-user/);
  });

  it('取消更新只取消下载，不清附件授权或未读通知', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    const handlerStart = source.indexOf('ipcMain.handle(IPC.updateCancel');
    const handlerEnd = source.indexOf('ipcMain.handle(IPC.updateInstall', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);

    const cancelHandler = source.slice(handlerStart, handlerEnd);
    expect(cancelHandler).toContain('updateService.cancelDownload()');
    expect(cancelHandler).not.toContain('fileAccessGrants.clear()');
    expect(cancelHandler).not.toContain('notificationService.clearAll()');
  });

  it('mac 打包版不会无条件恢复 Keychain token 以免系统密码框卡死登录页', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
    expect(source).toContain('function canRestoreEncryptedEnterpriseSession()');
    expect(source).toContain("process.env.OTTO_ENTERPRISE_RESTORE_KEYCHAIN_SESSION === '1'");
    expect(source).toContain("process.platform === 'darwin' && app.isPackaged");
    expect(source).toContain('if (!canRestoreEncryptedEnterpriseSession()) return');
  });

  it('协议与工作区服务不暴露可由退出流程触发的整库销毁入口', () => {
    const protocolSource = readFileSync(
      resolve(__dirname, '../../../server/src/protocol.ts'),
      'utf8',
    );
    const workspaceSource = readFileSync(
      resolve(__dirname, '../../../server/src/productWorkspaceStore.ts'),
      'utf8',
    );
    const serverSource = readFileSync(
      resolve(__dirname, '../../../server/src/server.ts'),
      'utf8',
    );

    expect(protocolSource).not.toContain('destroy_product_workspace');
    expect(workspaceSource).not.toContain('destroyAllUserData');
    expect(serverSource).not.toContain('destroyAllUserData');
  });

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

  it('登录时从中心组织树同步最多 200 个 active 成员并规整有界字段', async () => {
    const members = [
      ...ORGANIZATION_VIEW.members,
      ...Array.from({ length: 205 }, (_, index) => ({
        id: `acc_extra_${index}`,
        username: `extra_${index}`,
        name: `成员 ${index}`,
        role: 'member',
        department: null,
        positionId: null,
        positionTitle: null,
        isAdmin: false,
        status: 'active' as const,
      })),
    ];
    const getOrganizationView = vi.fn(async () => ({
      ...ORGANIZATION_VIEW,
      members,
      employeeCount: members.length,
    }));
    const synchronize = vi.fn(
      async (_account: AuthenticatedEnterpriseAccountInput | null) => undefined,
    );

    await authenticateAndSyncEnterpriseAccount(
      async () => ({ account: ACCOUNT }),
      { logout: vi.fn(async () => undefined), getOrganizationView },
      synchronize,
      vi.fn(),
    );

    expect(getOrganizationView).toHaveBeenCalledOnce();
    const synced = synchronize.mock.calls[0]?.[0];
    expect(synced?.organizationMembers).toHaveLength(200);
    expect(synced?.organizationMembers).toContainEqual({
      id: 'acc_2',
      username: 'staff02',
      name: '员工二号',
      role: 'member',
      department: '销售部',
      positionId: 'pos_sales',
      positionTitle: '销售经理',
      isAdmin: false,
      status: 'active',
    });
    expect(
      synced?.organizationMembers?.some(
        (member) => member.id === 'acc_disabled',
      ),
    ).toBe(false);
  });

  it('中心组织树读取失败时仍同步真实当前账号，但不伪造同事目录', async () => {
    const synchronize = vi.fn(
      async (_account: AuthenticatedEnterpriseAccountInput | null) => undefined,
    );

    await authenticateAndSyncEnterpriseAccount(
      async () => ({ account: ACCOUNT }),
      {
        logout: vi.fn(async () => undefined),
        getOrganizationView: vi.fn(async () => {
          throw new Error('组织树暂不可达');
        }),
      },
      synchronize,
      vi.fn(),
    );

    expect(synchronize).toHaveBeenCalledWith({
      ...LOCAL_ACCOUNT,
      leaseExpiresAt: expect.any(String),
    });
  });

  it('恢复会话和租约刷新都会重新读取中心组织树，不沿用旧目录', async () => {
    const getOrganizationView = vi.fn(async () => ORGANIZATION_VIEW);
    const client = {
      logout: vi.fn(async () => undefined),
      getOrganizationView,
    };
    const synchronize = vi.fn(
      async (_account: AuthenticatedEnterpriseAccountInput | null) => undefined,
    );
    const session: EnterpriseSessionResult = {
      serverUrl: 'https://enterprise.otto.test',
      account: ACCOUNT,
    };

    await restoreAndSyncEnterpriseSession(session, client, synchronize, vi.fn());
    await refreshEnterpriseIdentityLease(session, client, synchronize, vi.fn());

    expect(getOrganizationView).toHaveBeenCalledTimes(2);
    expect(synchronize.mock.calls[0]?.[0]?.organizationMembers).toEqual(
      synchronize.mock.calls[1]?.[0]?.organizationMembers,
    );
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

  it('加入企业已在中心提交后若本机同步失败，返回可识别的重新登录错误并完成回滚', async () => {
    const synchronize = vi.fn()
      .mockRejectedValueOnce(new Error('本机控制面不可用'))
      .mockResolvedValueOnce(undefined);
    const logout = vi.fn(async () => undefined);
    const persist = vi.fn();

    await expect(syncJoinedEnterpriseAccount(
      ACCOUNT,
      { logout },
      synchronize,
      persist,
    )).rejects.toThrow('企业已成功加入，但本机身份同步失败，请重新登录以完成企业切换');

    expect(logout).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenNthCalledWith(1, {
      ...LOCAL_ACCOUNT,
      leaseExpiresAt: expect.any(String),
    });
    expect(synchronize).toHaveBeenNthCalledWith(2, null);
  });

  it('加入企业结果无法对账时，即使远端登出失败也清空本机身份并要求重新登录', async () => {
    const synchronize = vi.fn(async () => undefined);
    const logout = vi.fn(async () => {
      throw new Error('中心服务仍不可达');
    });
    const persist = vi.fn();

    await expect(failClosedUncertainEnterpriseJoin(
      new Error('无法确认企业升级结果'),
      { logout },
      synchronize,
      persist,
    )).rejects.toThrow(
      '企业已成功加入，但本机身份同步失败，请重新登录以完成企业切换：无法确认企业升级结果',
    );

    expect(logout).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledWith(null);
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

  it('退出不等待中心响应，立即持久化退出态并清本机身份', async () => {
    let finishRemoteLogout!: () => void;
    const remoteLogout = new Promise<void>((resolve) => {
      finishRemoteLogout = resolve;
    });
    const logout = vi.fn(() => remoteLogout);
    const persist = vi.fn();
    const synchronize = vi.fn(async () => undefined);

    await expect(logoutAndClearEnterpriseIdentity(
      { logout },
      synchronize,
      persist,
    )).resolves.toBeUndefined();

    expect(persist).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledWith(null);
    finishRemoteLogout();
    await remoteLogout;
  });

  it('中心 logout 后台失败也不会把客户端卡在已登录状态', async () => {
    const logoutError = new Error('中心服务暂不可达');
    const logout = vi.fn(async () => { throw logoutError; });
    const persist = vi.fn();
    const synchronize = vi.fn(async () => undefined);

    await expect(logoutAndClearEnterpriseIdentity(
      { logout },
      synchronize,
      persist,
    )).resolves.toBeUndefined();

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
