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
  id: 'acc_1', organizationId: 'org_acme', organizationName: '星河科技',
  employeeId: null, username: 'staff01', phone: '+8613800138000', name: '员工一号',
  role: null, department: null, isAdmin: false, status: 'active' as const,
  tags: ['普通员工'], createdAt: '2026-07-13', updatedAt: '2026-07-13',
};

describe('EnterpriseClient', () => {
  it('密码登录规范化服务器地址并保存会话，后续请求自动携带 Bearer token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT, token: 'session-token', expiresAt: '2099-01-01' }))
      .mockResolvedValueOnce(jsonResponse(200, { account: ACCOUNT }));
    const client = new EnterpriseClient(fetchMock as typeof fetch);

    const loggedIn = await client.loginWithPassword('https://59-110-154-44.sslip.io/', 'staff01', 'password');
    expect(loggedIn.account.username).toBe('staff01');
    expect(client.snapshot()).toEqual({ serverUrl: 'https://59-110-154-44.sslip.io', token: 'session-token' });

    await client.getSession();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://59-110-154-44.sslip.io/enterprise/auth/me');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer session-token',
    });
  });

  it('首次注册先请求挑战，再提交姓名、密码和验证码并保存会话', async () => {
    const fetchMock = vi.fn()
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
      ['https://enterprise.otto.test/enterprise/auth/register/sms/request', 'POST'],
      ['https://enterprise.otto.test/enterprise/auth/register/sms/verify', 'POST'],
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      phone: '13800138000', inviteCode: 'ABCD-EFGH',
    });
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      challengeId: 'sms_1', code: '042731', name: '员工一号', password: 'registered-password',
    });
  });

  it('登录后按消息幂等键上报 provider 返回的 Token 用量', async () => {
    const fetchMock = vi.fn()
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

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://enterprise.otto.test/enterprise/usage');
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
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

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://enterprise.otto.test/enterprise/knowledge');
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(JSON.parse(init.body as string)).toEqual({
      sourceId: 'kb_123',
      category: 'solution',
      content: '合同审查先核对违约条款。',
      confidence: 0.9,
    });
  });

  it('企业管理员可读取并手动换新 7 天中心引入链接', async () => {
    const firstInvite = {
      id: 'invite_1', organizationId: 'org_acme', code: 'ABCD-EFGH',
      link: 'https://59.110.154.44:7777/enterprise/join/ABCD-EFGH', status: 'active' as const,
      issuedAt: '2026-07-14T00:00:00.000Z', expiresAt: '2026-07-21T00:00:00.000Z',
      validHours: 168 as const,
    };
    const fetchMock = vi.fn()
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
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => (init as RequestInit).method)).toEqual([
      'GET', 'POST',
    ]);
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).toMatchObject({
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
    const client = new EnterpriseClient(
      vi.fn().mockResolvedValue(jsonResponse(401, { error: '登录已失效' })) as typeof fetch,
    );
    client.restore({ serverUrl: 'https://otto.example.com', token: 'expired-token' });
    const session = await client.getSession();
    expect(session.account).toBeNull();
    expect(client.snapshot().token).toBeNull();
  });
});
