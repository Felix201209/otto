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
  accountType?: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  phone: string | null;
  feishuOpenId?: string | null;
  name: string;
  role: string | null;
  department: string | null;
  departmentId?: string | null;
  positionId: string | null;
  positionTitle: string | null;
  avatarUrl?: string | null;
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
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
}

export interface AccountUpdateInput {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
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
  registrationMode?: 'personal' | 'enterprise';
  organization: { id: string; name: string } | null;
}

export interface SmsLoginChallenge {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  message: string;
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

export interface EnterpriseKnowledgeItem {
  id: string;
  organizationId: string;
  sourceId: string | null;
  department: string | null;
  category: string;
  content: string;
  contributor: string | null;
  confidence: number;
  createdAt: string;
}

interface EnterpriseKnowledgeRow {
  id: string;
  organization_id?: string;
  organizationId?: string;
  source_id?: string | null;
  sourceId?: string | null;
  department?: string | null;
  category: string;
  content: string;
  contributor?: string | null;
  confidence?: number;
  created_at?: string;
  createdAt?: string;
}

export interface EnterpriseOrganizationInvite {
  id: string;
  organizationId: string;
  code: string;
  link: string;
  status: 'active' | 'expired' | 'revoked';
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
  maxUses: number | null;
  usedCount: number;
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
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    avatarUrl?: string | null;
    isAdmin: boolean;
    status: 'active' | 'disabled';
  }>;
  employeeCount: number;
}

export interface EnterpriseDirectMessage {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface EnterpriseAtoaInboxMessage extends EnterpriseDirectMessage {
  peerAccountId: string;
  /** 由企业服务端按 peerAccountId 查询并回传，不能来自消息正文。 */
  peer: {
    id: string;
    username: string;
    name: string;
    department: string | null;
    positionTitle: string | null;
    role: string | null;
  };
}

export interface EnterpriseRepairTicket {
  id: string;
  title: string;
  description: string;
  targetTags: string[];
  status: string;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contactPhone: string | null;
  responseType: string | null;
  responseText: string | null;
  responseAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: Pick<EnterpriseAccount, 'id' | 'name' | 'username' | 'phone' | 'feishuOpenId'>;
  recipientCount: number;
  recipients: EnterpriseAccount[];
  deliveryStatus?: string;
  readAt?: string | null;
  isCreator?: boolean;
  isRecipient?: boolean;
  notifications: Array<{
    channel: 'otto' | 'sms' | 'feishu';
    event: string;
    status: 'sent' | 'failed' | 'skipped';
    detail: string | null;
    createdAt: string;
  }>;
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

/**
 * 加入企业是不可重复提交。POST 的响应丢失且 `/auth/me` 也不可用时，调用方
 * 无法安全判断账号仍为个人还是已经入企，必须清掉本地会话并要求重新登录。
 */
export class EnterpriseJoinStateUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnterpriseJoinStateUncertainError';
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
  private pendingRegistrationMode: 'personal' | 'enterprise' | null = null;

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

  /**
   * 仅供 Electron main 将中心服务已验证的当前账号同步给本机控制面。
   * 返回深拷贝，调用方无法通过引用修改客户端内部认证状态。
   */
  authenticatedAccountSnapshot(): EnterpriseAccount | null {
    return this.currentAccount
      ? JSON.parse(JSON.stringify(this.currentAccount)) as EnterpriseAccount
      : null;
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
    this.pendingRegistrationMode = null;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestLoginCode(serverUrl: string, phone: string): Promise<SmsLoginChallenge> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['sms_login']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const challenge = await this.request<SmsLoginChallenge>('/enterprise/auth/sms/request', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    return challenge;
  }

  async loginWithSms(input: {
    challengeId: string;
    code: string;
  }): Promise<{ account: EnterpriseAccount; expiresAt: string }> {
    const targetServerUrl = this.serverUrl;
    if (!targetServerUrl) throw new Error('请先填写企业服务器地址');
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(targetServerUrl, ['sms_login']);
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const result = await this.request<{
      account: EnterpriseAccount;
      token: string;
      expiresAt: string;
    }>('/enterprise/auth/sms/verify', {
      method: 'POST',
      body: JSON.stringify(input),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.token = result.token;
    this.currentAccount = result.account;
    this.pendingRegistrationMode = null;
    return { account: result.account, expiresAt: result.expiresAt };
  }

  async requestRegistrationCode(
    serverUrl: string,
    phone: string,
    inviteCode = '',
  ): Promise<SmsChallenge> {
    const targetServerUrl = normalizeServerUrl(serverUrl);
    const generation = this.beginAuthOperation(targetServerUrl);
    await this.assertCompatibleServer(
      targetServerUrl,
      inviteCode.trim()
        ? ['sms_registration', 'organization_invites', 'position_invites']
        : ['sms_registration', 'personal_registration'],
    );
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    const challenge = await this.request<SmsChallenge>('/enterprise/auth/register/sms/request', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        ...(inviteCode.trim() ? { inviteCode } : {}),
      }),
    }, {
      serverUrl: targetServerUrl,
      authorizationToken: null,
    });
    this.assertAuthOperationCurrent(generation, targetServerUrl);
    this.pendingRegistrationMode = challenge.registrationMode
      ?? (inviteCode.trim() ? 'enterprise' : 'personal');
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
      this.pendingRegistrationMode === 'enterprise'
        ? ['sms_registration', 'organization_invites', 'position_invites']
        : ['sms_registration', 'personal_registration'],
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
    this.pendingRegistrationMode = null;
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

  async joinOrganization(inviteCode: string): Promise<{ account: EnterpriseAccount }> {
    if (!this.token || !this.currentAccount) throw new Error('登录已失效，请重新登录');
    if (this.currentAccount.accountType !== 'personal') {
      throw new Error('当前账号已经属于企业');
    }
    const normalizedInviteCode = inviteCode.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(normalizedInviteCode)) {
      throw new Error('请输入有效的 8 位企业邀请码');
    }
    const requestGeneration = this.authOperationGeneration;
    const requestToken = this.token;
    const requestServerUrl = this.serverUrl;
    const personalAccountId = this.currentAccount.id;
    await this.assertCompatibleServer(this.serverUrl, ['personal_enterprise_upgrade']);
    let joinError: unknown;
    try {
      const result = await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/auth/join-organization',
        {
          method: 'POST',
          body: JSON.stringify({ inviteCode: normalizedInviteCode }),
        },
        {
          serverUrl: requestServerUrl,
          authorizationToken: requestToken,
          preserveSessionOnUnauthorized: true,
        },
      );
      if (!this.isSessionSnapshotCurrent(
        requestGeneration,
        requestServerUrl,
        requestToken,
      )) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      if (
        result?.account?.id === personalAccountId
        && result.account.accountType === 'enterprise'
      ) {
        this.currentAccount = result.account;
        return result;
      }
      joinError = new EnterpriseJoinStateUncertainError(
        '企业服务器返回的升级身份不完整',
      );
    } catch (error) {
      if (!this.isSessionSnapshotCurrent(
        requestGeneration,
        requestServerUrl,
        requestToken,
      )) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      joinError = error;
    }

    let reconciliation: { account: EnterpriseAccount };
    try {
      reconciliation = await this.request<{ account: EnterpriseAccount }>(
        '/enterprise/auth/me',
        {},
        {
          serverUrl: requestServerUrl,
          authorizationToken: requestToken,
          preserveSessionOnUnauthorized: true,
        },
      );
    } catch (error) {
      if (!this.isSessionSnapshotCurrent(
        requestGeneration,
        requestServerUrl,
        requestToken,
      )) {
        throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
      }
      const joinMessage = joinError instanceof Error ? joinError.message : String(joinError);
      const reconciliationMessage = error instanceof Error ? error.message : String(error);
      throw new EnterpriseJoinStateUncertainError(
        `无法确认企业升级结果：${joinMessage}；身份对账失败：${reconciliationMessage}`,
      );
    }
    if (!this.isSessionSnapshotCurrent(
      requestGeneration,
      requestServerUrl,
      requestToken,
    )) {
      throw new Error(ENTERPRISE_AUTH_SUPERSEDED_ERROR);
    }
    if (
      reconciliation.account?.id === personalAccountId
      && reconciliation.account.accountType === 'enterprise'
    ) {
      this.currentAccount = reconciliation.account;
      return { account: reconciliation.account };
    }
    if (
      reconciliation.account?.id === personalAccountId
      && reconciliation.account.accountType === 'personal'
    ) {
      throw joinError;
    }
    throw new EnterpriseJoinStateUncertainError(
      '身份对账返回了与当前会话不一致的账号',
    );
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

  async deleteAccount(id: string): Promise<{ id: string; deleted: true }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['account_deletion']);
    return this.request(`/enterprise/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
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

  async listKnowledge(input: {
    query?: string;
    department?: string;
  } = {}): Promise<EnterpriseKnowledgeItem[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    const params = new URLSearchParams();
    if (input.query?.trim()) params.set('q', input.query.trim());
    if (input.department?.trim()) params.set('department', input.department.trim());
    const suffix = params.toString() ? `?${params}` : '';
    const response = await this.request<{ knowledge: EnterpriseKnowledgeRow[] }>(
      `/enterprise/knowledge${suffix}`,
    );
    return response.knowledge.map((item) => ({
      id: item.id,
      organizationId: item.organizationId || item.organization_id || '',
      sourceId: item.sourceId ?? item.source_id ?? null,
      department: item.department ?? null,
      category: item.category,
      content: item.content,
      contributor: item.contributor ?? null,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      createdAt: item.createdAt || item.created_at || '',
    }));
  }

  async getOrganizationView(): Promise<EnterpriseOrganizationView> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    return this.request('/enterprise/organization/view');
  }

  async listDirectMessages(peerAccountId: string): Promise<EnterpriseDirectMessage[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['direct_messages']);
    return (await this.request<{ messages: EnterpriseDirectMessage[] }>(
      `/enterprise/messages/${encodeURIComponent(peerAccountId)}`,
    )).messages;
  }

  async sendDirectMessage(peerAccountId: string, content: string): Promise<EnterpriseDirectMessage> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['direct_messages']);
    return (await this.request<{ message: EnterpriseDirectMessage }>(
      `/enterprise/messages/${encodeURIComponent(peerAccountId)}`,
      { method: 'POST', body: JSON.stringify({ content }) },
    )).message;
  }

  async listAtoaInbox(): Promise<EnterpriseAtoaInboxMessage[]> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['atoa']);
    return (await this.request<{ requests: EnterpriseAtoaInboxMessage[] }>(
      '/enterprise/atoa/inbox',
    )).requests;
  }

  async pushParkService(input: {
    recipientAccountId: string;
    serviceId: string;
    note?: string | null;
  }): Promise<{ message: EnterpriseDirectMessage }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(this.serverUrl, ['park_service_push']);
    return this.request('/enterprise/park-services/push', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getOrganizationInvite(): Promise<EnterpriseOrganizationInviteContext> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(
      this.serverUrl,
      ['organization_invites', 'position_invites'],
    );
    return this.request('/enterprise/organization/invite');
  }

  async issueOrganizationInvite(input: {
    defaultDepartment?: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    defaultRole?: string | null;
    maxUses?: number | null;
  } = {}): Promise<EnterpriseOrganizationInviteContext & {
    invite: EnterpriseOrganizationInvite;
  }> {
    if (!this.token) throw new Error('登录已失效，请重新登录');
    await this.assertCompatibleServer(
      this.serverUrl,
      ['organization_invites', 'position_invites'],
    );
    return this.request('/enterprise/organization/invite', {
      method: 'POST',
      body: JSON.stringify({
        defaultDepartment: input.defaultDepartment ?? null,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        positionTitle: input.positionTitle ?? null,
        defaultRole: input.defaultRole ?? null,
        maxUses: input.maxUses ?? null,
      }),
    });
  }

  async ticketInbox(): Promise<EnterpriseRepairTicket[]> {
    return (await this.request<{ tickets: EnterpriseRepairTicket[] }>('/enterprise/tickets/inbox')).tickets;
  }

  async listTickets(): Promise<EnterpriseRepairTicket[]> {
    return (await this.request<{ tickets: EnterpriseRepairTicket[] }>('/enterprise/tickets')).tickets;
  }

  async submitTicket(input: {
    title: string;
    description: string;
    targetTags?: string[];
    category?: string;
    location?: string;
    urgency?: string;
    contact?: string;
    contactPhone?: string;
  }): Promise<EnterpriseRepairTicket> {
    return (await this.request<{ ticket: EnterpriseRepairTicket }>('/enterprise/tickets', {
      method: 'POST', body: JSON.stringify(input),
    })).ticket;
  }

  async readTicket(id: string): Promise<EnterpriseRepairTicket> {
    return (await this.request<{ ticket: EnterpriseRepairTicket }>(
      `/enterprise/tickets/${encodeURIComponent(id)}/read`,
      { method: 'POST' },
    )).ticket;
  }

  async updateTicket(id: string, input: {
    action: 'respond' | 'accept' | 'complete' | 'confirm';
    responseType?: string;
    responseText?: string;
  }): Promise<EnterpriseRepairTicket> {
    return (await this.request<{ ticket: EnterpriseRepairTicket }>(
      `/enterprise/tickets/${encodeURIComponent(id)}/action`,
      { method: 'POST', body: JSON.stringify(input) },
    )).ticket;
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
