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

export interface EnterpriseKnowledgeRecordInput {
  sourceId: string;
  category: string;
  content: string;
  confidence: number;
}

export interface EnterpriseOrganizationInvite {
  id: string;
  organizationId: string;
  code: string;
  link: string;
  status: 'active' | 'expired' | 'revoked';
  issuedAt: string;
  expiresAt: string;
  validHours: 168;
}

export interface EnterpriseOrganizationInviteContext {
  organization: { id: string; name: string };
  invite: EnterpriseOrganizationInvite | null;
}

export interface EnterpriseOrganizationView {
  organization: {
    id: string;
    name: string;
    status: 'active' | 'disabled';
    createdAt: string;
  } | null;
  members: Array<{
    id: string;
    username: string;
    name: string;
    role: string | null;
    department: string | null;
    isAdmin: boolean;
    status: 'active' | 'disabled';
  }>;
  employeeCount: number;
}

export interface EnterpriseSessionResult {
  serverUrl: string;
  account: EnterpriseAccount | null;
  /** 恢复 token 时服务暂不可达；保留地址/token，让同页重试而不是锁死登录。 */
  connectionError?: string;
}

interface EnterpriseServerHealth {
  status?: unknown;
  apiVersion?: unknown;
  capabilities?: unknown;
}

interface EnterpriseRequestBehavior {
  omitAuthorization?: boolean;
  preserveSessionOnUnauthorized?: boolean;
  serverUrl?: string;
  authorizationToken?: string | null;
}

const ENTERPRISE_SERVER_UPGRADE_ERROR = '企业服务器版本过旧或功能不完整，请联系管理员升级后重试';
const ENTERPRISE_AUTH_SUPERSEDED_ERROR = '认证操作已被新的请求替代，请重试';

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
  const pathPrefix = url.pathname === '/'
    ? ''
    : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathPrefix}`;
}

export class EnterpriseClient {
  private serverUrl = '';
  private token: string | null = null;
  private currentAccount: EnterpriseAccount | null = null;
  private compatibleServerUrl = '';
  private compatibleCapabilities = new Set<string>();
  private authOperationGeneration = 0;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly onSessionInvalidated: () => void = () => undefined,
  ) {}

  restore(session: StoredSession): void {
    this.authOperationGeneration += 1;
    this.setServerUrl(session.serverUrl ? normalizeServerUrl(session.serverUrl) : '');
    this.token = session.token;
    this.currentAccount = null;
  }

  snapshot(): StoredSession {
    return { serverUrl: this.serverUrl, token: this.token };
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    behavior: EnterpriseRequestBehavior = {},
  ): Promise<T> {
    const requestServerUrl = behavior.serverUrl ?? this.serverUrl;
    const hasExplicitAuthorization = Object.prototype.hasOwnProperty.call(
      behavior,
      'authorizationToken',
    );
    const requestToken = hasExplicitAuthorization
      ? behavior.authorizationToken ?? null
      : this.token;
    if (!requestServerUrl) throw new Error('请先填写企业服务器地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(requestToken && !behavior.omitAuthorization
          ? { authorization: `Bearer ${requestToken}` }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      };
      const response = await this.fetchImpl(`${requestServerUrl}${path}`, {
        ...init,
        method: init.method ?? 'GET',
        headers,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) {
        if (
          response.status === 401
          && !behavior.preserveSessionOnUnauthorized
          && requestServerUrl === this.serverUrl
          && requestToken !== null
          && requestToken === this.token
        ) {
          this.invalidateSession();
        }
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
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['password_auth']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>('/enterprise/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestRegistrationCode(
    serverUrl: string,
    phone: string,
    inviteCode: string,
  ): Promise<SmsChallenge> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(
      targetServerUrl,
      ['sms_registration', 'organization_invites'],
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const challenge = await this.request<SmsChallenge>('/enterprise/auth/register/sms/request', {
      method: 'POST',
      body: JSON.stringify({ phone, inviteCode }),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    return challenge;
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
    const targetServerUrl = this.serverUrl;
    if (!targetServerUrl) throw new Error('请先填写企业服务器地址');
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(
      targetServerUrl,
      ['sms_registration', 'organization_invites'],
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>('/enterprise/auth/register/sms/verify', {
      method: 'POST',
      body: JSON.stringify(input),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async getSession(): Promise<EnterpriseSessionResult> {
    if (!this.serverUrl || !this.token) return { serverUrl: this.serverUrl, account: null };
    const targetServerUrl = this.serverUrl;
    const targetToken = this.token;
    const generation = this.authOperationGeneration;
    try {
      await this.assertCompatibleServer(targetServerUrl, ['password_auth']);
      if (!this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)) {
        return this.currentSessionResult();
      }
      const result = await this.request<{ account: EnterpriseAccount }>('/enterprise/auth/me', {}, {
        serverUrl: targetServerUrl,
        authorizationToken: targetToken,
        preserveSessionOnUnauthorized: true,
      });
      if (!this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)) {
        return this.currentSessionResult();
      }
      this.currentAccount = result.account;
      return { serverUrl: targetServerUrl, account: result.account };
    } catch (error) {
      if (!this.isSessionSnapshotCurrent(generation, targetServerUrl, targetToken)) {
        return this.currentSessionResult();
      }
      if (error instanceof EnterpriseRequestError && error.status === 401) {
        this.invalidateSession();
        return { serverUrl: targetServerUrl, account: null };
      }
      const connectionError = error instanceof Error ? error.message : String(error);
      return { serverUrl: targetServerUrl, account: null, connectionError };
    }
  }

  async logout(): Promise<void> {
    const targetServerUrl = this.serverUrl;
    const targetToken = this.token;
    this.authOperationGeneration += 1;
    this.token = null;
    this.currentAccount = null;
    if (!targetServerUrl || !targetToken) return;
    await this.request('/enterprise/auth/logout', { method: 'POST' }, {
      serverUrl: targetServerUrl,
      authorizationToken: targetToken,
      preserveSessionOnUnauthorized: true,
    });
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
    const previous = this.currentAccount;
    const requestGeneration = this.authOperationGeneration;
    const requestToken = this.token;
    const account = (await this.request<{ account: EnterpriseAccount }>(
      `/enterprise/accounts/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    )).account;
    if (
      previous?.id === id
      && requestGeneration === this.authOperationGeneration
      && requestToken === this.token
    ) {
      const sessionWasRevoked = input.password !== undefined
        || (input.status !== undefined && input.status !== previous.status)
        || (input.isAdmin !== undefined && input.isAdmin !== previous.isAdmin);
      if (sessionWasRevoked) this.invalidateSession();
      else this.currentAccount = account;
    }
    return account;
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

  async recordKnowledge(input: EnterpriseKnowledgeRecordInput): Promise<{
    status: 'added' | 'exists';
    added: boolean;
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/knowledge', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getOrganizationView(): Promise<EnterpriseOrganizationView> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/organization/view');
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

  private setServerUrl(serverUrl: string): void {
    if (serverUrl !== this.serverUrl) {
      this.compatibleServerUrl = '';
      this.compatibleCapabilities.clear();
    }
    this.serverUrl = serverUrl;
  }

  private beginAuthOperation(serverUrl: string): number {
    this.authOperationGeneration += 1;
    this.setServerUrl(serverUrl);
    this.token = null;
    this.currentAccount = null;
    return this.authOperationGeneration;
  }

  private assertAuthOperationCurrent(generation: number, serverUrl: string): void {
    if (generation !== this.authOperationGeneration || serverUrl !== this.serverUrl) {
      throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
    }
  }

  private isSessionSnapshotCurrent(
    generation: number,
    serverUrl: string,
    token: string,
  ): boolean {
    return generation === this.authOperationGeneration
      && serverUrl === this.serverUrl
      && token === this.token;
  }

  private currentSessionResult(): EnterpriseSessionResult {
    return {
      serverUrl: this.serverUrl,
      account: this.token ? this.currentAccount : null,
    };
  }

  private async assertCompatibleServer(
    serverUrl: string,
    requiredCapabilities: readonly string[],
  ): Promise<void> {
    if (
      this.compatibleServerUrl === serverUrl
      && requiredCapabilities.every((capability) => this.compatibleCapabilities.has(capability))
    ) {
      return;
    }

    const health = await this.request<EnterpriseServerHealth>(
      '/enterprise/health',
      {},
      {
        omitAuthorization: true,
        preserveSessionOnUnauthorized: true,
        serverUrl,
        authorizationToken: null,
      },
    );
    const capabilities = Array.isArray(health.capabilities)
      && health.capabilities.every((capability) => typeof capability === 'string')
      ? new Set(health.capabilities)
      : null;
    const isCompatible = health.status === 'ok'
      && typeof health.apiVersion === 'number'
      && health.apiVersion >= 2
      && capabilities !== null
      && requiredCapabilities.every((capability) => capabilities.has(capability));
    if (!isCompatible) throw new Error(ENTERPRISE_SERVER_UPGRADE_ERROR);

    if (serverUrl === this.serverUrl) {
      this.compatibleServerUrl = serverUrl;
      this.compatibleCapabilities = capabilities;
    }
  }

  private invalidateSession(): void {
    const hadToken = Boolean(this.token);
    this.authOperationGeneration += 1;
    this.token = null;
    this.currentAccount = null;
    if (hadToken) this.onSessionInvalidated();
  }
}

export async function logoutAndPersistEnterpriseSession(
  client: Pick<EnterpriseClient, 'logout'>,
  persistSession: () => void,
): Promise<void> {
  try {
    await client.logout();
  } finally {
    persistSession();
  }
}
