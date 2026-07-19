/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EnterpriseClient,
  logoutAndPersistEnterpriseSession,
} from './enterprise-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ACCOUNT = {
  id: 'acc_1', organizationId: 'org_acme', organizationName: '星河科技',
  employeeId: null, username: 'staff01', phone: '+8613800138000', name: '员工一号',
  role: null, department: null, isAdmin: false, status: 'active' as const,
  positionId: null, positionTitle: null,
  tags: ['普通员工'], createdAt: '2026-07-13', updatedAt: '2026-07-13',
};

const API_V2_HEALTH = {
  status: 'ok',
  apiVersion: 2,
  capabilities: [
    'password_auth',
    'sms_registration',
    'organization_invites',
    'usage_summary',
    'admin_console',
    'direct_messages',
    'position_invites',
    'park_service_push',
  ],
};

describe('EnterpriseClient', () => {
  it('密码登录规范化服务器地址并保存会话，后续请求自动携带 Bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01' }))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const loggedIn = await client.loginWithPassword('https://59-110-154-44.sslip.io/', 'staff01', 'password');
    expect(loggedIn.account.username).toBe('staff01');
    expect(client.snapshot()).toEqual({ serverUrl: 'https://59-110-154-44.sslip.io', token: 'session-token' });

    await client.getSession();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://59-110-154-44.sslip.io/enterprise/health',
      'https://59-110-154-44.sslip.io/enterprise/auth/login',
      'https://59-110-154-44.sslip.io/enterprise/auth/me',
    ]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('保留 HTTPS 部署路径前缀，并在前缀下请求全部企业接口', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.loginWithPassword(
      'https://enterprise.otto.test/company/',
      'staff01',
      'password',
    );

    expect(client.snapshot().serverUrl).toBe('https://enterprise.otto.test/company');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://enterprise.otto.test/company/enterprise/health',
      'https://enterprise.otto.test/company/enterprise/auth/login',
    ]);
  });

  it('首次注册先请求挑战，再提交姓名、密码和验证码并保存会话', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        challengeId: 'sms_1', expiresAt: '2099-01-01', retryAfterSeconds: 60, message: '已发送',
        organization: { id: 'org_acme', name: '星河科技' },
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'sms-session', expiresAt: '2099-01-02',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const challenge = await client.requestRegistrationCode(
      'https://enterprise.otto.test',
      '13800138000',
      'ABCD-EFGH',
    );
    expect(challenge.challengeId).toBe('sms_1');
    expect(challenge.organization).toEqual({ id: 'org_acme', name: '星河科技' });
    const loggedIn = await client.registerWithSms({
      challengeId: 'sms_1', code: '042731', name: '员工一号', password: 'registered-password',
    });
    expect(loggedIn.account.id).toBe(ACCOUNT.id);
    expect(client.snapshot().token).toBe('sms-session');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['https://enterprise.otto.test/enterprise/health', 'GET'],
      ['https://enterprise.otto.test/enterprise/auth/register/sms/request', 'POST'],
      ['https://enterprise.otto.test/enterprise/auth/register/sms/verify', 'POST'],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      phone: '13800138000', inviteCode: 'ABCD-EFGH',
    });
    expect(JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({
      challengeId: 'sms_1', code: '042731', name: '员工一号', password: 'registered-password',
    });
  });

  it('登录后按消息幂等键上报 provider 返回的 Token 用量', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(201, { recorded: true, source: 'client_reported' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.recordTokenUsage({
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'deepseek-v4-pro',
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    })).resolves.toEqual({ recorded: true, source: 'client_reported' });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/usage');
    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      model: 'deepseek-v4-pro',
      inputTokens: 12,
      outputTokens: 34,
      totalTokens: 46,
    });
  });

  it('未登录时不发送 Token 用量', async () => {
    const fetchMock = vi.fn();
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.recordTokenUsage({
      sessionId: 'session-1', messageId: 'message-1',
      inputTokens: 1, outputTokens: 2, totalTokens: 3,
    })).rejects.toThrow('登录已失效');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('登录后把自动提炼的知识条目写入组织知识库', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { status: 'added', added: true }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.recordKnowledge({
      sourceId: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
    })).resolves.toEqual({ status: 'added', added: true });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/knowledge');
    const init = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      sourceId: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
    });
  });

  it('登录成员通过 main 内的会话令牌读取完整组织架构', async () => {
    const organizationView = {
      organization: {
        id: 'org_acme',
        name: '星河科技',
        status: 'active' as const,
        createdAt: '2026-07-13T00:00:00.000Z',
      },
      members: [{
        id: 'acc_1',
        username: 'staff01',
        name: '员工一号',
        role: '工程师',
        department: '研发部',
        isAdmin: false,
        status: 'active' as const,
      }],
      employeeCount: 1,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, organizationView));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(client.getOrganizationView()).resolves.toEqual(organizationView);
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('https://enterprise.otto.test/enterprise/organization/view');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('未登录时不会请求组织架构接口', async () => {
    const fetchMock = vi.fn();
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.getOrganizationView()).rejects.toThrow('登录已失效');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('企业管理员可读取并手动换新 7 天中心引入链接', async () => {
    const firstInvite = {
      id: 'invite_1', organizationId: 'org_acme', code: 'ABCD-EFGH',
      link: 'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH', status: 'active' as const,
      defaultDepartment: null,
      departmentId: null, positionId: null, positionTitle: null, defaultRole: null,
      maxUses: null, usedCount: 0,
      issuedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2026-07-21T00:00:00.000Z',
      validHours: 168 as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, isAdmin: true }, token: 'admin-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        organization: { id: 'org_acme', name: '星河科技' }, invite: firstInvite,
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        organization: { id: 'org_acme', name: '星河科技' },
        invite: {
          ...firstInvite,
          id: 'invite_2',
          code: 'WXYZ-2345',
          link: 'https://59.110.154.44:7777/enterprise/join/WXYZ-2345',
        },
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    expect((await client.getOrganizationInvite()).invite?.link)
      .toBe('https://59.110.154.44:7777/enterprise/join/ABCD-EFGH');
    expect((await client.issueOrganizationInvite()).invite.code).toBe('WXYZ-2345');
    expect(fetchMock.mock.calls.slice(2).map(([, init]) => (init as RequestInit).method)).toEqual([
      'GET', 'POST',
    ]);
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).body)
      .toBe(JSON.stringify({
        defaultDepartment: null,
        departmentId: null,
        positionId: null,
        positionTitle: null,
        defaultRole: null,
        maxUses: null,
      }));
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer admin-token',
    });
  });

  it('拒绝带账号密码、查询参数或非 http(s) 协议的服务器地址', async () => {
    const client = new EnterpriseClient(vi.fn() as typeof fetch);
    for (const url of [
      'file:///tmp/server',
      'http://user:pass@example.com',
      'http://example.com?token=secret',
    ]) {
      await expect(client.loginWithPassword(url, 'a', 'b')).rejects.toThrow('服务器地址');
    }
  });

  it('公网企业服务器强制 HTTPS，但允许 localhost 供隔离开发测试', async () => {
    const client = new EnterpriseClient(vi.fn() as typeof fetch);
    await expect(client.loginWithPassword('http://59.110.154.44:7777', 'a', 'b'))
      .rejects.toThrow('公网企业服务器必须使用 HTTPS');
    await expect(client.loginWithPassword('http://example.com', 'a', 'b'))
      .rejects.toThrow('公网企业服务器必须使用 HTTPS');

    client.restore({ serverUrl: 'http://127.0.0.1:7777', token: null });
    expect(client.snapshot().serverUrl).toBe('http://127.0.0.1:7777');
    client.restore({ serverUrl: 'http://localhost:7777', token: null });
    expect(client.snapshot().serverUrl).toBe('http://localhost:7777');
  });

  it('服务端 401 时清除已恢复的失效会话', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(401, { error: '登录已失效' }));
    const client = new EnterpriseClient(
      fetchMock as typeof fetch,
    );
    client.restore({ serverUrl: 'https://otto.example.com', token: 'expired-token' });
    const session = await client.getSession();
    expect(session.account).toBeNull();
    expect(client.snapshot().token).toBeNull();
  });

  it('恢复会话遇到断网时保留服务器地址和 token，返回可重试的连接错误', async () => {
    const client = new EnterpriseClient(
      vi.fn().mockRejectedValue(new Error('socket disconnected')) as typeof fetch,
    );
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: 'restored-token' });

    await expect(client.getSession()).resolves.toEqual({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: '无法连接企业服务器：socket disconnected',
    });
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: 'restored-token',
    });
  });

  it('任一受保护 API 返回 401 都清除 token 并通知全局会话失效', async () => {
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: { ...ACCOUNT, isAdmin: true },
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(401, { error: '登录已失效，请重新登录' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.listAccounts()).rejects.toThrow('登录已失效，请重新登录');

    expect(client.snapshot().token).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('管理员修改自己的密码后，即使 PATCH 成功也立即退出已被服务端撤销的会话', async () => {
    const admin = { ...ACCOUNT, id: 'acc_admin', isAdmin: true };
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: admin,
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: admin }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.updateAccount(admin.id, { password: 'new-password' }))
      .resolves.toMatchObject({ id: admin.id });

    expect(client.snapshot().token).toBeNull();
    expect(client.authenticatedAccountSnapshot()).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('管理员自降权后不把 isAdmin=false 的更新响应当作仍有效会话', async () => {
    const admin = { ...ACCOUNT, id: 'acc_admin', isAdmin: true };
    const downgraded = { ...admin, isAdmin: false, role: 'member' };
    const onSessionInvalidated = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: admin,
        token: 'admin-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: downgraded }));
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    await client.loginWithPassword('https://enterprise.otto.test', 'admin', 'password');

    await expect(client.updateAccount(admin.id, { isAdmin: false }))
      .resolves.toEqual(downgraded);

    expect(client.snapshot().token).toBeNull();
    expect(client.authenticatedAccountSnapshot()).toBeNull();
    expect(onSessionInvalidated).toHaveBeenCalledOnce();
  });

  it('只读账号快照仅反映中心服务已验证的当前账号，且调用方不能篡改内部状态', async () => {
    const updated = { ...ACCOUNT, name: '新姓名', role: 'engineer', tags: ['updated'] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'member-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { account: updated }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    const first = client.authenticatedAccountSnapshot();
    expect(first).toEqual(ACCOUNT);
    first!.tags.push('renderer-forged');
    expect(client.authenticatedAccountSnapshot()?.tags).toEqual(['普通员工']);

    await client.updateAccount(ACCOUNT.id, { name: '新姓名', role: 'engineer' });
    expect(client.authenticatedAccountSnapshot()).toEqual(updated);
  });

  it.each([
    [{ status: 'degraded', apiVersion: 2, capabilities: API_V2_HEALTH.capabilities }],
    [{ status: 'ok', apiVersion: 1, capabilities: API_V2_HEALTH.capabilities }],
    [{ status: 'ok' }],
  ])('密码登录拒绝不兼容的旧服务器，且不会发送凭据或留下会话：%j', async (health) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, health));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await expect(client.loginWithPassword(
      'https://enterprise.otto.test',
      'staff01',
      'password',
    )).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: null,
    });
  });

  it('请求注册验证码前验证注册与邀请能力，缺失时不发送手机号和邀请码', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
      ...API_V2_HEALTH,
      capabilities: ['password_auth', 'sms_registration', 'organization_invites'],
    }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await expect(client.requestRegistrationCode(
      'https://enterprise.otto.test',
      '13800138000',
      'ABCD-EFGH',
    )).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(client.snapshot().token).toBeNull();
  });

  it('提交短信注册前也验证岗位邀请能力，缺失时不发送验证码和密码', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {
      ...API_V2_HEALTH,
      capabilities: ['password_auth', 'sms_registration', 'organization_invites'],
    }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: null });

    await expect(client.registerWithSms({
      challengeId: 'sms_1',
      code: '042731',
      name: '员工一号',
      password: 'registered-password',
    })).rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
  });

  it.each([
    {
      name: '读取私信',
      capability: 'direct_messages',
      endpoint: '/enterprise/messages/acc_peer',
      invoke: (client: EnterpriseClient) => client.listDirectMessages('acc_peer'),
    },
    {
      name: '发送私信',
      capability: 'direct_messages',
      endpoint: '/enterprise/messages/acc_peer',
      invoke: (client: EnterpriseClient) => client.sendDirectMessage('acc_peer', '你好'),
    },
    {
      name: '读取岗位邀请码',
      capability: 'position_invites',
      endpoint: '/enterprise/organization/invite',
      invoke: (client: EnterpriseClient) => client.getOrganizationInvite(),
    },
    {
      name: '签发岗位邀请码',
      capability: 'position_invites',
      endpoint: '/enterprise/organization/invite',
      invoke: (client: EnterpriseClient) => client.issueOrganizationInvite({ positionId: 'pos_brand' }),
    },
    {
      name: '推送园区服务',
      capability: 'park_service_push',
      endpoint: '/enterprise/park-services/push',
      invoke: (client: EnterpriseClient) => client.pushParkService({
        recipientAccountId: 'acc_peer',
        serviceId: 'svc_shuttle',
      }),
    },
  ])('$name 在业务请求前验证 $capability 能力', async ({ capability, endpoint, invoke }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: ['password_auth'],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT,
        token: 'session-token',
        expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ...API_V2_HEALTH,
        capabilities: API_V2_HEALTH.capabilities.filter((item) => item !== capability),
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');

    await expect(invoke(client))
      .rejects.toThrow('企业服务器版本过旧或功能不完整，请联系管理员升级后重试');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://enterprise.otto.test/enterprise/health');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(endpoint))).toBe(false);
  });

  it('恢复会话遇到旧服务器时保留服务器地址和 token，并返回明确的升级提示', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { status: 'ok' }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://enterprise.otto.test', token: 'restored-token' });

    await expect(client.getSession()).resolves.toEqual({
      serverUrl: 'https://enterprise.otto.test',
      account: null,
      connectionError: '企业服务器版本过旧或功能不完整，请联系管理员升级后重试',
    });
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://enterprise.otto.test',
      token: 'restored-token',
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization');
  });

  it('同一服务器复用成功握手，切换服务器地址后重新验证', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-a-token', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-a-token-2', expiresAt: '2099-01-01',
      }))
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'server-b-token', expiresAt: '2099-01-01',
      }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.loginWithPassword('https://a.otto.test', 'staff01', 'password');
    await client.loginWithPassword('https://a.otto.test/', 'staff01', 'password');
    await client.loginWithPassword('https://b.otto.test', 'staff01', 'password');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://a.otto.test/enterprise/health',
      'https://a.otto.test/enterprise/auth/login',
      'https://a.otto.test/enterprise/auth/login',
      'https://b.otto.test/enterprise/health',
      'https://b.otto.test/enterprise/auth/login',
    ]);
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('切换服务器时取消旧健康检查，绝不把旧登录凭据发往新服务器', async () => {
    const firstHealth = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://a.otto.test/enterprise/health') return firstHealth.promise;
      if (url === 'https://b.otto.test/enterprise/health') {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: { ...ACCOUNT, id: 'acc_b', username: 'staff-b' },
          token: 'server-b-token',
          expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const staleLogin = client.loginWithPassword('https://a.otto.test', 'staff-a', 'password-a');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b'))
      .resolves.toMatchObject({ account: { id: 'acc_b' } });

    firstHealth.resolve(jsonResponse(200, API_V2_HEALTH));
    await expect(staleLogin).rejects.toThrow('认证操作已被新的请求替代');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not
      .toContain('https://a.otto.test/enterprise/auth/login');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧登录响应晚到时不能覆盖较新的服务器 token 和账号', async () => {
    const firstLogin = deferred<Response>();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/login') return firstLogin.promise;
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const staleLogin = client.loginWithPassword('https://a.otto.test', 'staff-a', 'password-a');
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/login',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    firstLogin.resolve(jsonResponse(200, {
      account: { ...ACCOUNT, id: 'acc_a', username: 'staff-a' },
      token: 'server-a-token',
      expiresAt: '2099-01-01',
    }));
    await expect(staleLogin).rejects.toThrow('认证操作已被新的请求替代');

    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧注册响应晚到时不能覆盖更新的登录会话', async () => {
    const staleRegistration = deferred<Response>();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/register/sms/request') {
        return Promise.resolve(jsonResponse(200, {
          challengeId: 'sms_a',
          expiresAt: '2099-01-01',
          retryAfterSeconds: 60,
          message: '已发送',
          organization: { id: 'org_a', name: '企业 A' },
        }));
      }
      if (url === 'https://a.otto.test/enterprise/auth/register/sms/verify') {
        return staleRegistration.promise;
      }
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    await client.requestRegistrationCode('https://a.otto.test', '13800138000', 'ABCD-EFGH');
    const staleRegister = client.registerWithSms({
      challengeId: 'sms_a',
      code: '123456',
      name: '员工 A',
      password: 'password-a',
    });
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/register/sms/verify',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    staleRegistration.resolve(jsonResponse(200, {
      account: { ...ACCOUNT, id: 'acc_a', username: 'staff-a' },
      token: 'server-a-token',
      expiresAt: '2099-01-01',
    }));
    await expect(staleRegister).rejects.toThrow('认证操作已被新的请求替代');
    expect(client.snapshot()).toEqual({
      serverUrl: 'https://b.otto.test',
      token: 'server-b-token',
    });
  });

  it('旧恢复请求返回 401 时不能清除后来登录的新会话', async () => {
    const staleSession = deferred<Response>();
    const onSessionInvalidated = vi.fn();
    const accountB = { ...ACCOUNT, id: 'acc_b', username: 'staff-b' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/enterprise/health')) {
        return Promise.resolve(jsonResponse(200, API_V2_HEALTH));
      }
      if (url === 'https://a.otto.test/enterprise/auth/me') return staleSession.promise;
      if (url === 'https://b.otto.test/enterprise/auth/login') {
        return Promise.resolve(jsonResponse(200, {
          account: accountB, token: 'server-b-token', expiresAt: '2099-01-01',
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const client = new EnterpriseClient(fetchMock as typeof fetch, onSessionInvalidated);
    client.restore({ serverUrl: 'https://a.otto.test', token: 'restored-a-token' });

    const restoring = client.getSession();
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(
      ([url]) => String(url) === 'https://a.otto.test/enterprise/auth/me',
    )).toBe(true));
    await client.loginWithPassword('https://b.otto.test', 'staff-b', 'password-b');

    staleSession.resolve(jsonResponse(401, { error: '旧 token 已失效' }));
    await expect(restoring).resolves.toMatchObject({
      serverUrl: 'https://b.otto.test',
      account: accountB,
    });
    expect(client.snapshot().token).toBe('server-b-token');
    expect(onSessionInvalidated).not.toHaveBeenCalled();
  });

  it('远端退出断网时仍持久化已经清空的本地 token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, API_V2_HEALTH))
      .mockResolvedValueOnce(jsonResponse(200, {
        account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01',
      }))
      .mockRejectedValueOnce(new Error('network offline'));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    await client.loginWithPassword('https://enterprise.otto.test', 'staff01', 'password');
    const persistedSnapshots: Array<ReturnType<typeof client.snapshot>> = [];

    await expect(logoutAndPersistEnterpriseSession(
      client,
      () => persistedSnapshots.push(client.snapshot()),
    )).rejects.toThrow('network offline');

    expect(persistedSnapshots).toEqual([{
      serverUrl: 'https://enterprise.otto.test',
      token: null,
    }]);
  });
});
