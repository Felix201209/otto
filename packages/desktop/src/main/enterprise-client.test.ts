/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EnterpriseClient } from './enterprise-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCOUNT = {
  id: 'acc_1', employeeId: null, username: 'staff01', name: '员工一号',
  role: null, department: null, isAdmin: false, status: 'active' as const,
  tags: ['普通员工'], createdAt: '2026-07-12', updatedAt: '2026-07-12',
};

describe('EnterpriseClient', () => {
  it('登录时规范化服务器地址并保存会话，后续请求自动携带 Bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01' }))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const loggedIn = await client.login('http://59.110.154.44:7777/', 'staff01', 'password');
    expect(loggedIn.account.username).toBe('staff01');
    expect(client.snapshot()).toEqual({ serverUrl: 'http://59.110.154.44:7777', token: 'session-token' });

    await client.getSession();
    expect(fetchMock.mock.calls[1][0]).toBe('http://59.110.154.44:7777/enterprise/auth/me');
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('拒绝带账号密码、查询参数或非 http(s) 协议的服务器地址', async () => {
    const client = new EnterpriseClient(vi.fn() as typeof fetch);
    for (const url of [
      'file:///tmp/server',
      'http://user:pass@example.com',
      'http://example.com?token=secret',
    ]) {
      await expect(client.login(url, 'a', 'b')).rejects.toThrow('服务器地址');
    }
  });

  it('服务端 401 时清除已恢复的失效会话', async () => {
    const client = new EnterpriseClient(
      vi.fn().mockResolvedValue(jsonResponse(401, { error: '登录已失效' })) as typeof fetch,
    );
    client.restore({ serverUrl: 'https://otto.example.com', token: 'expired-token' });
    const session = await client.getSession();
    expect(session.account).toBeNull();
    expect(client.snapshot().token).toBeNull();
  });

  it('管理员账号 CRUD 请求使用正确方法与路径', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { accounts: [ACCOUNT] }))
      .mockResolvedValueOnce(jsonResponse(201, { account: ACCOUNT }))
      .mockResolvedValueOnce(jsonResponse(200, { account: { ...ACCOUNT, name: '新名字' } }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);
    client.restore({ serverUrl: 'https://otto.example.com', token: 'admin-token' });

    await client.listAccounts();
    await client.createAccount({ username: 'new', password: 'password', name: '新人', tags: ['IT'] });
    await client.updateAccount('acc_1', { name: '新名字' });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ['https://otto.example.com/enterprise/accounts', 'GET'],
      ['https://otto.example.com/enterprise/accounts', 'POST'],
      ['https://otto.example.com/enterprise/accounts/acc_1', 'PATCH'],
    ]);
  });
});
