/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业账号 API 客户端。只运行在 Electron main 进程：renderer 不直接请求
 * 企业服务器，也永远拿不到会话令牌。
 */

export interface EnterpriseAccount {
  id: string;
  organizationId: string;
  organizationName: string;
  employeeId: string | null;
  username: string;
  phone: string | null;
  name: string;
  role: string | null;
  department: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
  usage?: EnterpriseAccountUsage;
}

export interface EnterpriseAccountUsage {
  accountId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface AccountCreateInput {
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  role?: string | null;
  department?: string | null;
  tags?: string[];
  isAdmin?: boolean;
}

export interface AccountUpdateInput {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  role?: string | null;
  department?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}

interface StoredSession {
  serverUrl: string;
  token: string | null;
}

export interface SmsChallenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
  organization: { id: string; name: string };
}

export interface TokenUsageRecordInput {
  sessionId: string;
  messageId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EnterpriseOrganizationInvite {
  id: string;
  organizationId: string;
  code: string;
  link: string;
  status: 'active' | 'expired' | 'revoked';
  issuedAt: string;
  expiresAt: string;
  validHours: 5;
}

export interface EnterpriseOrganizationInviteContext {
  organization: { id: string; name: string };
  invite: EnterpriseOrganizationInvite | null;
}

class EnterpriseRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('服务器地址格式不正确');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('服务器地址必须使用 http(s)，且不能包含账号密码');
  }
  if (url.search || url.hash) throw new Error('服务器地址不能包含查询参数或片段');
  const isLocalDevelopment = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !isLocalDevelopment) {
    throw new Error('公网企业服务器必须使用 HTTPS');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/') throw new Error('服务器地址只填写主机和端口');
  return url.origin;
}

export class EnterpriseClient {
  private serverUrl = '';
  private token: string | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  restore(session: StoredSession): void {
    this.serverUrl = session.serverUrl ? normalizeServerUrl(session.serverUrl) : '';
    this.token = session.token;
  }

  snapshot(): StoredSession {
    return { serverUrl: this.serverUrl, token: this.token };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.serverUrl) throw new Error('请先填写企业服务器地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      };
      const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
        ...init,
        method: init.method ?? 'GET',
        headers,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) {
        throw new EnterpriseRequestError(body.error || `服务器返回 ${response.status}`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof EnterpriseRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new Error('连接企业服务器超时');
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`无法连接企业服务器：${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async loginWithPassword(serverUrl: string, identifier: string, password: string): Promise<{
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = null;
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>('/enterprise/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    this.token = result.token;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestRegistrationCode(
    serverUrl: string,
    phone: string,
    inviteCode: string,
  ): Promise<SmsChallenge> {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.token = null;
    return this.request<SmsChallenge>('/enterprise/auth/register/sms/request', {
      method: 'POST',
      body: JSON.stringify({ phone, inviteCode }),
    });
  }

  async registerWithSms(input: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
  }): Promise<{
    account: EnterpriseAccount;
    expiresAt: string;
  }> {
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>('/enterprise/auth/register/sms/verify', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.token = result.token;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async getSession(): Promise<{ serverUrl: string; account: EnterpriseAccount | null }> {
    if (!this.serverUrl || !this.token) return { serverUrl: this.serverUrl, account: null };
    try {
      const result = await this.request<{ account: EnterpriseAccount }>('/enterprise/auth/me');
      return { serverUrl: this.serverUrl, account: result.account };
    } catch (error) {
      if (error instanceof EnterpriseRequestError && error.status === 401) {
        this.token = null;
        return { serverUrl: this.serverUrl, account: null };
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.request('/enterprise/auth/logout', { method: 'POST' });
    } finally {
      this.token = null;
    }
  }

  async listAccounts(): Promise<EnterpriseAccount[]> {
    return (await this.request<{ accounts: EnterpriseAccount[] }>('/enterprise/accounts')).accounts;
  }

  async createAccount(input: AccountCreateInput): Promise<EnterpriseAccount> {
    return (await this.request<{ account: EnterpriseAccount }>('/enterprise/accounts', {
      method: 'POST', body: JSON.stringify(input),
    })).account;
  }

  async updateAccount(id: string, input: AccountUpdateInput): Promise<EnterpriseAccount> {
    return (await this.request<{ account: EnterpriseAccount }>(
      `/enterprise/accounts/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )).account;
  }

  async recordTokenUsage(input: TokenUsageRecordInput): Promise<{
    recorded: boolean;
    source: 'client_reported';
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/usage', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getOrganizationInvite(): Promise<EnterpriseOrganizationInviteContext> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/organization/invite');
  }

  async issueOrganizationInvite(): Promise<EnterpriseOrganizationInviteContext & {
    invite: EnterpriseOrganizationInvite;
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/organization/invite', { method: 'POST' });
  }

  async ticketInbox(): Promise<unknown[]> {
    return (await this.request<{ tickets: unknown[] }>('/enterprise/tickets/inbox')).tickets;
  }

  async submitTicket(input: { title: string; description: string; targetTags?: string[] }): Promise<unknown> {
    return (await this.request<{ ticket: unknown }>('/enterprise/tickets', {
      method: 'POST', body: JSON.stringify(input),
    })).ticket;
  }
}
