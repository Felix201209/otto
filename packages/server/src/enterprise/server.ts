/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Server - HTTP API for Otto Enterprise.
 * 跑在管理员/老板设备上，所有数据本地（node:sqlite），零云端。
 *
 * 相对 enterprise 分支原版做的加固（optimize）：
 *   1. 默认只监听 127.0.0.1（原版 0.0.0.0 全网裸奔）；要局域网暴露须显式设 HOST。
 *   2. 管理端路由（invite/offboard/export/audit/employees/report/dashboard）需管理员凭证；
 *      监听非本地又没设 token 时自动生成并仅写入 0600 文件，绝不无鉴权对外。
 *   3. 去掉通配 CORS（`*`）——看板是同源 fetch，不需要跨域放行。
 *   4. 看板对「省时/省钱/ROI」显式标注「估算」，不把估值当实测。
 *   5. 不在模块顶层 listen()，导出 create/start 函数，可被测试/桌面按需拉起。
 *
 * Endpoints:
 *   POST /enterprise/join      GET  /enterprise/recall     GET  /enterprise/audit*
 *   POST /enterprise/onboard   GET  /enterprise/report*    GET  /enterprise/export*
 *   POST /enterprise/task      GET  /enterprise/employees* GET  /enterprise/health
 *   POST /enterprise/offboard* POST /enterprise/invite*    GET  /enterprise/dashboard*
 *   GET/POST /enterprise/knowledge          (* = 需要 admin token)
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAliyunLoginSmsFromEnv } from 'otto-core';
import * as db from './db.js';

import { resolveEnterprisePublicBaseUrl } from './publicInvite.js';
import { handleFeatureFlagsRoute } from './featureFlagsAdmin.js';
import { parkAdminHTML } from './parkAdminPage.js';
import {
  createRepairFeishuSenderFromEnv,
  createRepairSmsSenderFromEnv,
  type RepairNotificationSender,
} from './repairNotifications.js';
import { FeatureFlagManager, ProjectSettingsManager } from 'otto-core';
import { handleAdminDataRoute } from './adminDataRoutes.js';
import { handleAdminPageRoute } from './adminPageRoutes.js';
import { handleAccountRoute } from './accountRoutes.js';
import { handleAuthRoute } from './authRoutes.js';
import { handleCreditsRoute } from './creditsRoutes.js';
import { handleDeploymentRoute } from './deploymentRoutes.js';
import { handleGeneralizedParkRoute } from './generalizedParkRoutes.js';
import { handleLocalAgentRoute } from './localAgentRoutes.js';
import { handleMemberWorkflowRoute } from './memberWorkflowRoutes.js';
import { handleModuleUpdateRoute } from './moduleUpdateRoutes.js';
import { handleOrganizationRoute } from './organizationRoutes.js';
import { handleParkResourceRoute } from './parkResourceRoutes.js';
import { handleParkServicePublicationRoute } from './parkServicePublicationRoutes.js';
import { handlePlatformOrganizationRoute } from './platformOrganizationRoutes.js';
import { handleSimpleParkCompatibilityRoute } from './simpleParkCompatibilityRoutes.js';
import { handleTicketRoute } from './ticketRoutes.js';
import { handleWorkspaceRoute } from './workspaceRoutes.js';

const DEFAULT_PORT = 7777;

/** 需要管理员令牌的路由（读/写全公司数据或改员工状态）。 */
const ADMIN_ROUTES = new Set([
  '/enterprise/invite',
  '/enterprise/offboard',
  '/enterprise/export',
  '/enterprise/audit',
  '/enterprise/employees',
  '/enterprise/report',
  '/enterprise/accounts',
  '/enterprise/organization/invite',
  '/enterprise/park',
  '/enterprise/park/manage',
  '/enterprise/park/invite',
  '/enterprise/park/join',
  '/enterprise/park/profile',
  '/enterprise/park/tenants',
  '/enterprise/park/specialists',
  '/enterprise/park/services',
  '/enterprise/park/services/assign',
  '/enterprise/park-services/push',
  '/enterprise/park-services/survey-results',
  '/enterprise/park-settings',
  '/enterprise/park-meeting-rooms',
  '/enterprise/park-meeting-slots',
  '/enterprise/usage/summary',
  '/enterprise/deployment/status',
  '/enterprise/deployment/license',
  '/enterprise/deployment/telemetry',
  '/enterprise/deployment/diagnostics',
  '/enterprise/modules/updates',
  '/enterprise/organizations',
]);

/** 会读取或写入企业内部数据的成员路由，必须使用账号会话。 */
const MEMBER_ROUTES = new Set([
  '/enterprise/onboard',
  '/enterprise/task',
  '/enterprise/recall',
  '/enterprise/knowledge',
  '/enterprise/credits/balance',
  '/enterprise/credits/redeem',
  '/enterprise/credits/redeem-codes',
  '/enterprise/credits/topup',
  '/enterprise/credits/transactions',
  '/enterprise/organization/view',
  '/enterprise/organization/features',
  '/enterprise/presence/heartbeat',
  '/enterprise/organization/sync',
  '/enterprise/park/view',
  '/enterprise/messages/unread',
  '/enterprise/auth/join-organization',
  '/enterprise/park-resources',
  '/enterprise/modules/updates/client',
]);

const FEATURE_ADMIN_PREFIX = '/admin/features';

interface RouteBody {
  [key: string]: unknown;
}

export interface EnterpriseServerOptions {
  port?: number;
  host?: string;
  /**
   * 尚未完成的本地 Agent 配对入口；默认关闭且不读取环境变量。
   * 仅测试或受控开发环境可显式开启。
   */
  localAgentPairingEnabled?: boolean;
  /** 对外企业引入页基址；不传则读 OTTO_ENTERPRISE_PUBLIC_URL，再回落到内置公网地址。 */
  publicUrl?: string;
  /** 管理端令牌；不传则读 OTTO_ENTERPRISE_ADMIN_TOKEN。 */
  adminToken?: string;
  /** 验证码发送器；测试可注入，显式 null 表示关闭。 */
  smsSender?: VerificationSmsSender | null;
  /** 园区报修通知短信；与验证码模板分离，测试可注入。 */
  repairSmsSender?: RepairNotificationSender | null;
  /** 园区报修飞书私聊；测试可注入。 */
  repairFeishuSender?: RepairNotificationSender | null;
  /** 部署版本；不传则读 OTTO_APP_VERSION。 */
  appVersion?: string;
  /** 构建提交；不传则读 OTTO_BUILD_COMMIT / GITHUB_SHA。 */
  buildCommit?: string;
  /** 密码登录限流参数；生产使用安全默认值，测试可注入时钟和较小阈值。 */
  loginRateLimit?: PasswordLoginRateLimitOptions;
}

export interface VerificationSmsSender {
  sendVerificationCode(phone: string, code: string): Promise<boolean>;
}

export interface PasswordLoginRateLimitOptions {
  maxFailures?: number;
  /** 单个客户端 IP 在窗口内跨账号失败的上限，防 identifier 轮换式密码喷洒。 */
  maxIpFailures?: number;
  windowMs?: number;
  blockMs?: number;
  maxEntries?: number;
  /**
   * 仅在明确知道前方有多少层可信反向代理时设置。1 表示 Caddy 直连本服务；
   * 服务会从 X-Forwarded-For 右侧按跳数取真实客户端，默认 0 完全忽略该 header。
   */
  trustedProxyHops?: number;
  /**
   * 允许提供 X-Forwarded-For 的直连代理 IP（仅支持精确 IP）。
   * loopback 代理始终可信；其他来源必须列在这里或 OTTO_ENTERPRISE_TRUSTED_PROXIES。
   */
  trustedProxyAddresses?: string[];
  now?: () => number;
}

export interface EnterpriseProxyOptions {
  trustedProxyHops?: number;
  trustedProxyAddresses?: readonly string[];
}

const ENTERPRISE_API_VERSION = 4;

const ENTERPRISE_CAPABILITIES = [
  'password_auth',
  'sms_login',
  'sms_registration',
  'personal_registration',
  'personal_enterprise_upgrade',
  'organization_invites',
  'usage_summary',
  'admin_console',
  'account_deletion',
  'multi_organization',
  'direct_messages',
  'atoa',
  'position_invites',
  'park_service_push',
  'park_repair_v1',
  'park_services_v2',
  'organization_structure_v1',
  'organization_feature_switches_v1',
  'park_membership_v1',
  'park_specialist_routing_v1',
  'unread_message_notifications_v1',
  'account_presence_v1',
  'park_tenants_v1',
  'park_tenant_profiles_v1',
  'private_deployment_v1',
  'license_enforcement_v1',
  'encrypted_telemetry_queue_v1',
  'diagnostic_bundle_v1',
  'park_resources_v1',
  'park_meeting_slots_v1',
  'modular_update_push_v1',
] as const;

interface DeploymentInfo {
  version: string;
  buildCommit: string;
  startedAt: string;
}

interface LoginRateLimiter {
  keys(req: IncomingMessage, identifier: string): {
    identity: string;
    client: string;
  };
  retryAfterSeconds(keys: { identity: string; client: string }): number;
  recordFailure(keys: { identity: string; client: string }): number;
  clearIdentity(key: string): void;
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function nonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || value == null || value < 0) return fallback;
  return Math.min(maximum, Math.floor(value));
}

function normalizedIp(value: string): string | null {
  const normalized = value.trim().replace(/^::ffff:/, '');
  return isIP(normalized) ? normalized : null;
}

function isLoopbackAddress(address: string): boolean {
  return address === '127.0.0.1' || address === '::1';
}

/**
 * 解析用于登录限流的客户端 IP。默认完全忽略 XFF；即便配置了可信跳数，也只有
 * loopback 或明确列出的直连代理可以提供该 header，格式有歧义时一律回落直连地址。
 */
export function resolveEnterpriseClientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  options: EnterpriseProxyOptions = {},
): string {
  const direct = normalizedIp(remoteAddress || '') || 'unknown';
  const trustedProxyHops = nonNegativeInteger(options.trustedProxyHops, 0, 5);
  if (trustedProxyHops === 0) return direct;

  const trustedProxyAddresses = new Set(
    (options.trustedProxyAddresses ?? [])
      .map((address) => normalizedIp(address))
      .filter((address): address is string => address !== null),
  );
  if (!isLoopbackAddress(direct) && !trustedProxyAddresses.has(direct)) return direct;
  if (typeof forwardedFor !== 'string' || forwardedFor.length > 2048) return direct;

  const forwardedChain = forwardedFor
    .split(',')
    .map((address) => normalizedIp(address));
  if (forwardedChain.length === 0 || forwardedChain.some((address) => address === null)) {
    return direct;
  }
  const chain = [...forwardedChain as string[], direct];
  const candidateIndex = chain.length - trustedProxyHops - 1;
  if (candidateIndex < 0) return direct;
  return chain[candidateIndex] || direct;
}

function rateLimitClientAddress(
  req: IncomingMessage,
  options: EnterpriseProxyOptions,
): string {
  return resolveEnterpriseClientAddress(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
    options,
  );
}

/**
 * 每个 EnterpriseServer 实例独立的有界登录限流器。键只保留 identifier + 客户端地址
 * 的 SHA-256，不在内存中保存明文账号；超过上限按 LRU 淘汰，避免攻击者撑爆进程。
 */
function createLoginRateLimiter(options: PasswordLoginRateLimitOptions = {}): LoginRateLimiter {
  const maxFailures = positiveInteger(options.maxFailures, 5, 100);
  const maxIpFailures = positiveInteger(options.maxIpFailures, 30, 1_000);
  const windowMs = positiveInteger(options.windowMs, 15 * 60 * 1000, 24 * 60 * 60 * 1000);
  const blockMs = positiveInteger(options.blockMs, 60 * 1000, 24 * 60 * 60 * 1000);
  const maxEntries = positiveInteger(options.maxEntries, 10_000, 100_000);
  const trustedProxyHops = nonNegativeInteger(options.trustedProxyHops, 0, 5);
  const trustedProxyAddresses = options.trustedProxyAddresses ?? [];
  const now = options.now ?? Date.now;
  type RateEntry = {
    failures: number;
    windowStartedAt: number;
    blockedUntil: number;
  };
  const identityEntries = new Map<string, RateEntry>();
  const clientEntries = new Map<string, RateEntry>();

  const touch = (
    entries: Map<string, RateEntry>,
    key: string,
    entry: RateEntry,
  ): void => {
    entries.delete(key);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      entries.delete(oldest);
    }
    entries.set(key, entry);
  };

  const currentEntryIn = (
    entries: Map<string, RateEntry>,
    key: string,
    timestamp: number,
  ): RateEntry | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.blockedUntil <= timestamp && timestamp - entry.windowStartedAt >= windowMs) {
      entries.delete(key);
      return null;
    }
    touch(entries, key, entry);
    return entry;
  };

  const retryAfterFor = (
    entries: Map<string, RateEntry>,
    key: string,
    timestamp: number,
  ): number => {
    const entry = currentEntryIn(entries, key, timestamp);
    return entry && entry.blockedUntil > timestamp
      ? Math.max(1, Math.ceil((entry.blockedUntil - timestamp) / 1000))
      : 0;
  };

  const recordFailureFor = (
    entries: Map<string, RateEntry>,
    key: string,
    threshold: number,
    timestamp: number,
  ): number => {
    const existing = currentEntryIn(entries, key, timestamp);
    const entry = existing && timestamp - existing.windowStartedAt < windowMs
      ? existing
      : { failures: 0, windowStartedAt: timestamp, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= threshold) entry.blockedUntil = timestamp + blockMs;
    touch(entries, key, entry);
    return entry.blockedUntil > timestamp
      ? Math.max(1, Math.ceil((entry.blockedUntil - timestamp) / 1000))
      : 0;
  };

  return {
    keys(req, identifier) {
      const clientAddress = rateLimitClientAddress(req, {
        trustedProxyHops,
        trustedProxyAddresses,
      });
      let normalizedIdentifier = identifier.trim().toLocaleLowerCase('en-US');
      try {
        // 登录接受带空格、连字符或 +86 的手机号，限流键必须采用相同归一化，
        // 否则攻击者可仅改变展示格式绕过失败计数。
        normalizedIdentifier = db.normalizePhone(identifier);
      } catch {
        // 非手机号继续按大小写无关的用户名计数。
      }
      const identity = createHash('sha256')
        .update(`${normalizedIdentifier}\0${clientAddress}`)
        .digest('base64url');
      const client = createHash('sha256')
        .update(`client\0${clientAddress}`)
        .digest('base64url');
      return { identity, client };
    },
    retryAfterSeconds(keys) {
      const timestamp = now();
      return Math.max(
        retryAfterFor(identityEntries, keys.identity, timestamp),
        retryAfterFor(clientEntries, keys.client, timestamp),
      );
    },
    recordFailure(keys) {
      const timestamp = now();
      return Math.max(
        recordFailureFor(identityEntries, keys.identity, maxFailures, timestamp),
        recordFailureFor(clientEntries, keys.client, maxIpFailures, timestamp),
      );
    },
    clearIdentity(key) {
      identityEntries.delete(key);
    },
  };
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<RouteBody> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) body = body.slice(0, 1_000_000); // 防超大 body
    });
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as RouteBody) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** 管理令牌只允许放在 header；URL query 会进入代理日志与浏览器历史，禁止使用。 */
function extractToken(req: IncomingMessage): string {
  const h = req.headers['x-otto-admin-token'];
  if (typeof h === 'string' && h) return h;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

function tokensMatch(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function isAdminRoute(path: string): boolean {
  return ADMIN_ROUTES.has(path)
    || path.startsWith('/enterprise/accounts/')
    || path.startsWith('/enterprise/organization/departments')
    || path.startsWith('/enterprise/organization/positions')
    || path.startsWith('/enterprise/park-meeting-rooms/')
    || path.startsWith('/enterprise/platform/organizations/');
}

function isMemberRoute(path: string): boolean {
  return MEMBER_ROUTES.has(path)
    || path === '/enterprise/atoa/inbox'
    || path.startsWith('/enterprise/messages/')
    || (path.startsWith('/enterprise/credits/redeem-codes/') && path.endsWith('/revoke'));
}

function isPublicSimpleParkRoute(path: string, method: string, url: URL): boolean {
  return (
    path === '/enterprise/park/join' && method === 'POST'
  ) || (
    path === '/enterprise/park/services' &&
    method === 'GET' &&
    url.searchParams.has('parkId')
  ) || (
    path === '/enterprise/park/services/request' && method === 'POST'
  );
}
function isLicenseMaintenanceRoute(path: string): boolean {
  return path === '/enterprise/health'
    || path === '/enterprise/export'
    || path === '/enterprise/deployment/status'
    || path === '/enterprise/deployment/license'
    || path === '/enterprise/deployment/telemetry'
    || path === '/enterprise/deployment/diagnostics'
    || path.startsWith('/enterprise/auth/');
}

function licenseBlockedPayload() {
  const status = db.getPrivateDeploymentStatus();
  return {
    error: 'deployment license is not active',
    license: status.license,
    allowed: ['login', 'license update', 'data export', 'diagnostics'],
  };
}

function organizationViewPayload(organizationId: string) {
  const organization = db.getOrganization(organizationId);
  const accounts = db.listAccounts(organizationId);
  const employees = db.listEmployees(undefined, organizationId);
  const park = db.getParkForOrganization(organizationId);
  const presenceByAccountId = new Map(
    db.listAccountPresence(organizationId).map((presence) => [presence.accountId, presence]),
  );
  return {
    organization: organization ? {
      id: organization.id,
      name: organization.name,
      status: organization.status,
      parkId: organization.parkId,
      createdAt: organization.createdAt,
    } : null,
    members: accounts.map((account) => ({
      id: account.id,
      username: account.username,
      name: account.name,
      role: account.role,
      department: account.department,
      departmentId: account.departmentId,
      positionId: account.positionId,
      positionTitle: account.positionTitle,
      avatarUrl: account.avatarUrl,
      isAdmin: account.isAdmin,
      status: account.status,
      ottoOnline: presenceByAccountId.get(account.id)?.online ?? false,
      ottoLastSeenAt: presenceByAccountId.get(account.id)?.lastSeenAt ?? null,
    })),
    employeeCount: employees.length,
    structure: db.listOrganizationStructure(organizationId),
    features: db.getOrganizationFeatures(organizationId),
    park: park ? {
      ...park,
      isAdminOrganization: park.adminOrganizationId === organizationId,
      services: db.listParkServices(park.id),
    } : null,
  };
}

function isCrossOriginBrowserRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || !host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function isLoopbackRequestHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host.trim()) return false;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return isLoopback(hostname);
  } catch {
    return false;
  }
}

type AdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

function makeHandler(
  adminToken: string,
  smsSender: VerificationSmsSender | null,
  repairSmsSender: RepairNotificationSender | null,
  repairFeishuSender: RepairNotificationSender | null,
  publicBaseUrl: string,
  loginRateLimiter: LoginRateLimiter,
  deploymentInfo: DeploymentInfo,
  localAgentPairingEnabled: boolean,
  featureFlags?: FeatureFlagManager,
) {
  // 同一账号可能在多台桌面端同时在线。服务端对现有 direct_messages 队列做
  // 短租约 claim，保证一条 A2A 请求同一时刻只交给一个客户端；进程异常后
  // 租约自动过期并可重试，不新增另一套聊天存储。
  const atoaClaims = new Map<string, number>();
  const ATOA_CLAIM_TTL_MS = 180_000;
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 只需要 path/query，不使用客户端可控的 Host 或 X-Forwarded-Host 作为 URL 权威源。
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const isFeatureFlagsRoute = path.startsWith(FEATURE_ADMIN_PREFIX);
    const isPublicSimplePark = isPublicSimpleParkRoute(path, method, url);
    let adminPrincipal: AdminPrincipal | null = null;
    let memberAccount: db.AccountView | null = null;

    if (!localAgentPairingEnabled && (
      path === '/enterprise/sdk/otto-discovery.js'
      || path === '/enterprise/local-agent'
      || path === '/enterprise/local-agent/pair'
      || path === '/enterprise/local-agent/pair/verify'
    )) {
      sendJSON(res, 404, { error: 'not found' });
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/' && method === 'GET') {
      res.writeHead(302, {
        Location: '/enterprise/admin',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    // 浏览器会自动请求站点图标；显式无内容响应，避免管理后台验收出现无关 404。
    if (path === '/favicon.ico' && method === 'GET') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    // 旧版曾允许 /dashboard?token=... 并把令牌注入 HTML。明确拒绝这一入口，
    // 防止平台令牌或账号会话进入反向代理日志、浏览器历史和 Referer。
    if (path === '/enterprise/dashboard' && url.searchParams.has('token')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      sendJSON(res, 400, {
        error: '请勿在 URL 中传递管理令牌，请在安全看板页面中登录或粘贴令牌',
      });
      return;
    }

    try {
      // 无静态 token 的兼容模式只能通过明确的 loopback Host 使用，避免 DNS
      // rebinding 让恶意域名在 Origin/Host 同名时伪装成本机管理站点。
      if ((isAdminRoute(path) || isFeatureFlagsRoute) && !isPublicSimplePark && !adminToken && !isLoopbackRequestHost(req)) {
        sendJSON(res, 403, { error: 'forbidden: loopback admin host required' });
        return;
      }

      // 本机兼容模式允许无静态 token 管理，但仍必须阻止第三方网页借浏览器
      // 对状态变更接口发起 blind POST/PATCH（无 Origin 的 CLI/桌面调用不受影响）。
      if ((isAdminRoute(path) || isFeatureFlagsRoute)
        && !isPublicSimplePark
        && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
        && isCrossOriginBrowserRequest(req)) {
        sendJSON(res, 403, { error: 'forbidden: cross-origin admin request' });
        return;
      }

      // 管理端鉴权：兼容平台静态 admin token，同时允许企业管理员账号的登录会话。
      // 即便是未配置静态 token 的本机服务，也必须先登录；loopback 只限制可访问来源，
      // 绝不能等价于“任何本机进程或网页都拥有平台管理员权限”。
      if ((isAdminRoute(path) || isFeatureFlagsRoute) && !isPublicSimplePark) {
        const token = extractToken(req);
        if (adminToken && tokensMatch(token, adminToken)) {
          adminPrincipal = { kind: 'system', organizationId: db.DEFAULT_ORGANIZATION_ID };
        } else if (adminToken) {
          const account = db.getAccountBySession(token);
          if (!account) {
            sendJSON(res, 401, { error: 'unauthorized: admin login required' });
            return;
          }
          if (!account.isAdmin) {
            sendJSON(res, 403, { error: 'forbidden: admin account required' });
            return;
          }
          adminPrincipal = { kind: 'account', organizationId: account.organizationId, account };
        } else {
          // 未配置静态 token 的本机模式仅接受管理员账号会话，不提供平台级绕过。
          const account = db.getAccountBySession(token);
          if (!account) {
            sendJSON(res, 401, { error: 'unauthorized: admin login required' });
            return;
          }
          if (!account.isAdmin) {
            sendJSON(res, 403, { error: 'forbidden: admin account required' });
            return;
          }
          adminPrincipal = { kind: 'account', organizationId: account.organizationId, account };
        }
      }

      if (isMemberRoute(path)) {
        memberAccount = db.getAccountBySession(extractToken(req));
        if (!memberAccount) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
      }
      if ((isAdminRoute(path) || isMemberRoute(path))
        && !isLicenseMaintenanceRoute(path)
        && db.isLicenseRestricted()) {
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }
      if (isPublicSimplePark && db.isLicenseRestricted()) {
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }

      // ===== Health =====
      if (path === '/enterprise/health' && method === 'GET') {
        try {
          const readiness = db.getDatabaseReadiness();
          sendJSON(res, 200, {
            status: 'ok',
            service: 'otto-enterprise',
            apiVersion: ENTERPRISE_API_VERSION,
            version: deploymentInfo.version,
            // appVersion 作为旧调用方的可读别名保留；新版客户端使用 version。
            appVersion: deploymentInfo.version,
            buildCommit: deploymentInfo.buildCommit,
            schemaVersion: readiness.schemaVersion,
            capabilities: [...ENTERPRISE_CAPABILITIES],
            uptime: process.uptime(),
            startedAt: deploymentInfo.startedAt,
            runtimeVersion: process.version,
            db: 'connected',
            sms: { configured: smsSender !== null },
            repairNotifications: {
              sms: repairSmsSender !== null,
              feishu: repairFeishuSender !== null,
            },
            deployment: {
              ...db.getPrivateDeploymentStatus(),
              moduleUpdates: db.getModuleUpdateManifest(),
              version: deploymentInfo.version,
              buildCommit: deploymentInfo.buildCommit,
              startedAt: deploymentInfo.startedAt,
            },
          });
        } catch {
          sendJSON(res, 503, {
            status: 'unavailable',
            service: 'otto-enterprise',
            apiVersion: ENTERPRISE_API_VERSION,
            version: deploymentInfo.version,
            appVersion: deploymentInfo.version,
            buildCommit: deploymentInfo.buildCommit,
            schemaVersion: null,
            capabilities: [...ENTERPRISE_CAPABILITIES],
            db: 'unavailable',
            error: 'enterprise database unavailable',
          });
        }
        return;
      }

      // ===== Private deployment, license and telemetry =====
      if (await handleModuleUpdateRoute({
        path,
        method,
        req,
        res,
        principal: adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleDeploymentRoute({
        path,
        method,
        req,
        res,
        url,
        principal: adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleLocalAgentRoute({
        path,
        method,
        req,
        res,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleAuthRoute({
        path,
        method,
        req,
        res,
        memberAccount,
        publicBaseUrl,
        smsSender,
        loginRateLimiter,
        readBody,
        sendJSON,
        extractToken,
      })) {
        return;
      }

      if (await handleOrganizationRoute({
        path,
        method,
        req,
        res,
        memberAccount,
        adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleSimpleParkCompatibilityRoute({
        path,
        method,
        req,
        res,
        url,
        adminPrincipal,
        isPublicSimplePark,
        readBody,
        sendJSON,
        extractToken,
      })) {
        return;
      }

      if (await handleGeneralizedParkRoute({
        path,
        method,
        req,
        res,
        memberAccount,
        adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleAccountRoute({
        path,
        method,
        req,
        res,
        adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleParkResourceRoute({
        path,
        method,
        req,
        res,
        url,
        memberAccount,
        adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleParkServicePublicationRoute({
        path,
        method,
        req,
        res,
        adminPrincipal,
        readBody,
        sendJSON,
        extractToken,
      })) {
        return;
      }

      if (await handleWorkspaceRoute({
        path,
        method,
        req,
        res,
        url,
        adminPrincipal,
        publicBaseUrl,
        readBody,
        sendJSON,
        extractToken,
      })) {
        return;
      }

      if (await handlePlatformOrganizationRoute({
        path,
        method,
        req,
        res,
        adminPrincipal,
        publicBaseUrl,
        readBody,
        sendJSON,
      })) {
        return;
      }

      if (await handleTicketRoute({
        path,
        method,
        req,
        res,
        repairSmsSender,
        repairFeishuSender,
        extractToken,
        readBody,
        sendJSON,
      })) {
        return;
      }

      // ===== Enterprise Credits System =====
      if (await handleCreditsRoute({
        path,
        method,
        req,
        res,
        url,
        memberAccount,
        readBody,
        sendJSON,
      })) {
        return;
      }

      // ===== Member workflow routes =====
      if (await handleMemberWorkflowRoute({
        path,
        method,
        req,
        res,
        url,
        memberAccount,
        adminPrincipal,
        readBody,
        sendJSON,
      })) {
        return;
      }

      // ===== Admin data routes =====
      if (handleAdminDataRoute({
        path,
        method,
        res,
        url,
        adminPrincipal,
        sendJSON,
      })) {
        return;
      }

      // ===== Organization view (non-admin, any authenticated member) =====
      if (path === '/enterprise/organization/view' && method === 'GET') {
        const organizationId = memberAccount!.organizationId;
        if (!db.getOrganizationFeatures(organizationId).enterprise_tree) {
          sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
          return;
        }
        sendJSON(res, 200, organizationViewPayload(organizationId));
        return;
      }

      if (path === '/enterprise/organization/sync' && method === 'GET') {
        const organizationId = memberAccount!.organizationId;
        const features = db.getOrganizationFeatures(organizationId);
        if (!features.enterprise_tree) {
          sendJSON(res, 403, { error: '企业树同步功能已由管理员关闭' });
          return;
        }
        sendJSON(res, 200, organizationViewPayload(organizationId));
        return;
      }

      if (path === '/enterprise/presence/heartbeat' && method === 'POST') {
        const body = await readBody(req);
        const clientId = typeof body.clientId === 'string' ? body.clientId : 'desktop';
        const presence = db.touchAccountPresence({
          organizationId: memberAccount!.organizationId,
          accountId: memberAccount!.id,
          clientId,
        });
        sendJSON(res, 200, { presence });
        return;
      }

      if (path === '/enterprise/atoa/inbox' && method === 'GET') {
        if (!db.getOrganizationFeatures(memberAccount!.organizationId).atoa) {
          sendJSON(res, 403, { error: '企业协作功能已由管理员关闭' });
          return;
        }
        const now = Date.now();
        for (const [key, expiresAt] of atoaClaims) {
          if (expiresAt <= now) atoaClaims.delete(key);
        }
        const pending = db.listPendingAtoaRequests({
          organizationId: memberAccount!.organizationId,
          accountId: memberAccount!.id,
          requestPrefix: 'OTTO_ATOA_REQUEST ',
          responsePrefix: 'OTTO_ATOA_RESPONSE ',
          limit: Number(url.searchParams.get('limit') || 50),
        });
        const claimed = pending.find((request) => {
          const peer = db.getAccount(
            request.peerAccountId,
            memberAccount!.organizationId,
          );
          // 已停用或已删除的发送方不能继续触发接收方模型与权限弹窗。
          if (!peer || peer.status !== 'active') return false;
          const key = `${memberAccount!.organizationId}:${memberAccount!.id}:${request.id}`;
          if ((atoaClaims.get(key) ?? 0) > now) return false;
          atoaClaims.set(key, now + ATOA_CLAIM_TTL_MS);
          return true;
        });
        const peer = claimed
          ? db.getAccount(
              claimed.peerAccountId,
              memberAccount!.organizationId,
            )
          : null;
        sendJSON(res, 200, {
          requests:
            claimed && peer
              ? [
                  {
                    ...claimed,
                    peer: {
                      id: peer.id,
                      username: peer.username,
                      name: peer.name,
                      department: peer.department,
                      positionTitle: peer.positionTitle,
                      role: peer.role,
                    },
                  },
                ]
              : [],
        });
        return;
      }

      if (path === '/enterprise/messages/unread' && method === 'GET') {
        if (!db.getOrganizationFeatures(memberAccount!.organizationId).direct_messages) {
          sendJSON(res, 403, { error: '企业内部消息功能已由管理员关闭' });
          return;
        }
        const requestedLimit = Number(url.searchParams.get('limit') || 50);
        sendJSON(res, 200, {
          notifications: db.listUnreadDirectMessageNotifications({
            organizationId: memberAccount!.organizationId,
            accountId: memberAccount!.id,
            limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
          }),
        });
        return;
      }

      if (path.startsWith('/enterprise/messages/') && (method === 'GET' || method === 'POST')) {
        if (!db.getOrganizationFeatures(memberAccount!.organizationId).direct_messages) {
          sendJSON(res, 403, { error: '企业内部消息功能已由管理员关闭' });
          return;
        }
        const peerAccountId = decodeURIComponent(path.slice('/enterprise/messages/'.length));
        const peer = db.getAccount(peerAccountId, memberAccount!.organizationId);
        if (!peer || peer.status !== 'active') {
          sendJSON(res, 404, { error: '成员不存在或已停用' });
          return;
        }
        if (peer.id === memberAccount!.id) {
          sendJSON(res, 400, { error: '不能给自己发送消息' });
          return;
        }
        if (method === 'GET') {
          sendJSON(res, 200, { messages: db.listDirectMessages({
            organizationId: memberAccount!.organizationId,
            accountId: memberAccount!.id,
            peerAccountId,
            limit: Number(url.searchParams.get('limit') || 100),
          }) });
          return;
        }
        const body = await readBody(req);
        if (typeof body.content !== 'string') {
          sendJSON(res, 400, { error: '消息内容不能为空' });
          return;
        }
        try {
          const message = db.sendDirectMessage({
            organizationId: memberAccount!.organizationId,
            senderAccountId: memberAccount!.id,
            recipientAccountId: peerAccountId,
            content: body.content,
          });
          if (body.content.startsWith('OTTO_ATOA_RESPONSE ')) {
            const requestId = db.markAtoaRequestReadFromResponse({
              organizationId: memberAccount!.organizationId,
              responderAccountId: memberAccount!.id,
              peerAccountId,
              responseContent: body.content,
              requestPrefix: 'OTTO_ATOA_REQUEST ',
              responsePrefix: 'OTTO_ATOA_RESPONSE ',
            });
            if (requestId) {
              atoaClaims.delete(
                `${memberAccount!.organizationId}:${memberAccount!.id}:${requestId}`,
              );
            }
          }
          sendJSON(res, 201, { message });
        } catch (error) {
          sendJSON(res, 400, { error: error instanceof Error ? error.message : '消息发送失败' });
        }
        return;
      }

      if (handleAdminPageRoute(method, path, res, {
        adminAccountsHTML,
        parkAdminHTML,
        platformAdminHTML,
        adminDashboardHTML,
        adminCreditsHTML,
      })) {
        return;
      }

      if (isFeatureFlagsRoute && featureFlags) {
        const userId = adminPrincipal
          ? (adminPrincipal.kind === 'account' ? adminPrincipal.account.id : 'platform-admin')
          : 'unknown';
        if (handleFeatureFlagsRoute(method, path, featureFlags, res, userId)) {
          return;
        }
      }

      sendJSON(res, 404, { error: `Not found: ${method} ${path}` });
    } catch (err: unknown) {
      console.error('[Otto Enterprise] 请求处理失败', err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJSON(res, 500, { error: '企业服务暂时不可用，请稍后重试' });
    }
  };
}

export function adminAccountsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 企业账号管理</title>
<style>
:root{--ink:#18221e;--muted:#66716c;--line:#dce3df;--line-strong:#c9d3ce;--paper:#f4f6f5;--panel:#fff;--subtle:#edf2ef;--accent:#176a4b;--accent-hover:#11563c;--accent-soft:#e5f1eb;--danger:#aa3f35;--danger-soft:#faece9;--nav:#14231d;--nav-line:#2d4038;--radius:10px;--shadow:0 18px 48px rgba(26,42,34,.16)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.5}button,input,select{font:inherit}button{cursor:pointer}.hidden{display:none!important}.sr-only{position:absolute;left:0;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid #0b5f42!important;outline-offset:2px}.rail button:focus-visible{outline-color:#8eeec7!important}.brand{font-size:23px;font-weight:800;letter-spacing:-.04em}.brand-mark{color:#69d5ab;margin-left:3px}.eyebrow{font-size:11px;letter-spacing:.13em;color:var(--accent);font-weight:750;text-transform:uppercase}
.login{min-height:100vh;min-height:100dvh;display:grid;grid-template-columns:minmax(360px,1fr) minmax(420px,.82fr)}.login-story{padding:54px clamp(36px,7vw,92px);background:var(--nav);color:#f4f8f6;display:flex;flex-direction:column;justify-content:space-between}.login-story .brand{font-size:28px}.story-copy{max-width:650px;margin:72px 0}.story-copy h1{font-size:clamp(38px,5vw,66px);line-height:1.05;letter-spacing:-.055em;margin:14px 0 22px}.story-copy p{color:#aebdb6;font-size:16px;line-height:1.8;max-width:570px}.signal{display:flex;gap:10px;align-items:center;color:#9fb0a8;font-size:13px}.signal b{width:8px;height:8px;border-radius:50%;background:#65d6ad}.login-side{display:grid;place-items:center;padding:42px;min-width:0;overflow:auto}.login-card{width:min(420px,100%)}.login-mobile-brand{display:none}.login-card h2{font-size:31px;letter-spacing:-.035em;margin:13px 0 8px}.login-card>p{color:var(--muted);line-height:1.7;margin:0 0 28px}.platform-link{display:block;text-align:center;margin-top:18px;color:var(--accent);font-weight:700;text-decoration:none}.platform-link:hover{text-decoration:underline}
.field{display:grid;gap:7px;margin:15px 0}.field label,.field-title{font-size:12px;font-weight:700;color:#46534d}.field input,.field select,.search{width:100%;height:44px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;background:#fff;color:var(--ink);outline:none}.field input:focus,.field select:focus,.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.1)}.password-wrap{position:relative}.password-wrap input{padding-right:68px}.password-toggle{position:absolute;right:6px;top:6px;height:32px;min-width:54px;border:0;border-radius:6px;background:transparent;color:var(--accent);font-size:12px;font-weight:750}.password-toggle:hover{background:var(--accent-soft)}.primary,.secondary,.danger,.ghost-dark,.edit,.template-button,.tag-choice{border-radius:8px;font-weight:700;transition:background-color .14s,border-color .14s,color .14s}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff;padding:11px 17px}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.primary:disabled,.danger:disabled{opacity:.5;cursor:default}.secondary{border:1px solid var(--line-strong);background:#fff;color:var(--ink);padding:10px 15px}.secondary:hover,.edit:hover{border-color:#9caaa3;background:#f8faf9}.danger{border:1px solid var(--danger);background:var(--danger);color:#fff;padding:10px 15px}.login-card .primary{width:100%;height:47px;margin-top:8px}.error{color:var(--danger);background:var(--danger-soft);border:1px solid #edcbc5;padding:10px 12px;border-radius:8px;margin-top:13px;line-height:1.5}
.admin{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr)}.rail{background:var(--nav);color:#edf5f1;padding:26px 19px 20px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.rail .brand{padding:0 9px;margin-bottom:38px}.nav-label{font-size:10px;color:#7f958b;letter-spacing:.12em;margin:8px 11px}.nav-item{display:flex;align-items:center;gap:10px;padding:10px 11px;border:1px solid var(--nav-line);border-radius:8px;background:#20372e;color:#f0f6f3;font-weight:700}.nav-dot{width:7px;height:7px;background:#65d6ad;border-radius:50%}.rail-foot{margin-top:auto;border-top:1px solid var(--nav-line);padding:17px 9px 0}.rail-user{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rail-meta{color:#8fa198;font-size:12px;margin-top:3px}.ghost-dark{border:1px solid #435950;background:transparent;color:#cfdbd5;padding:8px 11px;margin-top:14px;width:100%}.ghost-dark:hover{background:#263d34;border-color:#5a7066}
.workspace{padding:31px clamp(24px,4vw,58px) 56px;min-width:0}.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.topbar h1{font-size:30px;letter-spacing:-.035em;margin:0 0 5px}.topbar p{color:var(--muted);margin:0}.summary-strip{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:17px;overflow:hidden}.summary-item{padding:15px 18px;border-left:1px solid var(--line)}.summary-item:first-child{border-left:0}.summary-item strong{display:block;font-size:23px;line-height:1.2;letter-spacing:-.025em}.summary-item span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:11px}.search-wrap{flex:1}.result-count{color:var(--muted);font-size:12px;white-space:nowrap}.table-wrap{background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:auto}.accounts{width:100%;border-collapse:collapse;min-width:820px}.accounts th{text-align:left;font-size:11px;letter-spacing:.045em;color:#53605a;background:#edf2ef;padding:11px 14px;border-bottom:1px solid var(--line)}.accounts td{padding:13px 14px;border-top:1px solid #ebefed;vertical-align:middle}.accounts tbody tr:first-child td{border-top:0}.accounts tr:hover td{background:#fafcfb}.name{font-weight:750}.sub{font-size:12px;color:var(--muted);margin-top:3px}.tag{display:inline-block;background:var(--accent-soft);color:#245e49;border:1px solid #d3e6dc;border-radius:999px;padding:3px 8px;font-size:11px;margin:2px 3px 2px 0}.badge{display:inline-block;white-space:nowrap;font-size:11px;border-radius:999px;padding:4px 8px;background:#edf1ef;color:#3f4b45}.badge.ok{background:var(--accent-soft);color:#245e49}.badge.off{background:var(--danger-soft);color:var(--danger)}.edit{border:1px solid var(--line-strong);background:#fff;padding:6px 10px;color:var(--ink)}.empty{text-align:center;color:var(--muted);padding:44px!important}
.ops-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:14px;margin-bottom:17px}.ops-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;min-width:0}.ops-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.ops-head h2{font-size:16px;margin:2px 0 4px;letter-spacing:-.015em}.ops-head p{font-size:12px;color:var(--muted);margin:0}.invite-row{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-top:18px}.invite-code{display:block;width:100%;border:0;background:transparent;padding:0;font:800 clamp(25px,3vw,38px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.075em;color:var(--ink);white-space:nowrap}.invite-meta{display:flex;align-items:center;gap:8px;margin-top:10px;min-height:25px}.invite-link-preview{display:block;width:100%;max-width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--subtle);color:#53605a;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.invite-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.token-number{font-size:36px;font-weight:800;letter-spacing:-.045em;line-height:1.1;margin:18px 0 4px}.token-split{display:flex;gap:14px;color:var(--muted);font-size:12px}.token-note{border-top:1px solid var(--line);padding-top:11px;margin-top:14px;color:var(--muted);font-size:11px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.copy{border:1px solid var(--line-strong);background:#fff;color:var(--ink);padding:10px 13px;border-radius:8px;font-weight:700}.copy:hover{background:#f8faf9;border-color:#9caaa3}
.configuration-shell{margin-bottom:17px}.configuration-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:3px 0 11px}.configuration-head h2{font-size:19px;margin:2px 0 0}.configuration-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.configuration-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;min-width:0}.configuration-card.wide{grid-column:1/-1}.configuration-card h3{font-size:16px;margin:2px 0 4px}.configuration-card>p{font-size:12px;color:var(--muted);margin:0 0 14px}.switch-list,.structure-list,.service-list,.module-update-list{display:grid;gap:8px}.switch-row,.department-row,.position-row,.service-row,.module-update-row{border:1px solid var(--line);border-radius:8px;background:#fafcfb;padding:10px 11px}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:14px}.switch-copy b{display:block}.switch-copy span{display:block;color:var(--muted);font-size:11px;margin-top:2px}.switch-row input{width:19px;height:19px;accent-color:var(--accent)}.compact-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end;margin:12px 0}.compact-form.three{grid-template-columns:minmax(0,1fr) minmax(140px,.45fr) auto}.compact-form .field{margin:0}.compact-form button{height:44px}.department-head,.position-head,.service-head,.module-update-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.row-actions{display:flex;gap:6px;flex-wrap:wrap}.row-actions button{padding:5px 8px}.position-list{display:grid;gap:6px;margin-top:8px;padding-left:12px}.position-row{background:#fff}.role-note{font-size:11px;color:var(--muted)}.module-update-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;align-items:end;margin:12px 0}.module-update-form .field{margin:0}.module-update-form .wide{grid-column:span 2}.module-update-actions{display:flex;gap:8px;align-items:end}.module-update-meta{color:var(--muted);font-size:11px;margin-top:4px;word-break:break-all}.park-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border:1px solid var(--line);border-radius:8px;background:var(--accent-soft);padding:12px;margin-bottom:12px}.park-summary strong{display:block}.park-summary span{display:block;color:#386b57;font-size:12px;margin-top:2px}.park-forms{display:grid;grid-template-columns:1fr 1fr;gap:12px}.park-form{border:1px solid var(--line);border-radius:8px;padding:12px}.park-form h4{margin:0 0 5px}.park-form p{font-size:11px;color:var(--muted);margin:0}.park-form .field{margin:10px 0}.park-invite{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:8px;align-items:end;margin:12px 0}.park-invite .field{margin:0}.service-specialists{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.specialist-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid #cfe3d8;background:var(--accent-soft);border-radius:999px;padding:4px 7px;font-size:11px}.specialist-chip button{border:0;background:transparent;color:var(--danger);padding:0}.service-editor{display:grid;grid-template-columns:minmax(130px,1fr) auto minmax(140px,.8fr) auto;gap:8px;align-items:center;margin-top:8px}.service-editor input,.service-editor select{height:36px;border:1px solid var(--line-strong);border-radius:7px;padding:0 9px;background:#fff}.service-editor label{display:flex;align-items:center;gap:6px;font-size:12px}.configuration-status{font-size:12px;color:var(--accent);min-height:18px}.configuration-disabled{border:1px dashed var(--line-strong);border-radius:8px;padding:14px;color:var(--muted);font-size:12px}
.drawer-backdrop{position:fixed;inset:0;background:rgba(15,27,21,.38);display:flex;justify-content:flex-end;z-index:10}.drawer{width:min(620px,100%);height:100%;background:#fff;box-shadow:var(--shadow);padding:27px 30px;overflow:auto}.drawer-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:21px}.drawer h2{margin:3px 0 0;font-size:25px;letter-spacing:-.03em}.close{border:1px solid var(--line);background:#f4f6f5;width:35px;height:35px;border-radius:8px;font-size:20px;line-height:1;color:#53605a}.form-section{border-top:1px solid var(--line);padding-top:18px;margin-top:19px}.form-section:first-of-type{border-top:0;padding-top:0;margin-top:0}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-head strong{font-size:13px}.section-head span{font-size:12px;color:var(--muted)}.template-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.template-button{border:1px solid var(--line);background:#f8faf9;color:var(--ink);padding:10px 11px;text-align:left}.template-button b{display:block;font-size:13px}.template-button span{display:block;color:var(--muted);font-size:11px;font-weight:500;margin-top:2px}.template-button:hover,.template-button[aria-pressed=true]{border-color:#82a493;background:var(--accent-soft);color:#174f3b}.template-button[aria-pressed=true] b:after{content:' ✓'}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.wide{grid-column:1/-1}.preset-tags{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 12px}.tag-choice{border:1px solid var(--line-strong);background:#fff;color:#4c5953;padding:6px 10px;font-size:12px}.tag-choice:hover,.tag-choice[aria-pressed=true]{border-color:#6d9b84;background:var(--accent-soft);color:#174f3b}.checkline{display:flex;gap:16px;margin:17px 0}.checkline label{display:flex;align-items:center;gap:7px;font-weight:650}.drawer-actions{display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line);padding-top:18px;margin-top:23px}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,27,21,.5);display:grid;place-items:center;padding:22px;overflow:auto;z-index:20}.modal{width:min(420px,100%);max-height:calc(100dvh - 44px);overflow:auto;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:24px}.modal-kicker{font-size:11px;color:var(--danger);font-weight:750;letter-spacing:.1em}.modal h2{font-size:22px;letter-spacing:-.025em;margin:8px 0}.modal p{color:var(--muted);margin:0;line-height:1.7}.modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:23px}
@media(max-width:900px){.login{grid-template-columns:1fr}.login-story{display:none}.login-mobile-brand{display:block;margin-bottom:32px;color:var(--ink)}.admin{display:block}.rail{height:auto;position:static;padding:16px 18px;flex-direction:row;align-items:center;gap:18px}.rail .brand{margin:0;padding:0}.nav-label,.nav-item,.rail-meta{display:none}.rail-foot{margin:0 0 0 auto;border:0;padding:0;display:flex;align-items:center;gap:11px}.rail-user{max-width:190px}.ghost-dark{margin:0;width:auto}.workspace{padding:24px 16px 42px}.accounts{min-width:820px}.accounts th,.accounts td{padding-left:10px;padding-right:10px}.ops-grid,.configuration-grid,.module-update-form{grid-template-columns:1fr}.module-update-form .wide{grid-column:auto}.configuration-card.wide{grid-column:auto}.service-editor{grid-template-columns:1fr 1fr}.park-forms{grid-template-columns:1fr}}@media(max-width:620px){.login-side{padding:28px 20px}.topbar,.configuration-head{align-items:flex-start;flex-direction:column}.topbar .primary{width:100%}.summary-strip{grid-template-columns:1fr 1fr}.summary-item:nth-child(3){border-left:0;border-top:1px solid var(--line)}.summary-item:nth-child(4){border-top:1px solid var(--line)}.toolbar{align-items:stretch;flex-direction:column}.result-count{padding-left:2px}.drawer{padding:23px 18px}.template-grid,.form-grid,.compact-form,.compact-form.three,.park-invite,.service-editor,.module-update-actions{grid-template-columns:1fr}.wide{grid-column:auto}.invite-row{align-items:flex-start;flex-direction:column}.invite-actions{justify-content:flex-start}.invite-code{font-size:27px}}@media(max-height:620px){.login-side{place-items:start center}.modal-backdrop{place-items:start center}}
</style></head><body>
<main id="loginView" class="login">
  <section class="login-story"><div class="brand">otto<span class="brand-mark">✦</span></div><div class="story-copy"><div class="eyebrow" style="color:#65d6ad">ENTERPRISE IDENTITY</div><h1>让每个数字同事，都有清晰的身份。</h1><p>集中维护企业成员、部门、职责标签与管理权限。手机号验证码只用于首次注册，之后使用账号或手机号和密码登录。</p></div><div class="signal"><b></b> 企业身份服务在线</div></section>
  <section class="login-side"><form id="loginForm" class="login-card" aria-busy="false"><div class="login-mobile-brand brand">otto<span class="brand-mark">✦</span></div><div class="eyebrow">ADMIN CONSOLE</div><h2>管理员登录</h2><p>使用管理员账号或手机号进入企业身份目录。普通成员无法访问此页面。</p><div class="field"><label for="username">账号或手机号</label><input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></div><div class="field"><label for="password">密码</label><div class="password-wrap"><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required><button id="togglePassword" class="password-toggle" type="button" aria-controls="password" aria-pressed="false">显示</button></div></div><button id="loginButton" class="primary" type="submit">进入管理后台</button><div id="loginStatus" class="sr-only" aria-live="polite"></div><div id="loginError" class="error hidden" role="alert"></div><a class="platform-link" href="/enterprise/admin/platform">平台多企业管理</a></form></section>
</main>
<main id="adminView" class="admin hidden">
  <aside class="rail"><div class="brand">otto<span class="brand-mark">✦</span></div><div class="nav-label">企业管理</div><div class="nav-item"><span class="nav-dot"></span>成员与用量</div><div class="rail-foot"><div><div id="railUser" class="rail-user"></div><div id="railMeta" class="rail-meta">企业管理员</div></div><button id="logoutButton" class="ghost-dark" type="button">退出登录</button></div></aside>
  <section class="workspace"><header class="topbar"><div><div class="eyebrow">ORGANIZATION CONTROL</div><h1 id="organizationTitle" tabindex="-1">企业账号</h1><p>成员、注册入口、职责标签与 AI 用量都只属于当前企业。</p></div><div><a class="secondary" href="/enterprise/park-admin">园区服务后台</a> <a class="secondary" href="/enterprise/admin/platform">多企业管理</a> <a class="secondary" href="/enterprise/admin/credits">积分管理</a> <a class="secondary" href="/enterprise/dashboard">老板看板</a> <button id="createButton" class="primary" type="button">新增账号</button></div></header>
    <div class="ops-grid">
      <section class="ops-card" aria-labelledby="inviteTitle"><div class="ops-head"><div><div class="eyebrow">MEMBER ONBOARDING</div><h2 id="inviteTitle">企业成员引入链接</h2><p>成员点击后由 Otto 打开首次注册并自动填入企业信息；精确有效 7 天，生成新链接会立即废止旧链接。</p></div><span id="inviteBadge" class="badge off">尚未生成</span></div><div class="invite-row"><div><input id="inviteCode" class="invite-code" aria-label="当前企业邀请码" value="••••-••••" readonly><div class="invite-meta"><span id="inviteCountdown" class="sub">等待管理员生成</span></div><input id="inviteLinkPreview" class="invite-link-preview hidden" aria-label="当前企业引入链接" value="" readonly></div><div class="invite-actions"><button id="copyInviteLink" class="primary" type="button" disabled>复制企业引入链接</button><button id="copyInvite" class="copy" type="button" disabled>复制邀请码</button><button id="issueInvite" class="secondary" type="button">生成引入链接</button></div></div><div id="inviteError" class="error hidden" role="alert"></div></section>
      <section class="ops-card" aria-labelledby="usageTitle"><div class="ops-head"><div><div class="eyebrow">AI CONSUMPTION</div><h2 id="usageTitle">近 30 天 Token</h2><p>按登录账号汇总模型返回的用量。</p></div><span class="badge">客户端回传</span></div><div id="totalTokens" class="token-number">0</div><div class="token-split"><span>输入 <b id="inputTokens">0</b></span><span>输出 <b id="outputTokens">0</b></span><span>请求 <b id="requestCount">0</b></span></div><div class="token-note">用于企业内部用量观察，不等同于模型供应商的计费账单。</div></section>
    </div>
    <section class="configuration-shell" aria-labelledby="configurationTitle">
      <div class="configuration-head"><div><div class="eyebrow">ORGANIZATION SETTINGS</div><h2 id="configurationTitle">企业与产业园管理</h2></div><div id="configurationStatus" class="configuration-status" role="status" aria-live="polite"></div></div>
      <div id="configurationError" class="error hidden" role="alert"></div>
      <div class="configuration-grid">
        <article class="configuration-card" aria-labelledby="featureTitle"><h3 id="featureTitle">功能开关</h3><p>关闭后服务端与界面同时失效，不仅隐藏按钮。</p><div id="featureSwitches" class="switch-list"></div></article>
        <article class="configuration-card wide" aria-labelledby="moduleUpdateTitle"><h3 id="moduleUpdateTitle">模块化更新</h3><p>发布增量 manifest 后，已登录 Otto 客户端会自动轮询并触发更新检查；关闭模块会从客户端清单中移除。</p>
          <form id="moduleUpdateForm" class="module-update-form">
            <div class="field"><label for="moduleUpdateModule">模块</label><select id="moduleUpdateModule" required></select></div>
            <div class="field"><label for="moduleUpdateVersion">版本</label><input id="moduleUpdateVersion" maxlength="80" required placeholder="例如：1.9.5-park.2"></div>
            <div class="field"><label for="moduleUpdateRollout">推送策略</label><select id="moduleUpdateRollout"><option value="canary">灰度</option><option value="stable">稳定</option><option value="required">强制</option></select></div>
            <div class="field"><label for="moduleUpdateMinAppVersion">最低 Otto 版本</label><input id="moduleUpdateMinAppVersion" maxlength="40" placeholder="例如：1.9.5"></div>
            <div class="field wide"><label for="moduleUpdateManifestUrl">增量 manifest URL</label><input id="moduleUpdateManifestUrl" type="url" placeholder="https://example.com/otto-incremental.json"></div>
            <div class="field wide"><label for="moduleUpdateSha256">SHA256</label><input id="moduleUpdateSha256" maxlength="64" placeholder="64 位校验值，可选"></div>
            <div class="field wide"><label for="moduleUpdateNotes">发布说明</label><input id="moduleUpdateNotes" maxlength="200" placeholder="给管理员看的变更摘要"></div>
            <div class="module-update-actions"><button class="primary" type="submit">发布模块</button><button id="moduleUpdateDisable" class="secondary" type="button">关闭该模块</button></div>
          </form>
          <div id="moduleUpdateList" class="module-update-list"></div>
        </article>
        <article id="structureCard" class="configuration-card" aria-labelledby="structureTitle"><h3 id="structureTitle">部门与职位管理</h3><p>自定义部门和职位，职位权限会同步到已绑定成员。</p><form id="departmentForm" class="compact-form"><div class="field"><label for="newDepartmentName">新部门名称</label><input id="newDepartmentName" maxlength="80" required placeholder="例如：产品部"></div><button class="primary" type="submit">新增部门</button></form><div id="structureList" class="structure-list"></div></article>
        <article id="structureDisabled" class="configuration-card hidden"><h3>企业树已关闭</h3><div class="configuration-disabled">当前不加载部门与职位数据。在功能开关中重新启用后才会恢复。</div></article>
        <article id="parkCard" class="configuration-card wide" aria-labelledby="parkTitle"><h3 id="parkTitle">产业园管理</h3><p>产业园方可发放邀请码、管理服务和指定专员；普通企业填写邀请码后整体加入。</p>
          <div id="parkEmptyControls" class="park-forms">
            <form id="parkJoinForm" class="park-form"><h4>加入已有产业园</h4><p>使用产业园管理方发来的 12 位大小写敏感邀请码，并填写企业在园区内的地址和门牌号。</p><div class="field"><label for="parkJoinCode">产业园邀请码</label><input id="parkJoinCode" autocomplete="off" required placeholder="Aa3B-k9Pq-Z7xY"></div><div class="field"><label for="parkJoinAddress">企业地址</label><input id="parkJoinAddress" maxlength="160" required placeholder="例如：科技大厦 A 座"></div><div class="field"><label for="parkJoinRoomNumber">门牌号</label><input id="parkJoinRoomNumber" maxlength="40" required placeholder="例如：1203 室"></div><button class="primary" type="submit">整个企业加入</button></form>
            <div class="park-form"><h4>产业园端认证</h4><p>创建产业园端需要平台管理员在多企业管理页面认证当前企业。未认证企业不能发布园区公告、管理服务或邀请其他企业。</p></div>
          </div>
          <div id="parkDetails" class="hidden"><div id="parkSummary" class="park-summary"></div><div id="parkTenantNote" class="configuration-disabled hidden">当前企业已加入该产业园。服务与专员由产业园管理方统一配置。</div><div id="parkOwnerControls" class="hidden"><form id="parkInviteForm" class="park-invite"><div class="field"><label for="parkInviteCode">最新产业园邀请码</label><input id="parkInviteCode" readonly placeholder="点击生成"></div><div class="field"><label for="parkInviteMax">可使用次数</label><input id="parkInviteMax" type="number" min="1" max="10000" placeholder="不限"></div><button class="primary" type="submit">生成邀请码</button></form><div id="serviceList" class="service-list"></div></div></div>
        </article>
        <article id="parkDisabled" class="configuration-card wide hidden"><h3>园区服务已关闭</h3><div class="configuration-disabled">当前不加载产业园、服务和专员数据。重新启用后才会恢复。</div></article>
      </div>
    </section>
    <div class="summary-strip" aria-label="账号摘要"><div class="summary-item"><strong id="allCount">0</strong><span>全部账号</span></div><div class="summary-item"><strong id="activeCount">0</strong><span>可登录</span></div><div class="summary-item"><strong id="smsCount">0</strong><span>已绑定手机</span></div><div class="summary-item"><strong id="itCount">0</strong><span>维修工作人员</span></div></div>
    <div class="toolbar"><div class="search-wrap"><input id="searchInput" class="search" aria-label="搜索账号" placeholder="搜索姓名、账号、手机号、部门或标签"></div><div id="resultCount" class="result-count" role="status" aria-live="polite" aria-atomic="true">0 个账号</div></div>
    <div class="table-wrap"><table class="accounts"><thead><tr><th scope="col">账号</th><th scope="col">职位 / 部门</th><th scope="col">职责标签</th><th scope="col">30 天 Token</th><th scope="col">权限</th><th scope="col">状态</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody id="accountRows"></tbody></table></div><div id="pageError" class="error hidden" role="alert"></div>
  </section>
</main>
<div id="drawerWrap" class="drawer-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"><form id="accountForm" class="drawer" aria-busy="false"><div class="drawer-head"><div><div class="eyebrow">ACCOUNT DETAIL</div><h2 id="drawerTitle">新增账号</h2></div><button id="closeDrawer" class="close" type="button" aria-label="关闭账号表单">×</button></div><input id="accountId" type="hidden">
  <section class="form-section" aria-labelledby="templateTitle"><div class="section-head"><strong id="templateTitle">账户模板</strong><span>选择后仍可继续调整</span></div><div class="template-grid">
    <button class="template-button" type="button" data-account-template="member" aria-pressed="false"><b>普通成员</b><span>基础协作与日常任务</span></button>
    <button class="template-button" type="button" data-account-template="lead" aria-pressed="false"><b>部门负责人</b><span>部门管理与审批职责</span></button>
    <button class="template-button" type="button" data-account-template="it" aria-pressed="false"><b>维修工作人员</b><span>自动接收园区报修</span></button>
    <button class="template-button" type="button" data-account-template="service" aria-pressed="false"><b>园区客服人员</b><span>自动接收六类园区申请</span></button>
    <button class="template-button" type="button" data-account-template="finance" aria-pressed="false"><b>财务审批</b><span>财务流程与审批职责</span></button>
    <button class="template-button" type="button" data-account-template="admin" aria-pressed="false"><b>系统管理员</b><span>完整后台管理权限</span></button>
  </div></section>
  <section class="form-section"><div class="section-head"><strong>基本信息</strong><span>姓名与手机号用于识别成员</span></div><div class="form-grid">
    <div class="field"><label for="editUsername">用户名</label><input id="editUsername" autocomplete="off" required></div><div class="field"><label for="editName">姓名</label><input id="editName" autocomplete="off" required></div>
    <div class="field wide"><label for="editPhone">手机号码</label><input id="editPhone" inputmode="tel" autocomplete="tel" pattern="(?:\\+?86(?: |-)?)?1[3-9](?:(?: |-)?[0-9]){9}" aria-describedby="phoneHint" placeholder="13800138000"><small id="phoneHint" class="sub">中国大陆手机号，可留空</small></div>
    <div class="field wide"><label for="editFeishuOpenId">飞书 open_id</label><input id="editFeishuOpenId" autocomplete="off" placeholder="ou_xxx"><small class="sub">用于向该维修人员发送飞书私聊通知</small></div>
    <div class="field"><label for="editRole">角色权限</label><input id="editRole" placeholder="由真实职位权限映射决定"></div><div class="field"><label for="editDepartmentId">真实部门</label><select id="editDepartmentId"><option value="">未安排</option></select><input id="editDepartment" type="hidden"><datalist id="departmentPresetList"></datalist></div>
    <div class="field wide"><label for="editPositionId">真实职位 / 岗位</label><select id="editPositionId"><option value="">请先选择部门</option></select><input id="editPositionTitle" type="hidden"><small class="sub">自定义职位请先在上方“部门与职位管理”创建；任命后由职位权限映射自动升/降权。</small></div>
    <div class="field wide"><label for="editAvatarUrl">头像地址</label><input id="editAvatarUrl" autocomplete="url" placeholder="https://... 或小于 512KB 的 data:image"><small class="sub">支持 HTTPS 或 PNG/JPEG/WebP/GIF data:image</small></div>
  </div></section>
  <section class="form-section"><div class="section-head"><strong>预设标签</strong><span>可多选，也可输入自定义标签</span></div><div id="tagPresets" class="preset-tags" aria-label="预设标签"></div><div class="field"><label for="editTags">自定义标签（用逗号分隔）</label><input id="editTags" placeholder="例如：产品, 审批, 夜班"></div></section>
  <section class="form-section"><div class="section-head"><strong>登录与权限</strong><span>新增账号必须设置密码</span></div><div class="form-grid"><div class="field wide"><label for="editPassword">登录密码</label><input id="editPassword" type="password" minlength="8" autocomplete="new-password" aria-describedby="passwordHint"><small id="passwordHint" class="sub">至少 8 位</small></div><div class="field"><label for="editStatus">账号状态</label><select id="editStatus"><option value="active">可登录</option><option value="disabled">已停用</option></select></div></div><div class="checkline"><label><input id="editRepairWorker" type="checkbox"> 设为维修工作人员（自动接收报修）</label><label><input id="editServiceWorker" type="checkbox"> 设为园区客服人员（自动接收六类申请）</label><label><input id="editAdmin" type="checkbox"> 允许访问管理员后台</label></div></section>
  <div id="formError" class="error hidden" role="alert"></div><div id="saveStatus" class="sr-only" role="status" aria-live="polite"></div><div class="drawer-actions"><button id="deleteAccount" class="danger hidden" type="button">删除账号</button><span style="flex:1"></span><button id="cancelEdit" class="secondary" type="button">取消</button><button id="saveAccount" class="primary" type="submit">保存账号</button></div>
</form></div>
<div id="logoutModal" class="modal-backdrop hidden"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="logoutTitle"><div class="modal-kicker">SECURITY CHECK</div><h2 id="logoutTitle">确认退出管理员后台</h2><p>退出后需要重新输入管理员用户名和密码。未保存的账号修改不会保留。</p><div class="modal-actions"><button id="cancelLogout" class="secondary" type="button">取消</button><button id="confirmLogout" class="danger" type="button">确认退出</button></div></section></div>
<div id="inviteModal" class="modal-backdrop hidden"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="inviteConfirmTitle"><div class="modal-kicker">POSITION ONBOARDING</div><h2 id="inviteConfirmTitle">生成新的岗位邀请码？</h2><p>新链接将在生成时开始计时，7 天后失效。当前仍有效的链接会立即作废，已发出的旧链接将无法用于首次注册。</p><div class="field"><label for="inviteDepartment">新成员默认加入部门</label><input id="inviteDepartment" list="departmentPresetList" placeholder="不指定则为未分配部门"></div><div class="field"><label for="invitePosition">职位 / 岗位</label><input id="invitePosition" placeholder="例如：品牌运营"></div><div class="field"><label for="inviteRole">角色权限</label><input id="inviteRole" placeholder="默认：成员"></div><div class="field"><label for="inviteMaxUses">可注册人数</label><input id="inviteMaxUses" type="number" min="1" max="10000" placeholder="不填则不限"></div><div class="modal-actions"><button id="cancelInvite" class="secondary" type="button">取消</button><button id="confirmInvite" class="primary" type="button">确认生成</button></div></section></div>
<script>
const KEY='otto.enterprise.admin.session';
const departmentPresets=['总经办','人力资源部','财务部','法务部','销售部','市场部','产品部','研发部','设计部','IT部','客户成功部','采购部'];
const tagPresets=['普通成员','部门负责人','行政','人事','财务','审批','法务','销售','市场','产品','研发','设计','IT','报修','维修工作人员','客服人员','客户支持','采购','数据','夜班'];
const accountTemplates={
  member:{role:'成员',department:'',tags:['普通成员'],isAdmin:false},
  lead:{role:'部门负责人',department:'',tags:['部门负责人','审批'],isAdmin:false},
  it:{role:'IT 支持',department:'IT部',tags:['IT','报修','维修工作人员'],isAdmin:false},
  service:{role:'园区客服',department:'客户成功部',tags:['客服人员','客户支持'],isAdmin:false},
  finance:{role:'财务审批',department:'财务部',tags:['财务','审批'],isAdmin:false},
  admin:{role:'系统管理员',department:'IT部',tags:['系统管理员','IT'],isAdmin:true}
};
const featureDefinitions={
  enterprise_tree:['企业树','成员、部门与职位目录'],
  park_service:['园区服务','产业园入驻、服务与报修路由'],
  feishu_auto_reply:['飞书自动回复','飞书向 Otto 提问后自动执行并回复'],
  direct_messages:['企业内部消息','成员直聊与未读提醒'],
  atoa:['A2A 协作','数字同事之间的任务转交'],
  knowledge:['企业知识','按企业与部门范围使用知识库']
};
let token=sessionStorage.getItem(KEY)||'';
let currentAdmin=null;
let accounts=[];
let currentInvite=null;
let usageSummary=null;
let organizationFeatures=null;
let organizationStructure=[];
let moduleUpdateManifest=null;
let currentPark=null;
let parkServices=[];
let parkSpecialists=[];
let inviteTimer=null;
let authEpoch=0;
let editorEpoch=0;
let isSaving=false;
let deleteArmed=false;
let activeOverlay=null;
let overlayReturnFocus=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showError(id,message){const el=$(id);el.textContent=message||'';el.classList.toggle('hidden',!message)}
function focusSoon(element){requestAnimationFrame(()=>{if(element&&element.isConnected&&!element.disabled&&!element.closest('.hidden'))element.focus()})}
function setLoginPending(pending){$('loginForm').setAttribute('aria-busy',pending?'true':'false');$('loginButton').disabled=pending;$('loginButton').textContent=pending?'正在验证…':'进入管理后台';$('loginStatus').textContent=pending?'正在验证管理员身份':''}
function setPasswordVisible(visible){$('password').type=visible?'text':'password';$('togglePassword').textContent=visible?'隐藏':'显示';$('togglePassword').setAttribute('aria-pressed',visible?'true':'false')}
function beginAuth(){authEpoch+=1;return authEpoch}
async function api(path,options){const requestToken=token;const o=Object.assign({},options||{});o.headers=Object.assign({'content-type':'application/json'},o.headers||{},requestToken?{authorization:'Bearer '+requestToken}:{});const response=await fetch(path,o);const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||('请求失败 '+response.status));error.status=response.status;error.requestToken=requestToken;throw error}return data}
function isAuthorizationError(error){return !!error&&(error.status===401||error.status===403)}
function setConfigurationStatus(message){$('configurationStatus').textContent=message||''}
function configurationFailure(error){if(isAuthorizationError(error)){expireAdminSession('登录已失效，请重新登录',error.requestToken);return}showError('configurationError',error&&error.message?error.message:'配置请求失败')}
function updateDepartmentDatalist(){const names=departmentPresets.concat(organizationStructure.map(department=>department.name));$('departmentPresetList').innerHTML=Array.from(new Set(names)).map(item=>'<option value="'+esc(item)+'"></option>').join('')}
function renderConfigurationAvailability(){const treeEnabled=organizationFeatures&&organizationFeatures.enterprise_tree===true;const parkEnabled=organizationFeatures&&organizationFeatures.park_service===true;$('structureCard').classList.toggle('hidden',!treeEnabled);$('structureDisabled').classList.toggle('hidden',treeEnabled);$('parkCard').classList.toggle('hidden',!parkEnabled);$('parkDisabled').classList.toggle('hidden',parkEnabled)}
function renderFeatureSwitches(){const host=$('featureSwitches');if(!organizationFeatures){host.innerHTML='<div class="configuration-disabled">正在加载功能开关…</div>';return}host.innerHTML=Object.entries(featureDefinitions).map(entry=>{const key=entry[0],copy=entry[1];return '<label class="switch-row"><span class="switch-copy"><b>'+esc(copy[0])+'</b><span>'+esc(copy[1])+'</span></span><input type="checkbox" data-feature-key="'+esc(key)+'" '+(organizationFeatures[key]?'checked':'')+' aria-label="'+esc(copy[0])+'"></label>'}).join('');host.querySelectorAll('[data-feature-key]').forEach(input=>input.addEventListener('change',()=>updateFeature(input.dataset.featureKey,input.checked,input)))}
function moduleUpdateLabel(key){return (featureDefinitions[key]&&featureDefinitions[key][0])||key}
function activeModuleUpdates(){return moduleUpdateManifest&&Array.isArray(moduleUpdateManifest.modules)?moduleUpdateManifest.modules:[]}
function moduleUpdateCatalog(){const catalog=moduleUpdateManifest&&Array.isArray(moduleUpdateManifest.catalog)?moduleUpdateManifest.catalog:[];const modules=activeModuleUpdates().map(item=>({module:item.module,features:[]}));return Array.from(new Map(catalog.concat(modules).map(item=>[item.module,item])).values())}
function fillModuleUpdateForm(){const selected=$('moduleUpdateModule').value;const update=activeModuleUpdates().find(item=>item.module===selected);if(!update)return;$('moduleUpdateVersion').value=update.version||'';$('moduleUpdateRollout').value=update.rollout||'stable';$('moduleUpdateManifestUrl').value=update.manifestUrl||'';$('moduleUpdateSha256').value=update.sha256||'';$('moduleUpdateMinAppVersion').value=update.minAppVersion||'';$('moduleUpdateNotes').value=update.notes||''}
function renderModuleUpdates(){const list=$('moduleUpdateList'),select=$('moduleUpdateModule');if(!moduleUpdateManifest){list.innerHTML='<div class="configuration-disabled">正在加载模块更新配置…</div>';select.innerHTML='';return}const selected=select.value;const catalog=moduleUpdateCatalog();select.innerHTML=catalog.map(item=>'<option value="'+esc(item.module)+'">'+esc(moduleUpdateLabel(item.module))+' · '+esc(item.module)+'</option>').join('');if(selected&&catalog.some(item=>item.module===selected))select.value=selected;if(!catalog.length){list.innerHTML='<div class="configuration-disabled">当前授权目录里没有可发布的模块。</div>';return}const updates=new Map(activeModuleUpdates().map(item=>[item.module,item]));list.innerHTML=catalog.map(item=>{const update=updates.get(item.module);const rollout=update?update.rollout:'off';return '<section class="module-update-row"><div class="module-update-head"><div><b>'+esc(moduleUpdateLabel(item.module))+'</b><div class="role-note">'+esc(item.module)+'</div></div><span class="badge '+(rollout==='off'?'off':'ok')+'">'+esc(rollout==='off'?'未发布':rollout)+'</span></div><div class="module-update-meta">版本：'+esc(update&&update.version?update.version:'-')+' · 最低版本：'+esc(update&&update.minAppVersion?update.minAppVersion:'-')+' · 更新时间：'+esc(update&&update.updatedAt?new Date(update.updatedAt).toLocaleString('zh-CN',{hour12:false}):'-')+'</div><div class="module-update-meta">'+esc(update&&update.manifestUrl?update.manifestUrl:'暂无 manifest URL')+'</div>'+(update&&update.notes?'<div class="module-update-meta">'+esc(update.notes)+'</div>':'')+'</section>'}).join('');fillModuleUpdateForm()}
async function loadModuleUpdates(){try{moduleUpdateManifest=await api('/enterprise/modules/updates');renderModuleUpdates()}catch(error){moduleUpdateManifest={modules:[],catalog:[]};renderModuleUpdates();throw error}}
async function publishModuleUpdate(event){event.preventDefault();const module=$('moduleUpdateModule').value;const version=$('moduleUpdateVersion').value.trim();if(!module||!version)return;showError('configurationError','');setConfigurationStatus('正在发布模块更新…');try{const data=await api('/enterprise/modules/updates',{method:'PATCH',body:JSON.stringify({module,version,rollout:$('moduleUpdateRollout').value,manifestUrl:$('moduleUpdateManifestUrl').value.trim()||null,sha256:$('moduleUpdateSha256').value.trim()||null,minAppVersion:$('moduleUpdateMinAppVersion').value.trim()||null,notes:$('moduleUpdateNotes').value.trim()||null})});moduleUpdateManifest=data.manifest;renderModuleUpdates();setConfigurationStatus('模块更新已发布，客户端会在下一轮检查中发现')}catch(error){configurationFailure(error);setConfigurationStatus('')}}
async function disableModuleUpdate(){const module=$('moduleUpdateModule').value;if(!module)return;const existing=activeModuleUpdates().find(item=>item.module===module);const version=$('moduleUpdateVersion').value.trim()||(existing&&existing.version)||'disabled';showError('configurationError','');setConfigurationStatus('正在关闭模块发布…');try{const data=await api('/enterprise/modules/updates',{method:'PATCH',body:JSON.stringify({module,version,rollout:'off'})});moduleUpdateManifest=data.manifest;renderModuleUpdates();setConfigurationStatus('该模块发布已关闭')}catch(error){configurationFailure(error);setConfigurationStatus('')}}
async function updateFeature(key,enabled,input){input.disabled=true;showError('configurationError','');setConfigurationStatus('正在保存功能开关…');try{const data=await api('/enterprise/organization/features',{method:'PATCH',body:JSON.stringify({[key]:enabled})});organizationFeatures=data.features;renderFeatureSwitches();renderConfigurationAvailability();if(key==='enterprise_tree'){organizationStructure=[];if(enabled)await loadStructure();else renderStructure()}if(key==='park_service'){currentPark=null;parkServices=[];parkSpecialists=[];if(enabled)await loadPark();else renderPark()}setConfigurationStatus('功能开关已保存')}catch(error){renderFeatureSwitches();configurationFailure(error);setConfigurationStatus('')}finally{if(input&&input.isConnected)input.disabled=false}}
function roleMappingLabel(value){return value==='enterprise_admin'?'企业管理员':value==='department_admin'?'部门管理员':'成员'}
function renderStructure(){updateDepartmentDatalist();const host=$('structureList');if(!organizationFeatures||organizationFeatures.enterprise_tree!==true){host.replaceChildren();return}if(!organizationStructure.length){host.innerHTML='<div class="configuration-disabled">暂无部门。新建第一个部门后，可继续添加职位。</div>';return}host.innerHTML=organizationStructure.map(department=>'<section class="department-row" data-department-id="'+esc(department.id)+'"><div class="department-head"><div><b>'+esc(department.name)+'</b><div class="role-note">'+number(department.memberCount)+' 名在职成员</div></div><div class="row-actions"><button class="edit" type="button" data-rename-department="'+esc(department.id)+'">重命名</button><button class="danger" type="button" data-delete-department="'+esc(department.id)+'">删除</button></div></div><div class="position-list">'+((department.positions||[]).map(position=>'<div class="position-row"><div class="position-head"><div><b>'+esc(position.title)+'</b><div class="role-note">'+esc(roleMappingLabel(position.roleMapping))+'</div></div><div class="row-actions"><button class="edit" type="button" data-edit-position="'+esc(position.id)+'" data-position-title="'+esc(position.title)+'" data-role-mapping="'+esc(position.roleMapping)+'">编辑</button><button class="danger" type="button" data-delete-position="'+esc(position.id)+'">删除</button></div></div></div>').join('')||'<div class="role-note">尚未配置职位</div>')+'</div><form class="compact-form three" data-position-form="'+esc(department.id)+'"><div class="field"><label>职位名称</label><input name="title" maxlength="80" required placeholder="例如：产品经理"></div><div class="field"><label>权限映射</label><select name="roleMapping"><option value="member">成员</option><option value="department_admin">部门管理员</option><option value="enterprise_admin">企业管理员</option></select></div><button class="secondary" type="submit">新增职位</button></form></section>').join('');host.querySelectorAll('[data-rename-department]').forEach(button=>button.addEventListener('click',()=>renameDepartment(button.dataset.renameDepartment)));host.querySelectorAll('[data-delete-department]').forEach(button=>button.addEventListener('click',()=>deleteDepartment(button.dataset.deleteDepartment)));host.querySelectorAll('[data-position-form]').forEach(form=>form.addEventListener('submit',event=>createPosition(event,form.dataset.positionForm)));host.querySelectorAll('[data-edit-position]').forEach(button=>button.addEventListener('click',()=>editPosition(button)));host.querySelectorAll('[data-delete-position]').forEach(button=>button.addEventListener('click',()=>deletePosition(button.dataset.deletePosition)))}
function renderAccountAssignmentSelectors(preferredDepartmentId,preferredPositionId,applyMapping){const departmentSelect=$('editDepartmentId'),positionSelect=$('editPositionId');const byName=organizationStructure.find(item=>item.name===$('editDepartment').value);const department=organizationStructure.find(item=>item.id===preferredDepartmentId)||byName||null;departmentSelect.innerHTML='<option value="">未安排</option>'+organizationStructure.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.name)+'</option>').join('');departmentSelect.value=department?department.id:'';$('editDepartment').value=department?department.name:'';const byTitle=department&&department.positions.find(item=>item.title===$('editPositionTitle').value);const position=department&&(department.positions.find(item=>item.id===preferredPositionId)||byTitle)||null;positionSelect.innerHTML='<option value="">'+(department?'请选择职位':'请先选择部门')+'</option>'+(department?department.positions.map(item=>'<option value="'+esc(item.id)+'">'+esc(item.title)+' · '+esc(roleMappingLabel(item.roleMapping))+'</option>').join(''):'');positionSelect.value=position?position.id:'';$('editPositionTitle').value=position?position.title:'';if(applyMapping&&position){$('editRole').value=roleMappingLabel(position.roleMapping);$('editAdmin').checked=position.roleMapping==='enterprise_admin'}clearTemplateSelection()}
async function loadStructure(){if(!organizationFeatures||organizationFeatures.enterprise_tree!==true){organizationStructure=[];renderStructure();renderAccountAssignmentSelectors('','',false);return}try{const data=await api('/enterprise/organization/departments');organizationStructure=Array.isArray(data.structure)?data.structure:[];renderStructure();renderAccountAssignmentSelectors($('editDepartmentId').value,$('editPositionId').value,false)}catch(error){organizationStructure=[];renderStructure();renderAccountAssignmentSelectors('','',false);throw error}}
async function createDepartment(event){event.preventDefault();const input=$('newDepartmentName');const name=input.value.trim();if(!name)return;setConfigurationStatus('正在新增部门…');showError('configurationError','');try{await api('/enterprise/organization/departments',{method:'POST',body:JSON.stringify({name})});input.value='';await loadStructure();setConfigurationStatus('部门已新增')}catch(error){configurationFailure(error);setConfigurationStatus('')}}
async function renameDepartment(id){const department=organizationStructure.find(item=>item.id===id);if(!department)return;const name=window.prompt('输入新部门名称',department.name);if(!name||!name.trim()||name.trim()===department.name)return;try{await api('/enterprise/organization/departments/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({name:name.trim()})});await loadStructure();await loadWorkspaceWithFeedback(authEpoch,currentAdmin.organizationId);setConfigurationStatus('部门名称已更新')}catch(error){configurationFailure(error)}}
async function deleteDepartment(id){const department=organizationStructure.find(item=>item.id===id);if(!department||!window.confirm('确认删除部门“'+department.name+'”？有成员或职位时服务端会拒绝。'))return;try{await api('/enterprise/organization/departments/'+encodeURIComponent(id),{method:'DELETE'});await loadStructure();setConfigurationStatus('部门已删除')}catch(error){configurationFailure(error)}}
async function createPosition(event,departmentId){event.preventDefault();const form=event.currentTarget;const title=form.elements.title.value.trim();const roleMapping=form.elements.roleMapping.value;if(!title)return;try{await api('/enterprise/organization/positions',{method:'POST',body:JSON.stringify({departmentId,title,roleMapping})});await loadStructure();setConfigurationStatus('职位已新增')}catch(error){configurationFailure(error)}}
async function editPosition(button){const title=window.prompt('输入新职位名称',button.dataset.positionTitle);if(!title||!title.trim())return;const roleMapping=window.prompt('权限映射：member / department_admin / enterprise_admin',button.dataset.roleMapping);if(!['member','department_admin','enterprise_admin'].includes(roleMapping))return;try{await api('/enterprise/organization/positions/'+encodeURIComponent(button.dataset.editPosition),{method:'PATCH',body:JSON.stringify({title:title.trim(),roleMapping})});await loadStructure();await loadWorkspaceWithFeedback(authEpoch,currentAdmin.organizationId);setConfigurationStatus('职位与成员权限已同步')}catch(error){configurationFailure(error)}}
async function deletePosition(id){if(!window.confirm('确认删除该职位？有成员时服务端会拒绝。'))return;try{await api('/enterprise/organization/positions/'+encodeURIComponent(id),{method:'DELETE'});await loadStructure();setConfigurationStatus('职位已删除')}catch(error){configurationFailure(error)}}
function renderPark(){const empty=$('parkEmptyControls'),details=$('parkDetails'),owner=$('parkOwnerControls'),tenant=$('parkTenantNote');if(!organizationFeatures||organizationFeatures.park_service!==true){empty.classList.add('hidden');details.classList.add('hidden');return}empty.classList.toggle('hidden',!!currentPark);details.classList.toggle('hidden',!currentPark);if(!currentPark){owner.classList.add('hidden');tenant.classList.add('hidden');$('serviceList').replaceChildren();return}const isOwner=currentAdmin&&currentPark.adminOrganizationId===currentAdmin.organizationId;$('parkSummary').innerHTML='<div><strong>'+esc(currentPark.brandName||currentPark.name)+'</strong><span>'+esc(currentPark.name)+' · '+esc(currentPark.slug)+'</span></div><span class="badge '+(isOwner?'ok':'')+'">'+(isOwner?'产业园管理方':'已入驻企业')+'</span>';owner.classList.toggle('hidden',!isOwner);tenant.classList.toggle('hidden',isOwner);if(!isOwner){$('serviceList').replaceChildren();return}renderParkServices()}
function renderParkServices(){const host=$('serviceList');if(!parkServices.length){host.innerHTML='<div class="configuration-disabled">暂无可配置服务。</div>';return}const activeAccounts=accounts.filter(account=>account.status==='active');host.innerHTML=parkServices.map(service=>{const assigned=parkSpecialists.filter(item=>item.serviceId===service.id);return '<section class="service-row"><div class="service-head"><div><b>'+esc(service.name)+'</b><div class="role-note">'+esc(service.id)+'</div></div><span class="badge '+(service.enabled?'ok':'off')+'">'+(service.enabled?'已启用':'已关闭')+'</span></div><div class="service-editor"><input data-service-name="'+esc(service.id)+'" value="'+esc(service.name)+'" aria-label="'+esc(service.name)+' 名称"><label><input type="checkbox" data-service-enabled="'+esc(service.id)+'" '+(service.enabled?'checked':'')+'> 启用</label><select data-specialist-select="'+esc(service.id)+'"><option value="">选择服务专员</option>'+activeAccounts.map(account=>'<option value="'+esc(account.id)+'">'+esc(account.name)+' @'+esc(account.username)+'</option>').join('')+'</select><div class="row-actions"><button class="edit" type="button" data-save-service="'+esc(service.id)+'">保存</button><button class="secondary" type="button" data-add-specialist="'+esc(service.id)+'">添加专员</button></div></div><div class="service-specialists">'+(assigned.map(item=>'<span class="specialist-chip">'+esc(item.name)+'<button type="button" data-remove-specialist="'+esc(service.id)+'" data-account-id="'+esc(item.accountId)+'" aria-label="移除 '+esc(item.name)+'">×</button></span>').join('')||'<span class="role-note">未指定时回退通知产业园管理员</span>')+'</div></section>'}).join('');host.querySelectorAll('[data-save-service]').forEach(button=>button.addEventListener('click',()=>saveParkService(button.dataset.saveService)));host.querySelectorAll('[data-add-specialist]').forEach(button=>button.addEventListener('click',()=>addParkSpecialist(button.dataset.addSpecialist)));host.querySelectorAll('[data-remove-specialist]').forEach(button=>button.addEventListener('click',()=>removeParkSpecialist(button.dataset.removeSpecialist,button.dataset.accountId)))}
async function loadPark(){if(!organizationFeatures||organizationFeatures.park_service!==true){currentPark=null;parkServices=[];parkSpecialists=[];renderPark();return}const data=await api('/enterprise/park/manage');currentPark=data.park||null;parkServices=[];parkSpecialists=[];if(currentPark&&currentAdmin&&currentPark.adminOrganizationId===currentAdmin.organizationId){const results=await Promise.all([api('/enterprise/park/services'),api('/enterprise/park/specialists')]);parkServices=results[0].services||[];parkSpecialists=results[1].specialists||[]}renderPark()}
async function joinPark(event){event.preventDefault();const inviteCode=$('parkJoinCode').value.trim(),address=$('parkJoinAddress').value.trim(),roomNumber=$('parkJoinRoomNumber').value.trim();try{const data=await api('/enterprise/park/join',{method:'POST',body:JSON.stringify({inviteCode,address,roomNumber})});currentPark=data.park;await loadPark();setConfigurationStatus('当前企业已加入产业园')}catch(error){configurationFailure(error)}}
async function issueParkInvite(event){event.preventDefault();const raw=$('parkInviteMax').value.trim();try{const data=await api('/enterprise/park/invite',{method:'POST',body:JSON.stringify({maxUses:raw?Number(raw):null})});$('parkInviteCode').value=data.invite.code;setConfigurationStatus('产业园邀请码已生成，有效期 7 天')}catch(error){configurationFailure(error)}}
async function saveParkService(serviceId){const name=document.querySelector('[data-service-name="'+CSS.escape(serviceId)+'"]').value.trim();const enabled=document.querySelector('[data-service-enabled="'+CSS.escape(serviceId)+'"]').checked;try{await api('/enterprise/park/services',{method:'PATCH',body:JSON.stringify({serviceId,name,enabled})});await loadPark();setConfigurationStatus('园区服务已保存')}catch(error){configurationFailure(error)}}
async function addParkSpecialist(serviceId){const select=document.querySelector('[data-specialist-select="'+CSS.escape(serviceId)+'"]');if(!select||!select.value)return;try{await api('/enterprise/park/specialists',{method:'POST',body:JSON.stringify({serviceId,accountId:select.value})});await loadPark();setConfigurationStatus('服务专员已添加')}catch(error){configurationFailure(error)}}
async function removeParkSpecialist(serviceId,accountId){try{await api('/enterprise/park/specialists',{method:'DELETE',body:JSON.stringify({serviceId,accountId})});await loadPark();setConfigurationStatus('服务专员已移除')}catch(error){configurationFailure(error)}}
async function loadConfiguration(){organizationFeatures=null;organizationStructure=[];moduleUpdateManifest=null;currentPark=null;parkServices=[];parkSpecialists=[];renderFeatureSwitches();renderModuleUpdates();showError('configurationError','');setConfigurationStatus('正在加载企业配置…');try{const data=await api('/enterprise/organization/features');organizationFeatures=data.features;renderFeatureSwitches();renderConfigurationAvailability();const tasks=[loadModuleUpdates()];if(organizationFeatures.enterprise_tree===true)tasks.push(loadStructure());else renderStructure();if(organizationFeatures.park_service===true)tasks.push(loadPark());else renderPark();await Promise.all(tasks);setConfigurationStatus('')}catch(error){configurationFailure(error);setConfigurationStatus('')}}
function showLogin(message){$('adminView').classList.add('hidden');$('loginView').classList.remove('hidden');showError('loginError',message||'')}
function showAdmin(){showError('loginError','');$('loginView').classList.add('hidden');$('adminView').classList.remove('hidden');$('railUser').textContent=currentAdmin.name+' · '+currentAdmin.username;$('railMeta').textContent=currentAdmin.organizationName+' · 企业管理员';$('organizationTitle').textContent=currentAdmin.organizationName;focusSoon($('organizationTitle'))}
function tags(value){return Array.from(new Set(String(value||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean)))}
function number(value){return new Intl.NumberFormat('zh-CN').format(Number(value)||0)}
function setTags(values){const normalized=tags(values.join(', '));$('editTags').value=normalized.join(', ');$('editRepairWorker').checked=normalized.includes('维修工作人员');$('editServiceWorker').checked=normalized.includes('客服人员');updateTagPresetState()}
function updateTagPresetState(){const selected=new Set(tags($('editTags').value));document.querySelectorAll('[data-tag-preset]').forEach(button=>button.setAttribute('aria-pressed',selected.has(button.dataset.tagPreset)?'true':'false'))}
function renderPresets(){$('departmentPresetList').innerHTML=departmentPresets.map(item=>'<option value="'+esc(item)+'"></option>').join('');$('tagPresets').innerHTML=tagPresets.map(item=>'<button class="tag-choice" type="button" data-tag-preset="'+esc(item)+'" aria-pressed="false">'+esc(item)+'</button>').join('');document.querySelectorAll('[data-tag-preset]').forEach(button=>button.addEventListener('click',()=>{const selected=tags($('editTags').value);const index=selected.indexOf(button.dataset.tagPreset);if(index>=0)selected.splice(index,1);else selected.push(button.dataset.tagPreset);setTags(selected);clearTemplateSelection()}))}
function render(){const q=$('searchInput').value.trim().toLowerCase();const rows=accounts.filter(account=>!q||[account.name,account.username,account.phone,account.feishuOpenId,account.role,account.department,account.positionTitle].concat(account.tags||[]).some(value=>String(value||'').toLowerCase().includes(q)));$('allCount').textContent=String(accounts.length);$('activeCount').textContent=String(accounts.filter(account=>account.status==='active').length);$('smsCount').textContent=String(accounts.filter(account=>account.phone).length);$('itCount').textContent=String(accounts.filter(account=>(account.tags||[]).includes('维修工作人员')).length);$('resultCount').textContent=rows.length+' 个账号';$('accountRows').innerHTML=rows.length?rows.map(account=>'<tr><td><div class="name">'+esc(account.name)+'</div><div class="sub">@'+esc(account.username)+(account.phone?' · '+esc(account.phone):' · 未绑定手机')+(account.feishuOpenId?' · 飞书已绑定':'')+'</div></td><td>'+esc(account.positionTitle||account.role||'未设置职位')+'<div class="sub">'+esc(account.department||'未分配部门')+(account.positionTitle&&account.role?' · '+esc(account.role):'')+'</div></td><td>'+((account.tags||[]).map(tag=>'<span class="tag">'+esc(tag)+'</span>').join('')||'<span class="sub">无标签</span>')+'</td><td><div class="name mono">'+number(account.usage&&account.usage.totalTokens)+'</div><div class="sub">'+number(account.usage&&account.usage.requestCount)+' 次请求</div></td><td>'+(account.isAdmin?'<span class="badge">管理员</span>':'<span class="sub">普通成员</span>')+'</td><td><span class="badge '+(account.status==='active'?'ok':'off')+'">'+(account.status==='active'?'可登录':'已停用')+'</span></td><td><button class="edit" type="button" data-assign-id="'+esc(account.id)+'" aria-label="安排职位 '+esc(account.name)+'">安排职位</button> <button class="edit" type="button" data-id="'+esc(account.id)+'" aria-label="编辑 '+esc(account.name)+'（@'+esc(account.username)+'）">编辑</button>'+(currentAdmin&&account.id!==currentAdmin.id?'<button class="danger" type="button" data-delete-id="'+esc(account.id)+'" aria-label="删除账号 '+esc(account.name)+'">删除</button>':'')+'</td></tr>').join(''):'<tr><td class="empty" colspan="7">没有匹配账号，请调整搜索条件</td></tr>';document.querySelectorAll('button[data-assign-id]').forEach(button=>button.addEventListener('click',()=>openEditor(accounts.find(account=>account.id===button.dataset.assignId),button,true)));document.querySelectorAll('button[data-id]').forEach(button=>button.addEventListener('click',()=>openEditor(accounts.find(account=>account.id===button.dataset.id),button,false)));document.querySelectorAll('button[data-delete-id]').forEach(button=>button.addEventListener('click',()=>deleteAccountFromRow(button,button.dataset.deleteId)))}
async function deleteAccountFromRow(button,id){if(!id||isSaving)return;if(button.dataset.armed!=='true'){button.dataset.armed='true';button.textContent='再次确认';setTimeout(()=>{if(button.isConnected){button.dataset.armed='false';button.textContent='删除'}},5000);return}const requestToken=token;const organizationId=currentAdmin&&currentAdmin.organizationId;button.disabled=true;try{await api('/enterprise/accounts/'+encodeURIComponent(id),{method:'DELETE'});if(requestToken!==token)return;accounts=accounts.filter(account=>account.id!==id);render();$('saveStatus').textContent='账号已删除，原登录会话已撤销';if(organizationId)void loadWorkspaceWithFeedback(authEpoch,organizationId)}catch(error){if(isAuthorizationError(error)){expireAdminSession('登录已失效，请重新登录',error.requestToken);return}showError('pageError',error.message)}finally{if(button.isConnected)button.disabled=false}}
function renderUsage(){const summary=usageSummary||{};$('totalTokens').textContent=number(summary.totalTokens);$('inputTokens').textContent=number(summary.totalInputTokens);$('outputTokens').textContent=number(summary.totalOutputTokens);$('requestCount').textContent=number(summary.requestCount)}
function registrationInviteLink(){return currentInvite&&typeof currentInvite.link==='string'?currentInvite.link:''}
function renderInvite(){if(inviteTimer){clearInterval(inviteTimer);inviteTimer=null}const active=currentInvite&&currentInvite.status==='active'&&new Date(currentInvite.expiresAt).getTime()>Date.now();const link=active?registrationInviteLink():'';$('inviteCode').value=currentInvite?currentInvite.code:'••••-••••';$('copyInvite').disabled=!active;$('copyInviteLink').disabled=!active;$('inviteLinkPreview').value=link;$('inviteLinkPreview').classList.toggle('hidden',!link);if(currentInvite&&$('inviteDepartment'))$('inviteDepartment').value=currentInvite.defaultDepartment||'';if(currentInvite&&$('invitePosition'))$('invitePosition').value=currentInvite.positionTitle||'';if(currentInvite&&$('inviteRole'))$('inviteRole').value=currentInvite.defaultRole||'';if(currentInvite&&$('inviteMaxUses'))$('inviteMaxUses').value=currentInvite.maxUses||'';$('issueInvite').textContent=currentInvite?'生成新邀请码':'生成岗位邀请码';$('inviteBadge').className='badge '+(active?'ok':'off');$('inviteBadge').textContent=active?'有效 7 天':currentInvite?'已失效':'尚未生成';function tick(){if(!currentInvite)return;const left=new Date(currentInvite.expiresAt).getTime()-Date.now();if(left<=0){currentInvite.status='expired';renderInvite();return}const h=Math.floor(left/3600000);const m=Math.floor((left%3600000)/60000);const s=Math.floor((left%60000)/1000);$('inviteCountdown').textContent='剩余 '+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+' · 到期 '+new Date(currentInvite.expiresAt).toLocaleString('zh-CN',{hour12:false})+' · 岗位 '+[currentInvite.defaultDepartment||'未分配部门',currentInvite.positionTitle||'未指定职位',currentInvite.defaultRole||'成员'].join(' / ')+(currentInvite.maxUses?' · '+currentInvite.usedCount+'/'+currentInvite.maxUses:'')}if(active){tick();inviteTimer=setInterval(tick,1000)}else $('inviteCountdown').textContent=currentInvite?'已到期，请手动生成新的岗位邀请码':'等待管理员生成'}
function resetWorkspace(){if(inviteTimer){clearInterval(inviteTimer);inviteTimer=null}accounts=[];currentInvite=null;usageSummary=null;organizationFeatures=null;organizationStructure=[];moduleUpdateManifest=null;currentPark=null;parkServices=[];parkSpecialists=[];$('searchInput').value='';showError('pageError','');showError('inviteError','');showError('configurationError','');setConfigurationStatus('');render();renderInvite();renderUsage();renderFeatureSwitches();renderModuleUpdates();renderConfigurationAvailability();renderStructure();renderPark()}
function resetDeleteButton(){deleteArmed=false;$('deleteAccount').textContent='删除账号'}
function setEditorPending(pending){const form=$('accountForm');form.setAttribute('aria-busy',pending?'true':'false');form.querySelectorAll('button,input,select').forEach(control=>{if(pending){control.dataset.pendingDisabled=control.disabled?'true':'false';control.disabled=true}else if(Object.prototype.hasOwnProperty.call(control.dataset,'pendingDisabled')){control.disabled=control.dataset.pendingDisabled==='true';delete control.dataset.pendingDisabled}});$('saveAccount').textContent=pending?'正在保存…':'保存账号';$('saveStatus').textContent=pending?'正在保存账号':''}
function closeAllOverlays(){$('drawerWrap').classList.add('hidden');$('logoutModal').classList.add('hidden');$('inviteModal').classList.add('hidden');$('adminView').inert=false;activeOverlay=null;overlayReturnFocus=null;editorEpoch+=1;if(isSaving){isSaving=false;setEditorPending(false)}}
function expireAdminSession(message,expectedToken){if(expectedToken!==undefined&&token!==expectedToken)return false;authEpoch+=1;token='';currentAdmin=null;sessionStorage.removeItem(KEY);setLoginPending(false);closeAllOverlays();resetWorkspace();showLogin(message||'');focusSoon($('username'));return true}
async function loadWorkspace(epoch,organizationId){const results=await Promise.allSettled([api('/enterprise/accounts'),api('/enterprise/organization/invite'),api('/enterprise/usage/summary?period=30')]);if(epoch!==authEpoch||!currentAdmin||currentAdmin.organizationId!==organizationId)return false;const authorizationFailure=results.find(result=>result.status==='rejected'&&isAuthorizationError(result.reason));if(authorizationFailure){expireAdminSession('登录已失效，请重新登录',authorizationFailure.reason.requestToken);return false}const errors=[];if(results[0].status==='fulfilled')accounts=results[0].value.accounts||[];else{accounts=[];errors.push('成员列表：'+results[0].reason.message)}if(results[1].status==='fulfilled')currentInvite=results[1].value.invite||null;else{currentInvite=null;errors.push('引入链接：'+results[1].reason.message)}if(results[2].status==='fulfilled')usageSummary=results[2].value||null;else{usageSummary=null;errors.push('Token 用量：'+results[2].reason.message)}render();renderInvite();renderUsage();await loadConfiguration();if(errors.length)throw new Error(errors.join('；'));return true}
async function loadWorkspaceWithFeedback(epoch,organizationId){showError('pageError','');try{return await loadWorkspace(epoch,organizationId)}catch(error){if(epoch===authEpoch&&currentAdmin&&currentAdmin.organizationId===organizationId)showError('pageError','后台数据加载失败：'+(error&&error.message?error.message:'请稍后重试'));return false}}
function clearTemplateSelection(){document.querySelectorAll('[data-account-template]').forEach(button=>{button.classList.remove('is-active');button.setAttribute('aria-pressed','false')})}
function applyTemplate(key,button){const template=accountTemplates[key];if(!template)return;$('editRole').value=template.role;$('editDepartment').value=template.department;$('editPositionTitle').value='';renderAccountAssignmentSelectors('','',false);setTags(template.tags);$('editAdmin').checked=template.isAdmin;clearTemplateSelection();button.classList.add('is-active');button.setAttribute('aria-pressed','true')}
function focusableElements(container){return Array.from(container.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')).filter(element=>!element.closest('.hidden'))}
function openOverlay(id,initialFocus,trigger){if(activeOverlay)return;activeOverlay=$(id);overlayReturnFocus=trigger||document.activeElement;$('adminView').inert=true;activeOverlay.classList.remove('hidden');focusSoon(initialFocus)}
function closeOverlay(id,restoreFocus){const overlay=$(id);if(overlay.classList.contains('hidden'))return;overlay.classList.add('hidden');$('adminView').inert=false;activeOverlay=null;const target=overlayReturnFocus;overlayReturnFocus=null;if(restoreFocus!==false)focusSoon(target&&target.isConnected?target:$('organizationTitle'))}
function trapFocus(event){if(event.key!=='Tab'||!activeOverlay)return;const focusables=focusableElements(activeOverlay);if(!focusables.length){event.preventDefault();return}const first=focusables[0];const last=focusables[focusables.length-1];if(event.shiftKey&&(document.activeElement===first||!activeOverlay.contains(document.activeElement))){event.preventDefault();last.focus()}else if(!event.shiftKey&&(document.activeElement===last||!activeOverlay.contains(document.activeElement))){event.preventDefault();first.focus()}}
function openEditor(account,trigger,assignmentFocus){if(isSaving||activeOverlay)return;editorEpoch+=1;const editing=!!account;$('drawerTitle').textContent=assignmentFocus?'安排成员职位':editing?'编辑账号':'新增账号';$('accountId').value=editing?account.id:'';$('editUsername').value=editing?account.username:'';$('editName').value=editing?account.name:'';$('editPhone').value=editing?(account.phone||'').replace('+86',''):'';$('editFeishuOpenId').value=editing?(account.feishuOpenId||''):'';$('editRole').value=editing?(account.role||''):'';$('editDepartment').value=editing?(account.department||''):'';$('editPositionTitle').value=editing?(account.positionTitle||''):'';renderAccountAssignmentSelectors(editing?(account.departmentId||''):'',editing?(account.positionId||''):'',false);$('editAvatarUrl').value=editing?(account.avatarUrl||''):'';setTags(editing?(account.tags||[]):[]);$('editPassword').value='';$('editPassword').required=!editing;$('passwordHint').textContent=editing?'留空表示不修改密码':'至少 8 位，建议混合字母、数字和符号';$('editStatus').value=editing?account.status:'active';$('editAdmin').checked=editing&&account.isAdmin;resetDeleteButton();$('deleteAccount').classList.toggle('hidden',!editing||!currentAdmin||account.id===currentAdmin.id);clearTemplateSelection();updateTagPresetState();showError('formError','');openOverlay('drawerWrap',assignmentFocus?$('editDepartmentId'):$('editUsername'),trigger)}
function closeEditor(restoreFocus,force){if(isSaving&&!force)return;editorEpoch+=1;resetDeleteButton();closeOverlay('drawerWrap',restoreFocus!==false)}
function openLogout(){openOverlay('logoutModal',$('cancelLogout'),$('logoutButton'))}
function closeLogout(force){if($('confirmLogout').disabled&&!force)return;closeOverlay('logoutModal',true)}
async function logout(){const requestToken=token;const button=$('confirmLogout');button.disabled=true;$('cancelLogout').disabled=true;button.textContent='正在退出';try{await api('/enterprise/auth/logout',{method:'POST'})}catch{}finally{button.disabled=false;$('cancelLogout').disabled=false;button.textContent='确认退出';closeOverlay('logoutModal',false);expireAdminSession('',requestToken)}}
function openInviteConfirm(){openOverlay('inviteModal',$('cancelInvite'),$('issueInvite'))}
function closeInviteConfirm(force){if($('confirmInvite').disabled&&!force)return;closeOverlay('inviteModal',true)}
async function issueInvite(){const requestToken=token;const button=$('confirmInvite');button.disabled=true;$('cancelInvite').disabled=true;button.textContent='正在生成';showError('inviteError','');try{const rawMaxUses=$('inviteMaxUses').value.trim();const data=await api('/enterprise/organization/invite',{method:'POST',body:JSON.stringify({defaultDepartment:$('inviteDepartment').value.trim()||null,positionTitle:$('invitePosition').value.trim()||null,defaultRole:$('inviteRole').value.trim()||null,maxUses:rawMaxUses?Number(rawMaxUses):null})});if(requestToken!==token)return;currentInvite=data.invite;renderInvite();closeInviteConfirm(true)}catch(error){if(isAuthorizationError(error)){expireAdminSession('登录已失效，请重新登录',error.requestToken);return}closeInviteConfirm(true);showError('inviteError',error.message)}finally{button.disabled=false;$('cancelInvite').disabled=false;button.textContent='确认生成'}}
function selectInviteFallback(id,message){const field=$(id);field.classList.remove('hidden');field.focus();field.select();showError('inviteError',message)}
async function copyInvite(){if(!currentInvite||currentInvite.status!=='active')return;showError('inviteError','');try{await navigator.clipboard.writeText(currentInvite.code);const button=$('copyInvite');button.textContent='已复制邀请码';setTimeout(()=>{button.textContent='复制邀请码'},1500)}catch{selectInviteFallback('inviteCode','复制失败，已选中邀请码，可手动复制')}}
async function copyInviteLink(){const link=registrationInviteLink();if(!link||!currentInvite||currentInvite.status!=='active')return;showError('inviteError','');try{await navigator.clipboard.writeText(link);const button=$('copyInviteLink');button.textContent='已复制引入链接';setTimeout(()=>{button.textContent='复制企业引入链接'},1500)}catch{selectInviteFallback('inviteLinkPreview','复制失败，已选中企业引入链接，可手动复制')}}
renderPresets();
$('departmentForm').addEventListener('submit',createDepartment);
$('moduleUpdateForm').addEventListener('submit',publishModuleUpdate);
$('moduleUpdateModule').addEventListener('change',fillModuleUpdateForm);
$('moduleUpdateDisable').addEventListener('click',disableModuleUpdate);
$('parkJoinForm').addEventListener('submit',joinPark);
$('parkInviteForm').addEventListener('submit',issueParkInvite);
document.querySelectorAll('[data-account-template]').forEach(button=>button.addEventListener('click',()=>applyTemplate(button.dataset.accountTemplate,button)));
['editRole','editDepartment','editPositionTitle','editTags','editAdmin'].forEach(id=>$(id).addEventListener('input',()=>{if(id==='editTags'){$('editRepairWorker').checked=tags($('editTags').value).includes('维修工作人员');$('editServiceWorker').checked=tags($('editTags').value).includes('客服人员');updateTagPresetState()}clearTemplateSelection()}));
$('editDepartmentId').addEventListener('change',event=>renderAccountAssignmentSelectors(event.target.value,'',true));
$('editPositionId').addEventListener('change',event=>renderAccountAssignmentSelectors($('editDepartmentId').value,event.target.value,true));
$('editRepairWorker').addEventListener('change',()=>{const selected=tags($('editTags').value).filter(tag=>tag!=='维修工作人员');if($('editRepairWorker').checked)selected.push('维修工作人员');setTags(selected);clearTemplateSelection()});
$('editServiceWorker').addEventListener('change',()=>{const selected=tags($('editTags').value).filter(tag=>tag!=='客服人员');if($('editServiceWorker').checked)selected.push('客服人员');setTags(selected);clearTemplateSelection()});
$('togglePassword').addEventListener('click',()=>{setPasswordVisible($('password').type!=='text');$('password').focus()});
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();const epoch=beginAuth();showError('loginError','');setLoginPending(true);try{const data=await api('/enterprise/auth/admin/login',{method:'POST',body:JSON.stringify({identifier:$('username').value.trim(),password:$('password').value})});if(epoch!==authEpoch)return;token=data.token;currentAdmin=data.account;sessionStorage.setItem(KEY,token);$('password').value='';setPasswordVisible(false);resetWorkspace();showAdmin();await loadWorkspaceWithFeedback(epoch,currentAdmin.organizationId)}catch(error){if(epoch!==authEpoch)return;$('password').value='';setPasswordVisible(false);expireAdminSession(error&&error.message?error.message:'登录失败，请稍后重试');focusSoon($('password'))}finally{if(epoch===authEpoch)setLoginPending(false)}});
$('logoutButton').addEventListener('click',openLogout);$('cancelLogout').addEventListener('click',()=>closeLogout(false));$('confirmLogout').addEventListener('click',logout);$('logoutModal').addEventListener('click',event=>{if(event.target===$('logoutModal'))closeLogout(false)});
$('issueInvite').addEventListener('click',openInviteConfirm);$('cancelInvite').addEventListener('click',()=>closeInviteConfirm(false));$('confirmInvite').addEventListener('click',issueInvite);$('inviteModal').addEventListener('click',event=>{if(event.target===$('inviteModal'))closeInviteConfirm(false)});$('copyInvite').addEventListener('click',copyInvite);$('copyInviteLink').addEventListener('click',copyInviteLink);
$('searchInput').addEventListener('input',render);$('createButton').addEventListener('click',event=>openEditor(null,event.currentTarget));$('closeDrawer').addEventListener('click',()=>closeEditor(true,false));$('cancelEdit').addEventListener('click',()=>closeEditor(true,false));$('drawerWrap').addEventListener('click',event=>{if(event.target===$('drawerWrap'))closeEditor(true,false)});
$('deleteAccount').addEventListener('click',async()=>{const id=$('accountId').value;if(!id||isSaving)return;if(!deleteArmed){deleteArmed=true;$('deleteAccount').textContent='再次点击确认删除';showError('formError','删除后该账号会立即退出，历史审计记录仍会保留。');return}const requestEditor=editorEpoch;const requestToken=token;isSaving=true;setEditorPending(true);showError('formError','');try{await api('/enterprise/accounts/'+encodeURIComponent(id),{method:'DELETE'});if(requestEditor!==editorEpoch||requestToken!==token)return;isSaving=false;setEditorPending(false);closeEditor(false,true);const organizationId=currentAdmin&&currentAdmin.organizationId;await (organizationId?loadWorkspaceWithFeedback(authEpoch,organizationId):Promise.resolve(false));focusSoon($('organizationTitle'))}catch(error){if(requestEditor!==editorEpoch||requestToken!==token)return;if(isAuthorizationError(error)){expireAdminSession('登录已失效，请重新登录',error.requestToken);return}resetDeleteButton();showError('formError',error.message);$('formError').tabIndex=-1;focusSoon($('formError'))}finally{if(requestEditor===editorEpoch){isSaving=false;setEditorPending(false)}}});
$('accountForm').addEventListener('submit',async event=>{event.preventDefault();showError('formError','');const requestEditor=editorEpoch;const requestToken=token;const id=$('accountId').value;const password=$('editPassword').value;const body={username:$('editUsername').value.trim(),name:$('editName').value.trim(),phone:$('editPhone').value.trim()||null,feishuOpenId:$('editFeishuOpenId').value.trim()||null,role:$('editRole').value.trim(),department:$('editDepartment').value.trim()||null,departmentId:$('editDepartmentId').value||null,positionTitle:$('editPositionTitle').value.trim()||null,positionId:$('editPositionId').value||null,avatarUrl:$('editAvatarUrl').value.trim()||null,tags:tags($('editTags').value),status:$('editStatus').value,isAdmin:$('editAdmin').checked};if(password)body.password=password;if(!id&&!password){showError('formError','新增账号必须设置密码');focusSoon($('editPassword'));return}isSaving=true;setEditorPending(true);try{await api(id?'/enterprise/accounts/'+encodeURIComponent(id):'/enterprise/accounts',{method:id?'PATCH':'POST',body:JSON.stringify(body)});if(requestEditor!==editorEpoch||requestToken!==token)return;isSaving=false;setEditorPending(false);closeEditor(false,true);const organizationId=currentAdmin&&currentAdmin.organizationId;const loaded=organizationId?await loadWorkspaceWithFeedback(authEpoch,organizationId):false;if(loaded&&currentAdmin){const target=id?Array.from(document.querySelectorAll('button[data-id]')).find(button=>button.dataset.id===id):$('createButton');focusSoon(target||$('organizationTitle'))}}catch(error){if(requestEditor!==editorEpoch||requestToken!==token)return;if(isAuthorizationError(error)){expireAdminSession('登录已失效，请重新登录',error.requestToken);return}showError('formError',error.message);$('formError').tabIndex=-1;focusSoon($('formError'))}finally{if(requestEditor===editorEpoch){isSaving=false;setEditorPending(false)}}});
document.addEventListener('keydown',event=>{if(event.key==='Tab'){trapFocus(event);return}if(event.key!=='Escape')return;if(activeOverlay===$('inviteModal'))closeInviteConfirm(false);else if(activeOverlay===$('logoutModal'))closeLogout(false);else if(activeOverlay===$('drawerWrap'))closeEditor(true,false)});
async function restoreSession(){if(!token){showLogin('');focusSoon($('username'));return}const requestToken=token;const epoch=beginAuth();try{const data=await api('/enterprise/auth/me');if(epoch!==authEpoch||requestToken!==token)return;if(!data.account.isAdmin){const error=new Error('该账号没有管理员权限');error.status=403;throw error}currentAdmin=data.account;resetWorkspace();showAdmin();await loadWorkspaceWithFeedback(epoch,currentAdmin.organizationId)}catch(error){if(epoch!==authEpoch||requestToken!==token)return;expireAdminSession('登录已失效，请重新登录',requestToken)}}
restoreSession();
</script></body></html>`;
}

function platformAdminHTML(): string {
  if (process.env.OTTO_ENTERPRISE_PLATFORM_LEGACY_UI === '1') {
    return legacyPlatformAdminHTML();
  }
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 平台企业工作台</title>
<style>
:root{--ink:#17211d;--muted:#69736e;--line:#d9e1dd;--line-strong:#c6d1cb;--paper:#f3f6f4;--panel:#fff;--subtle:#edf2ef;--accent:#176a4b;--accent-dark:#10553b;--accent-soft:#e5f1eb;--danger:#a53e35;--danger-soft:#faece9;--nav:#13241d;--nav-soft:#1d352b;--nav-line:#31483e;--shadow:0 18px 48px rgba(19,36,29,.13);--radius:11px}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--paper);color:var(--ink);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}button,input,select{font:inherit}button{cursor:pointer}.hidden{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid #2b8f68;outline-offset:2px}
.platform-shell{min-height:100vh;display:grid;grid-template-columns:300px minmax(0,1fr)}.rail{position:sticky;top:0;height:100vh;background:var(--nav);color:#edf6f1;padding:25px 20px 20px;display:flex;flex-direction:column;overflow:hidden}.brand{font-size:25px;font-weight:850;letter-spacing:-.05em;padding:0 8px}.brand b{color:#6bd5ad}.rail-intro{padding:30px 8px 20px;border-bottom:1px solid var(--nav-line)}.eyebrow{font-size:10px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;color:#59c79d}.rail-intro h1{font-size:22px;letter-spacing:-.035em;margin:8px 0 5px}.rail-intro p{font-size:12px;color:#9cb0a7;margin:0}.organization-controls{display:flex;flex-direction:column;min-height:0;flex:1}.organization-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 8px 10px}.organization-head strong{font-size:13px}.organization-count{font-size:11px;color:#8da198}.organization-search{height:38px;border:1px solid var(--nav-line);border-radius:8px;background:#1a3027;color:#eff7f3;padding:0 11px;margin:0 8px 10px;outline:none}.organization-search::placeholder{color:#758b81}.organization-search:focus{border-color:#69d5ab;box-shadow:0 0 0 3px rgba(105,213,171,.12)}.organization-nav{display:grid;gap:6px;overflow:auto;padding:0 4px 12px}.organization-button{width:100%;border:1px solid transparent;border-radius:9px;background:transparent;color:#cfddd6;padding:11px 12px;text-align:left;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.organization-button:hover{background:#193027;border-color:#29453a}.organization-button[aria-selected="true"]{background:var(--nav-soft);border-color:#406052;color:#fff}.organization-button strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.organization-button small{display:block;color:#82988d;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.organization-state{width:7px;height:7px;border-radius:50%;background:#65d6ad;margin-top:6px}.organization-empty{padding:22px 12px;color:#82988d;font-size:12px;text-align:center}.rail-action{margin:0 8px 10px;height:41px;border:1px solid #4b6a5d;border-radius:8px;background:#213d32;color:#eff7f3;font-weight:750}.rail-action:hover{background:#29483b}.rail-foot{border-top:1px solid var(--nav-line);padding:15px 8px 0;display:grid;gap:8px}.rail-link,.rail-clear{border:0;background:transparent;color:#a9bbb2;text-decoration:none;text-align:left;padding:4px 0;font-size:12px}.rail-link:hover,.rail-clear:hover{color:#fff}
.workspace{padding:31px clamp(24px,4vw,58px) 56px;min-width:0}.workspace-top{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:23px}.workspace-top h2{font-size:30px;line-height:1.15;letter-spacing:-.04em;margin:4px 0}.workspace-top p{margin:0;color:var(--muted)}.platform-status{display:inline-flex;align-items:center;gap:7px;background:var(--accent-soft);color:#245f49;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:750}.platform-status:before{content:'';width:7px;height:7px;border-radius:50%;background:#2d966c}.auth-card,.empty-panel,.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 1px 2px rgba(19,36,29,.04)}.auth-card{max-width:720px;padding:27px}.auth-card h3{font-size:21px;letter-spacing:-.025em;margin:0 0 7px}.auth-card>p{color:var(--muted);margin:0 0 20px}.token-row{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:10px;align-items:end}.field{display:grid;gap:6px}.field label{font-size:12px;font-weight:750;color:#46534d}.field input,.field select{height:44px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;background:#fff;color:var(--ink);outline:none}.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.11)}.primary,.secondary,.danger{min-height:42px;border-radius:8px;padding:0 15px;font-weight:750}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff}.primary:hover{background:var(--accent-dark)}.secondary{border:1px solid var(--line-strong);background:#fff;color:var(--ink)}.secondary:hover{border-color:#91a198;background:#f8faf9}.danger{border:1px solid #d9aaa5;background:#fff;color:var(--danger)}.danger:hover,.danger.armed{border-color:var(--danger);background:var(--danger);color:#fff}.primary:disabled,.secondary:disabled,.danger:disabled{opacity:.5;cursor:default}.error,.notice{padding:10px 12px;border-radius:8px;margin-top:13px}.error{color:var(--danger);background:var(--danger-soft);border:1px solid #ecc8c2}.notice{color:#245f49;background:var(--accent-soft);border:1px solid #cfe3d8}.empty-panel{padding:60px 28px;text-align:center;color:var(--muted)}.empty-panel strong{display:block;color:var(--ink);font-size:20px;margin-bottom:5px}
.panel-header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:18px}.panel-header h3{font-size:28px;letter-spacing:-.035em;margin:4px 0}.panel-meta{color:var(--muted);margin:0}.panel-actions{display:flex;gap:9px}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:15px}.metric{padding:17px 19px;border-left:1px solid var(--line)}.metric:first-child{border-left:0}.metric strong{display:block;font-size:24px;line-height:1.2;letter-spacing:-.03em}.metric span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.panel-grid{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(320px,.82fr);gap:14px;margin-bottom:15px}.card{padding:20px;min-width:0}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px}.card h4{font-size:17px;margin:0 0 4px}.card-copy{color:var(--muted);font-size:12px;margin:0}.invite-code{font:850 clamp(26px,3.4vw,42px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.075em;margin:19px 0 10px}.invite-meta{color:var(--muted);font-size:12px}.invite-link{display:block;margin:12px 0;padding:9px 11px;border:1px solid var(--line);border-radius:7px;background:var(--subtle);color:#53605a;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.invite-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:13px 0}.invite-settings .field input{height:38px}.inline-actions{display:flex;gap:8px;flex-wrap:wrap}.department-list{display:grid;gap:8px;max-height:280px;overflow:auto}.department{border:1px solid var(--line);border-radius:9px;padding:11px 12px}.department-head{display:flex;justify-content:space-between;gap:12px;font-weight:750}.department-count{font-size:11px;color:var(--muted)}.department-members{color:var(--muted);font-size:12px;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.table-card{padding:0;overflow:hidden}.table-heading{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:15px}.table-heading h4{margin:0}.table-wrap{overflow:auto}.accounts{width:100%;border-collapse:collapse;min-width:790px}.accounts th{text-align:left;font-size:11px;letter-spacing:.045em;color:#53605a;background:var(--subtle);padding:11px 14px;border-bottom:1px solid var(--line)}.accounts td{padding:13px 14px;border-top:1px solid #e9eeeb;vertical-align:middle}.accounts tbody tr:first-child td{border-top:0}.accounts tbody tr:hover td{background:#fafcfb}.name{font-weight:750}.sub{font-size:12px;color:var(--muted);margin-top:2px}.badge{display:inline-block;border-radius:999px;padding:4px 8px;background:#edf1ef;color:#46534d;font-size:11px;white-space:nowrap}.badge.ok{background:var(--accent-soft);color:#245f49}.badge.admin{background:#e7edf7;color:#365679}.table-empty{text-align:center!important;color:var(--muted);padding:35px!important}
.modal-backdrop{position:fixed;inset:0;background:rgba(11,25,19,.55);display:grid;place-items:center;padding:20px;z-index:20}.modal{width:min(760px,100%);max-height:min(88vh,760px);overflow:auto;background:#fff;border-radius:13px;box-shadow:var(--shadow);padding:24px}.modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.modal h3{font-size:22px;margin:0}.close{border:1px solid var(--line);background:#fff;border-radius:7px;width:36px;height:36px;font-size:20px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.form-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:19px}.row-actions{display:flex;align-items:center;gap:7px;white-space:nowrap}.row-actions .secondary,.row-actions .danger{min-height:34px;padding:0 10px;font-size:12px}.permission-member{border:1px solid var(--line);border-radius:8px;background:var(--subtle);padding:11px 12px;margin-bottom:16px}.permission-member strong{display:block}.permission-member span{display:block;color:var(--muted);font-size:12px;margin-top:2px}
@media(max-width:980px){.platform-shell{grid-template-columns:260px minmax(0,1fr)}.panel-grid{grid-template-columns:1fr}.summary-grid{grid-template-columns:repeat(2,1fr)}.metric:nth-child(3){border-left:0;border-top:1px solid var(--line)}.metric:nth-child(4){border-top:1px solid var(--line)}}@media(max-width:720px){.platform-shell{display:block}.rail{position:relative;height:auto;min-height:0;overflow:visible}.organization-nav{max-height:260px}.workspace{padding:24px 16px 44px}.workspace-top,.panel-header{align-items:flex-start;flex-direction:column}.token-row,.form-grid{grid-template-columns:1fr}.summary-grid{grid-template-columns:1fr}.metric{border-left:0;border-top:1px solid var(--line)}.metric:first-child{border-top:0}.panel-actions{width:100%}.panel-actions button{flex:1}}
</style></head><body>
<main class="platform-shell">
  <aside class="rail">
    <div class="brand">otto<b>✦</b></div>
    <div class="rail-intro"><div class="eyebrow">PLATFORM CONTROL</div><h1>平台企业管理</h1><p>选择企业，再处理该企业的成员、邀请码和用量。</p></div>
    <div id="organizationControls" class="organization-controls hidden">
      <div class="organization-head"><strong>全部企业</strong><span id="organizationCount" class="organization-count">0 个</span></div>
      <label class="sr-only" for="organizationSearch">搜索企业</label>
      <input id="organizationSearch" class="organization-search" placeholder="搜索企业名称或标识">
      <nav id="organizationNav" class="organization-nav" aria-label="全部企业"></nav>
      <button id="openCreateOrganization" class="rail-action" type="button">＋ 新建企业</button>
    </div>
    <div class="rail-foot">
      <button id="clearToken" class="rail-clear" type="button">退出平台身份</button>
      <a class="rail-link" href="/enterprise/admin">企业管理员登录</a>
    </div>
  </aside>
  <section class="workspace">
    <header class="workspace-top"><div><div class="eyebrow">MULTI-ORGANIZATION</div><h2>企业工作台</h2><p>左侧选择企业，右侧始终只展示当前企业的数据。</p></div><span id="authStatus" class="platform-status hidden">平台身份已验证</span></header>
    <div id="globalNotice" class="notice hidden" role="status"></div>
    <section id="tokenGate" class="auth-card">
      <h3>验证平台身份</h3>
      <p>输入服务器配置的平台管理令牌。令牌只保存在当前标签页，关闭后自动清除。</p>
      <form id="tokenForm" class="token-row">
        <div class="field"><label for="platformToken">平台管理令牌</label><input id="platformToken" type="password" autocomplete="off" required></div>
        <button id="openPlatform" class="primary" type="submit">进入平台工作台</button>
      </form>
      <div id="tokenError" class="error hidden" role="alert"></div>
    </section>
    <section id="emptyPanel" class="empty-panel hidden"><strong>先从左侧选择企业</strong><span>企业成员、部门目录、邀请码和用量会显示在这里。</span></section>
    <section id="organizationPanel" class="hidden" aria-live="polite">
      <header class="panel-header">
        <div><div class="eyebrow">SELECTED ENTERPRISE</div><h3 id="panelTitle" tabindex="-1">企业</h3><p id="panelMeta" class="panel-meta"></p></div>
        <div class="panel-actions"><button id="refreshPanel" class="secondary" type="button">刷新</button></div>
      </header>
      <div class="summary-grid">
        <div class="metric"><strong id="metricAccounts">—</strong><span>成员账号</span></div>
        <div class="metric"><strong id="metricAdmins">—</strong><span>企业管理员</span></div>
        <div class="metric"><strong id="metricDepartments">—</strong><span>已分配部门</span></div>
        <div class="metric"><strong id="metricTokens">—</strong><span>近 30 天 Token</span></div>
      </div>
      <section class="card" id="platformParkCard" aria-label="当前企业产业园设置">
        <div class="card-head"><div><h4>产业园设置</h4><p class="card-copy">这里针对左侧选中的企业生效。平台可认证产业园端；普通企业 CEO 只能用邀请码加入已有产业园。</p></div><span id="platformParkStatus" class="badge">未加入</span></div>
        <div id="platformParkEmpty" class="panel-grid">
          <form id="platformParkRegisterForm" class="department" style="margin:0">
            <h4>认证为产业园端</h4><p class="card-copy">该企业认证后，才拥有发放产业园邀请码和发布园区公告的权限。</p>
            <div class="field"><label for="platformParkName">产业园名称</label><input id="platformParkName" maxlength="80" placeholder="例如：科技大厦" required></div>
            <div class="field"><label for="platformParkBrandName">客户端服务名称</label><input id="platformParkBrandName" maxlength="80" placeholder="例如：科技大厦园区服务"></div>
            <div class="inline-actions"><button class="primary" type="submit">认证为产业园端</button></div>
          </form>
          <form id="platformParkJoinForm" class="department" style="margin:0">
            <h4>加入已有产业园</h4><p class="card-copy">使用产业园管理方生成的邀请码，让整个企业成为入驻企业。</p>
            <div class="field"><label for="platformParkJoinCode">产业园邀请码</label><input id="platformParkJoinCode" autocomplete="off" placeholder="Aa3B-k9Pq-Z7xY" required></div>
            <div class="field"><label for="platformParkJoinAddress">企业地址</label><input id="platformParkJoinAddress" maxlength="160" placeholder="例如：科技大厦 A 座" required></div>
            <div class="field"><label for="platformParkJoinRoomNumber">门牌号</label><input id="platformParkJoinRoomNumber" maxlength="40" placeholder="例如：1203 室" required></div>
            <div class="inline-actions"><button class="primary" type="submit">整个企业加入</button></div>
          </form>
        </div>
        <div id="platformParkDetails" class="hidden">
          <div id="platformParkSummary" class="department" style="margin-bottom:10px"></div>
          <form id="platformParkEditForm" class="department hidden" style="margin-bottom:10px">
            <div class="department-head"><span>编辑产业园资料</span><span class="department-count">仅平台管理员可修改</span></div>
            <div class="invite-settings">
              <div class="field"><label for="platformParkEditName">产业园名称</label><input id="platformParkEditName" maxlength="80" required></div>
              <div class="field"><label for="platformParkEditBrandName">客户端服务名称</label><input id="platformParkEditBrandName" maxlength="80" required></div>
              <div class="field"><label for="platformParkEditSlug">稳定标识（不可修改）</label><input id="platformParkEditSlug" readonly aria-readonly="true"></div>
            </div>
            <div class="inline-actions"><button id="platformParkSave" class="primary" type="submit">保存园区资料</button></div>
          </form>
          <div id="platformParkTenants" class="department-list"></div>
        </div>
        <div id="platformParkNotice" class="notice hidden" role="status"></div>
      </section>
      <div class="panel-grid">
        <section class="card">
          <div class="card-head"><div><h4>企业成员引入</h4><p class="card-copy">岗位邀请码精确有效 7 天；生成新码会撤销旧码。</p></div><span id="inviteStatus" class="badge">未生成</span></div>
          <div id="inviteCode" class="invite-code">—</div>
          <div id="inviteMeta" class="invite-meta">选择企业后加载</div>
          <div id="inviteLink" class="invite-link">尚无可复制链接</div>
          <div class="invite-settings" aria-label="新成员岗位分配">
            <div class="field"><label for="platformInviteDepartment">部门</label><input id="platformInviteDepartment" maxlength="80" placeholder="例如：研发部"></div>
            <div class="field"><label for="platformInvitePosition">职位</label><input id="platformInvitePosition" maxlength="80" placeholder="例如：研发工程师"></div>
            <div class="field"><label for="platformInviteRole">角色权限</label><input id="platformInviteRole" maxlength="80" placeholder="默认：成员"></div>
            <div class="field"><label for="platformInviteMaxUses">可注册人数</label><input id="platformInviteMaxUses" type="number" min="1" max="10000" placeholder="不填则不限"></div>
          </div>
          <div class="inline-actions"><button id="copyInviteCode" class="secondary" type="button" disabled>复制邀请码</button><button id="copyInviteLink" class="secondary" type="button" disabled>复制引入链接</button><button id="issueInvite" class="primary" type="button">生成新邀请码</button></div>
        </section>
        <section class="card">
          <div class="card-head"><div><h4>部门成员目录</h4><p class="card-copy">当前按成员填写的部门字段分组，不伪造上下级层级。</p></div></div>
          <div id="departmentList" class="department-list"></div>
        </section>
      </div>
      <section class="card table-card">
        <div class="table-heading"><div><h4>成员账号</h4><p class="card-copy">账号删除会立即撤销其登录会话，并保留审计记录。</p></div><span id="accountCount" class="organization-count">0 个</span></div>
        <div class="table-wrap"><table class="accounts"><thead><tr><th scope="col">成员</th><th scope="col">部门 / 职责</th><th scope="col">权限</th><th scope="col">状态</th><th scope="col">30 天 Token</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody id="accountRows"></tbody></table></div>
      </section>
      <div id="panelError" class="error hidden" role="alert"></div>
    </section>
  </section>
</main>
<div id="createOrganizationModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="createOrganizationTitle">
  <section class="modal">
    <div class="modal-head"><div><div class="eyebrow">NEW ENTERPRISE</div><h3 id="createOrganizationTitle">新建企业</h3></div><button id="closeCreateOrganization" class="close" type="button" aria-label="关闭">×</button></div>
    <form id="organizationForm">
      <div class="form-grid">
        <div class="field"><label for="organizationName">企业名称</label><input id="organizationName" maxlength="80" required placeholder="例如：星河科技"></div>
        <div class="field"><label for="organizationSlug">企业标识</label><input id="organizationSlug" maxlength="48" pattern="[a-z0-9-]+" placeholder="可选，例如：galaxy-tech"></div>
        <div class="field"><label for="adminUsername">首位管理员用户名</label><input id="adminUsername" autocomplete="off" required></div>
        <div class="field"><label for="adminName">首位企业管理员姓名</label><input id="adminName" autocomplete="name" required></div>
        <div class="field"><label for="adminPhone">管理员手机号</label><input id="adminPhone" inputmode="tel" autocomplete="tel" placeholder="可选"></div>
        <div class="field"><label for="adminPassword">管理员初始密码</label><input id="adminPassword" type="password" minlength="8" autocomplete="new-password" required></div>
      </div>
      <div class="form-actions"><span id="createStatus" class="organization-count" role="status" aria-live="polite"></span><button id="cancelCreateOrganization" class="secondary" type="button">取消</button><button id="createOrganization" class="primary" type="submit">创建企业</button></div>
      <div id="createError" class="error hidden" role="alert"></div>
    </form>
  </section>
</div>
<div id="accountPermissionModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="accountPermissionTitle">
  <section class="modal">
    <div class="modal-head"><div><div class="eyebrow">MEMBER ACCESS</div><h3 id="accountPermissionTitle">成员权限</h3></div><button id="closeAccountPermission" class="close" type="button" aria-label="关闭">×</button></div>
    <div id="accountPermissionMember" class="permission-member"></div>
    <form id="accountPermissionForm">
      <div class="form-grid">
        <div class="field"><label for="accountPermissionRole">角色名称</label><input id="accountPermissionRole" maxlength="80" placeholder="例如：销售经理"></div>
        <div class="field"><label for="accountPermissionLevel">企业管理权限</label><select id="accountPermissionLevel"><option value="member">普通成员</option><option value="admin">企业管理员</option></select></div>
        <div class="field"><label for="accountPermissionStatus">账号状态</label><select id="accountPermissionStatus"><option value="active">正常使用</option><option value="disabled">停用账号</option></select></div>
      </div>
      <div class="form-actions"><span id="accountPermissionStatusText" class="organization-count" role="status" aria-live="polite"></span><button id="cancelAccountPermission" class="secondary" type="button">取消</button><button id="saveAccountPermission" class="primary" type="submit">保存权限</button></div>
      <div id="accountPermissionError" class="error hidden" role="alert"></div>
    </form>
  </section>
</div>
<script>
const KEY='otto.enterprise.platform.session';
const SELECTED_KEY=KEY+'.organization';
let token=sessionStorage.getItem(KEY)||'';
let organizations=[];
let selectedOrganizationId=sessionStorage.getItem(SELECTED_KEY)||'';
let selectedOverview=null;
let platformRequestEpoch=0;
let inviteArmed=false;
let inviteArmTimer=0;
let editingPermissionAccountId='';
let editingPermissionOrganizationId='';
let permissionReturnFocus=null;
const $=id=>document.getElementById(id);
function show(id,message){const element=$(id);element.textContent=message||'';element.classList.toggle('hidden',!message)}
function formatNumber(value){return Number(value||0).toLocaleString('zh-CN')}
function isAuthorizationError(error){return error&&((error.status===401)||(error.status===403))}
async function api(path,options){const response=await fetch(path,Object.assign({},options||{},{headers:Object.assign({'content-type':'application/json'},options&&options.headers||{},token?{authorization:'Bearer '+token}:{})}));const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||('请求失败 '+response.status));error.status=response.status;throw error}return data}
function setAuthenticated(authenticated){$('tokenGate').classList.toggle('hidden',authenticated);$('organizationControls').classList.toggle('hidden',!authenticated);$('authStatus').classList.toggle('hidden',!authenticated);$('clearToken').classList.toggle('hidden',!authenticated);if(authenticated)$('platformToken').value=''}
function clearPlatformSession(message){platformRequestEpoch+=1;closeAccountPermission(true);token='';organizations=[];selectedOrganizationId='';selectedOverview=null;sessionStorage.removeItem(KEY);sessionStorage.removeItem(SELECTED_KEY);setAuthenticated(false);$('organizationNav').replaceChildren();$('organizationCount').textContent='0 个';$('organizationPanel').classList.add('hidden');$('emptyPanel').classList.add('hidden');if(message)show('tokenError',message)}
function filteredOrganizations(){const query=$('organizationSearch').value.trim().toLocaleLowerCase('zh-CN');if(!query)return organizations;return organizations.filter(organization=>String(organization.name||'').toLocaleLowerCase('zh-CN').includes(query)||String(organization.slug||'').toLocaleLowerCase('en-US').includes(query))}
function renderOrganizations(){const list=$('organizationNav');list.replaceChildren();const visible=filteredOrganizations();$('organizationCount').textContent=organizations.length+' 个';if(!visible.length){const empty=document.createElement('div');empty.className='organization-empty';empty.textContent=organizations.length?'没有匹配的企业':'还没有企业，请先创建第一家企业';list.append(empty);return}visible.forEach(organization=>{const button=document.createElement('button');button.type='button';button.className='organization-button';button.dataset.organizationId=organization.id;button.setAttribute('aria-selected',String(organization.id===selectedOrganizationId));const copy=document.createElement('span');const name=document.createElement('strong');name.textContent=String(organization.name||'未命名企业');const meta=document.createElement('small');meta.textContent=String(organization.slug||'');copy.append(name,meta);const state=document.createElement('span');state.className='organization-state';state.setAttribute('aria-label',organization.status==='active'?'正常运行':'已停用');button.append(copy,state);button.addEventListener('click',()=>selectOrganization(organization.id,true));list.append(button)})}
function setPanelLoading(organization){closeAccountPermission(true);selectedOverview=null;resetInviteArm();renderInvite(null);renderPlatformPark(null);$('issueInvite').disabled=true;$('organizationPanel').classList.remove('hidden');$('emptyPanel').classList.add('hidden');$('panelTitle').textContent=String(organization.name||'企业');$('panelMeta').textContent=String(organization.slug||'')+' · 正在加载企业数据…';['metricAccounts','metricAdmins','metricDepartments','metricTokens'].forEach(id=>$(id).textContent='—');$('accountRows').replaceChildren();$('departmentList').replaceChildren();show('panelError','')}
function renderInvite(invite){const available=Boolean(invite&&invite.status==='active');$('inviteCode').textContent=available?String(invite.code||'—'):'—';$('inviteStatus').textContent=available?'有效':'未生成';$('inviteStatus').className=available?'badge ok':'badge';$('inviteMeta').textContent=available?('有效至 '+new Date(invite.expiresAt).toLocaleString('zh-CN',{hour12:false})+' · 已使用 '+Number(invite.usedCount||0)+(invite.maxUses==null?' 次':' / '+Number(invite.maxUses)+' 次')):'当前企业没有有效邀请码';$('inviteLink').textContent=available?String(invite.link||''):'尚无可复制链接';$('copyInviteCode').disabled=!available;$('copyInviteLink').disabled=!available;$('platformInviteDepartment').value=invite&&invite.defaultDepartment||'';$('platformInvitePosition').value=invite&&invite.positionTitle||'';$('platformInviteRole').value=invite&&invite.defaultRole||'';$('platformInviteMaxUses').value=invite&&invite.maxUses||''}
function renderDepartments(accounts){const list=$('departmentList');list.replaceChildren();const groups=new Map();accounts.forEach(account=>{const department=String(account.department||'未分配部门');if(!groups.has(department))groups.set(department,[]);groups.get(department).push(account)});if(!groups.size){const empty=document.createElement('div');empty.className='organization-empty';empty.textContent='暂无成员';list.append(empty);return}Array.from(groups.entries()).sort((a,b)=>a[0].localeCompare(b[0],'zh-CN')).forEach(([department,members])=>{const card=document.createElement('article');card.className='department';const head=document.createElement('div');head.className='department-head';const name=document.createElement('span');name.textContent=department;const count=document.createElement('span');count.className='department-count';count.textContent=members.length+' 人';head.append(name,count);const names=document.createElement('div');names.className='department-members';names.textContent=members.map(member=>String(member.name||member.username||'未命名成员')).join('、');card.append(head,names);list.append(card)})}
function appendCell(row,text,className){const cell=document.createElement('td');if(className)cell.className=className;cell.textContent=String(text==null?'':text);row.append(cell);return cell}
function openAccountPermission(account,trigger){editingPermissionAccountId=String(account.id||'');editingPermissionOrganizationId=selectedOrganizationId;permissionReturnFocus=trigger||null;const host=$('accountPermissionMember');host.replaceChildren();const name=document.createElement('strong');name.textContent=String(account.name||'未命名成员');const meta=document.createElement('span');meta.textContent='@'+String(account.username||'')+' · '+String(account.department||'未分配部门')+' / '+String(account.positionTitle||'未设置职位');host.append(name,meta);$('accountPermissionRole').value=String(account.role||'');$('accountPermissionLevel').value=account.isAdmin?'admin':'member';$('accountPermissionStatus').value=account.status==='disabled'?'disabled':'active';$('accountPermissionStatusText').textContent='';show('accountPermissionError','');$('accountPermissionModal').classList.remove('hidden');$('accountPermissionLevel').focus()}
function closeAccountPermission(force){const modal=$('accountPermissionModal');if(modal.classList.contains('hidden'))return;if($('saveAccountPermission').disabled&&!force)return;modal.classList.add('hidden');editingPermissionAccountId='';editingPermissionOrganizationId='';$('accountPermissionForm').reset();$('accountPermissionStatusText').textContent='';show('accountPermissionError','');const target=permissionReturnFocus;permissionReturnFocus=null;if(!force&&target&&target.isConnected)target.focus()}
async function saveAccountPermission(event){event.preventDefault();const accountId=editingPermissionAccountId;const organizationId=editingPermissionOrganizationId;if(!accountId||!organizationId||organizationId!==selectedOrganizationId)return;const button=$('saveAccountPermission');const body={role:$('accountPermissionRole').value.trim()||null,isAdmin:$('accountPermissionLevel').value==='admin',status:$('accountPermissionStatus').value};button.disabled=true;button.textContent='正在保存…';$('accountPermissionStatusText').textContent='正在更新成员权限';show('accountPermissionError','');try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/accounts/'+encodeURIComponent(accountId),{method:'PATCH',body:JSON.stringify(body)});closeAccountPermission(true);if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('globalNotice','成员权限已更新，原登录会话已刷新')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('accountPermissionError',error.message)}finally{if(button.isConnected){button.disabled=false;button.textContent='保存权限';$('accountPermissionStatusText').textContent=''}}}
function renderAccounts(accounts){const rows=$('accountRows');rows.replaceChildren();$('accountCount').textContent=accounts.length+' 个';if(!accounts.length){const row=document.createElement('tr');const cell=document.createElement('td');cell.colSpan=6;cell.className='table-empty';cell.textContent='当前企业还没有成员账号';row.append(cell);rows.append(row);return}accounts.forEach(account=>{const row=document.createElement('tr');const member=document.createElement('td');const name=document.createElement('div');name.className='name';name.textContent=String(account.name||'未命名成员');const username=document.createElement('div');username.className='sub';username.textContent='@'+String(account.username||'');member.append(name,username);row.append(member);appendCell(row,(account.department||'未分配部门')+' / '+(account.positionTitle||account.role||'未设置职位'));const permission=appendCell(row,'');const permissionBadge=document.createElement('span');permissionBadge.className=account.isAdmin?'badge admin':'badge';permissionBadge.textContent=account.isAdmin?'企业管理员':'普通成员';permission.append(permissionBadge);const status=appendCell(row,'');const statusBadge=document.createElement('span');statusBadge.className=account.status==='active'?'badge ok':'badge';statusBadge.textContent=account.status==='active'?'正常':'已停用';status.append(statusBadge);appendCell(row,formatNumber(account.usage&&account.usage.totalTokens));const action=appendCell(row,'');const actions=document.createElement('div');actions.className='row-actions';const edit=document.createElement('button');edit.type='button';edit.className='secondary';edit.textContent='权限';edit.setAttribute('aria-label','编辑权限 '+String(account.name||account.username||''));edit.addEventListener('click',()=>openAccountPermission(account,edit));const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.textContent='删除';remove.setAttribute('aria-label','删除账号 '+String(account.name||account.username||''));remove.addEventListener('click',()=>deleteAccount(remove,account));actions.append(edit,remove);action.append(actions);rows.append(row)})}
function renderPlatformPark(data){
  const park=data&&data.park||null;
  const editForm=$('platformParkEditForm');
  $('platformParkNotice').classList.add('hidden');
  $('platformParkEmpty').classList.toggle('hidden',!!park);
  $('platformParkDetails').classList.toggle('hidden',!park);
  editForm.classList.add('hidden');
  $('platformParkEditName').value='';
  $('platformParkEditBrandName').value='';
  $('platformParkEditSlug').value='';
  if(!park){
    $('platformParkStatus').textContent='未加入';
    $('platformParkStatus').className='badge';
    $('platformParkSummary').replaceChildren();
    $('platformParkTenants').replaceChildren();
    return;
  }
  const isOwner=park.isAdminOrganization||park.adminOrganizationId===(data.organization&&data.organization.id);
  $('platformParkStatus').textContent=isOwner?'产业园管理方':'已入驻企业';
  $('platformParkStatus').className=isOwner?'badge ok':'badge';
  const summary=$('platformParkSummary');
  summary.replaceChildren();
  const summaryHead=document.createElement('div');
  summaryHead.className='department-head';
  const summaryName=document.createElement('span');
  summaryName.textContent=String(park.brandName||park.name||'未命名产业园');
  const summaryScope=document.createElement('span');
  summaryScope.className='department-count';
  summaryScope.textContent=isOwner?'可邀请企业入驻':'由园区方统一配置';
  summaryHead.append(summaryName,summaryScope);
  const summaryMeta=document.createElement('div');
  summaryMeta.className='department-members';
  summaryMeta.textContent=String(park.name||'未命名产业园')+' · '+String(park.slug||'');
  summary.append(summaryHead,summaryMeta);
  editForm.classList.toggle('hidden',!isOwner);
  if(isOwner){
    $('platformParkEditName').value=String(park.name||'');
    $('platformParkEditBrandName').value=String(park.brandName||park.name||'');
    $('platformParkEditSlug').value=String(park.slug||'');
  }
  const tenants=Array.isArray(park.tenants)?park.tenants:[];
  const tenantHost=$('platformParkTenants');
  tenantHost.replaceChildren();
  if(!isOwner){
    const note=document.createElement('div');
    note.className='organization-empty';
    note.textContent='该企业已加入产业园，不能修改园区资料、发布园区公告或管理入驻企业。';
    tenantHost.append(note);
    return;
  }
  if(!tenants.length){
    const empty=document.createElement('div');
    empty.className='organization-empty';
    empty.textContent='暂无企业加入该产业园。';
    tenantHost.append(empty);
    return;
  }
  tenants.forEach(tenant=>{const item=document.createElement('article');item.className='department';const name=document.createElement('div');name.className='department-head';const strong=document.createElement('span');strong.textContent=String(tenant.name||'未命名企业');const status=document.createElement('span');status.className='department-count';status.textContent=String(tenant.status||'active');name.append(strong,status);const meta=document.createElement('div');meta.className='department-members';meta.textContent=String(tenant.slug||tenant.id||'');item.append(name,meta);tenantHost.append(item)});
}
function renderOverview(data){selectedOverview=data;$('issueInvite').disabled=false;const organization=data.organization;const accounts=Array.isArray(data.accounts)?data.accounts:[];const departments=new Set(accounts.map(account=>String(account.department||'').trim()).filter(Boolean));$('panelTitle').textContent=String(organization.name||'企业');$('panelMeta').textContent=String(organization.slug||'')+' · '+(organization.status==='active'?'正常运行':'已停用')+' · 创建于 '+new Date(organization.createdAt).toLocaleString('zh-CN',{hour12:false});$('metricAccounts').textContent=formatNumber(accounts.length);$('metricAdmins').textContent=formatNumber(accounts.filter(account=>account.isAdmin).length);$('metricDepartments').textContent=formatNumber(departments.size);$('metricTokens').textContent=formatNumber(data.usage&&data.usage.totalTokens);renderInvite(data.invite);renderDepartments(accounts);renderAccounts(accounts);renderPlatformPark(data)}
async function selectOrganization(organizationId,focusTitle){const organization=organizations.find(item=>item.id===organizationId);if(!organization)return;selectedOrganizationId=organizationId;sessionStorage.setItem(SELECTED_KEY,organizationId);renderOrganizations();setPanelLoading(organization);const epoch=++platformRequestEpoch;try{const data=await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/overview');if(epoch!==platformRequestEpoch||selectedOrganizationId!==organizationId)return;renderOverview(data);if(focusTitle)$('panelTitle').focus()}catch(error){if(epoch!==platformRequestEpoch)return;if(isAuthorizationError(error)){clearPlatformSession('平台令牌已失效，请重新验证');$('platformToken').focus()}else show('panelError',error.message||'企业面板加载失败')}}
async function loadOrganizations(preferredId){show('tokenError','');const data=await api('/enterprise/organizations');organizations=Array.isArray(data.organizations)?data.organizations:[];setAuthenticated(true);const preferred=organizations.find(organization=>organization.id===preferredId);const current=organizations.find(organization=>organization.id===selectedOrganizationId);const next=preferred||current||organizations[0]||null;selectedOrganizationId=next?next.id:'';renderOrganizations();if(next)await selectOrganization(next.id,false);else{$('organizationPanel').classList.add('hidden');$('emptyPanel').classList.remove('hidden')}}
async function copyText(value,label){if(!value)return;try{await navigator.clipboard.writeText(value);show('globalNotice',label+'已复制');setTimeout(()=>show('globalNotice',''),2200)}catch{show('panelError','浏览器未允许复制，请手动选择文本')}}
function resetInviteArm(){inviteArmed=false;$('issueInvite').textContent='生成新邀请码';$('issueInvite').classList.remove('armed');if(inviteArmTimer)clearTimeout(inviteArmTimer);inviteArmTimer=0}
async function issueInvite(){if(!selectedOrganizationId||!selectedOverview||selectedOverview.organization.id!==selectedOrganizationId)return;if(!inviteArmed){inviteArmed=true;$('issueInvite').textContent='再次点击确认换新';$('issueInvite').classList.add('armed');inviteArmTimer=setTimeout(resetInviteArm,5000);return}const organizationId=selectedOrganizationId;const rawMaxUses=$('platformInviteMaxUses').value.trim();const body={defaultDepartment:$('platformInviteDepartment').value.trim()||null,positionTitle:$('platformInvitePosition').value.trim()||null,defaultRole:$('platformInviteRole').value.trim()||null,maxUses:rawMaxUses?Number(rawMaxUses):null};resetInviteArm();$('issueInvite').disabled=true;try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/invite',{method:'POST',body:JSON.stringify(body)});if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('globalNotice','新的 7 天岗位邀请码已生成')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('panelError',error.message)}finally{if(selectedOrganizationId===organizationId&&selectedOverview&&selectedOverview.organization.id===organizationId)$('issueInvite').disabled=false}}
async function registerPlatformPark(event){event.preventDefault();if(!selectedOrganizationId)return;const organizationId=selectedOrganizationId;const name=$('platformParkName').value.trim();const brandName=$('platformParkBrandName').value.trim();show('panelError','');show('platformParkNotice','正在认证产业园端…');try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/park',{method:'POST',body:JSON.stringify({name,brandName:brandName||name+'服务'})});if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('platformParkNotice','该企业已认证为产业园管理方')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('panelError',error.message)}}
async function updatePlatformPark(event){event.preventDefault();if(!selectedOrganizationId||!selectedOverview||!selectedOverview.park)return;const organizationId=selectedOrganizationId;const park=selectedOverview.park;const isOwner=park.isAdminOrganization||park.adminOrganizationId===organizationId;if(!isOwner){show('panelError','只有产业园管理方可以修改园区资料');return}const button=$('platformParkSave');const name=$('platformParkEditName').value.trim();const brandName=$('platformParkEditBrandName').value.trim();show('panelError','');show('platformParkNotice','正在保存产业园资料…');button.disabled=true;button.textContent='正在保存…';try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/park',{method:'PATCH',body:JSON.stringify({name,brandName})});if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('platformParkNotice','产业园资料已更新')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('panelError',error.message)}finally{if(button.isConnected){button.disabled=false;button.textContent='保存园区资料'}}}
async function joinPlatformPark(event){event.preventDefault();if(!selectedOrganizationId)return;const organizationId=selectedOrganizationId;const inviteCode=$('platformParkJoinCode').value.trim(),address=$('platformParkJoinAddress').value.trim(),roomNumber=$('platformParkJoinRoomNumber').value.trim();show('panelError','');show('platformParkNotice','正在加入产业园…');try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/park/join',{method:'POST',body:JSON.stringify({inviteCode,address,roomNumber})});if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('platformParkNotice','该企业已加入产业园')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('panelError',error.message)}}
async function deleteAccount(button,account){if(!selectedOrganizationId)return;if(button.dataset.armed!=='true'){button.dataset.armed='true';button.classList.add('armed');button.textContent='再次点击确认';setTimeout(()=>{if(button.isConnected){button.dataset.armed='false';button.classList.remove('armed');button.textContent='删除'}},5000);return}const organizationId=selectedOrganizationId;button.disabled=true;try{await api('/enterprise/platform/organizations/'+encodeURIComponent(organizationId)+'/accounts/'+encodeURIComponent(account.id),{method:'DELETE'});if(selectedOrganizationId===organizationId){await selectOrganization(organizationId,false);show('globalNotice','账号已删除，原登录会话已撤销')}}catch(error){if(isAuthorizationError(error))clearPlatformSession('平台令牌已失效，请重新验证');else show('panelError',error.message)}finally{if(button.isConnected)button.disabled=false}}
function openCreateOrganization(){show('createError','');$('createOrganizationModal').classList.remove('hidden');$('organizationName').focus()}
function closeCreateOrganization(force){if($('createOrganization').disabled&&!force)return;$('createOrganizationModal').classList.add('hidden');$('organizationForm').reset();show('createError','');$('createStatus').textContent=''}
$('tokenForm').addEventListener('submit',async event=>{event.preventDefault();show('tokenError','');const supplied=$('platformToken').value.trim();if(supplied)token=supplied;$('openPlatform').disabled=true;$('openPlatform').textContent='正在验证…';try{await loadOrganizations(selectedOrganizationId);sessionStorage.setItem(KEY,token)}catch(error){clearPlatformSession(error.message||'平台令牌验证失败')}finally{$('openPlatform').disabled=false;$('openPlatform').textContent='进入平台工作台'}});
$('organizationSearch').addEventListener('input',renderOrganizations);
$('refreshPanel').addEventListener('click',()=>{if(selectedOrganizationId)selectOrganization(selectedOrganizationId,false)});
$('copyInviteCode').addEventListener('click',()=>copyText(selectedOverview&&selectedOverview.invite&&selectedOverview.invite.code,'邀请码'));
$('copyInviteLink').addEventListener('click',()=>copyText(selectedOverview&&selectedOverview.invite&&selectedOverview.invite.link,'企业引入链接'));
$('issueInvite').addEventListener('click',issueInvite);
$('platformParkRegisterForm').addEventListener('submit',registerPlatformPark);
$('platformParkEditForm').addEventListener('submit',updatePlatformPark);
$('platformParkJoinForm').addEventListener('submit',joinPlatformPark);
$('accountPermissionForm').addEventListener('submit',saveAccountPermission);
$('closeAccountPermission').addEventListener('click',()=>closeAccountPermission(false));
$('cancelAccountPermission').addEventListener('click',()=>closeAccountPermission(false));
$('accountPermissionModal').addEventListener('click',event=>{if(event.target===$('accountPermissionModal'))closeAccountPermission(false)});
$('openCreateOrganization').addEventListener('click',openCreateOrganization);
$('closeCreateOrganization').addEventListener('click',closeCreateOrganization);
$('cancelCreateOrganization').addEventListener('click',closeCreateOrganization);
$('createOrganizationModal').addEventListener('click',event=>{if(event.target===$('createOrganizationModal'))closeCreateOrganization()});
$('organizationForm').addEventListener('submit',async event=>{event.preventDefault();show('createError','');const button=$('createOrganization');button.disabled=true;$('createStatus').textContent='正在创建企业…';const body={name:$('organizationName').value.trim(),admin:{username:$('adminUsername').value.trim(),name:$('adminName').value.trim(),phone:$('adminPhone').value.trim()||null,password:$('adminPassword').value}};const slug=$('organizationSlug').value.trim();if(slug)body.slug=slug;try{const data=await api('/enterprise/organizations',{method:'POST',body:JSON.stringify(body)});closeCreateOrganization(true);show('globalNotice','企业「'+data.organization.name+'」已创建，首位管理员和 7 天邀请码已生效');await loadOrganizations(data.organization.id)}catch(error){if(isAuthorizationError(error)){closeCreateOrganization(true);clearPlatformSession('平台令牌已失效，请重新验证')}else show('createError',error.message)}finally{button.disabled=false;$('createStatus').textContent=''}});
$('clearToken').addEventListener('click',()=>{clearPlatformSession('');$('platformToken').focus()});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!$('accountPermissionModal').classList.contains('hidden'))closeAccountPermission(false);else if(!$('createOrganizationModal').classList.contains('hidden'))closeCreateOrganization()});
if(token){loadOrganizations(selectedOrganizationId).then(()=>sessionStorage.setItem(KEY,token)).catch(()=>clearPlatformSession('平台令牌已失效，请重新验证'))}else setAuthenticated(false);
</script></body></html>`;
}

function legacyPlatformAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 平台企业管理</title>
<style>
:root{--ink:#17211d;--muted:#66716c;--line:#d8e0dc;--paper:#f3f6f4;--panel:#fff;--accent:#176a4b;--accent-dark:#10553b;--accent-soft:#e7f2ec;--danger:#a53e35;--danger-soft:#faece9;--nav:#14231d;--shadow:0 22px 60px rgba(18,35,27,.14)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}button,input{font:inherit}button{cursor:pointer}.hidden{display:none!important}a{color:inherit}.shell{min-height:100vh;display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr)}.rail{background:var(--nav);color:#eef6f2;padding:36px 30px;display:flex;flex-direction:column}.brand{font-size:26px;font-weight:850;letter-spacing:-.05em}.brand b{color:#69d5ab}.rail-copy{margin:auto 0}.eyebrow{font-size:11px;letter-spacing:.13em;font-weight:800;color:#60cda3}.rail h1{font-size:36px;line-height:1.08;letter-spacing:-.045em;margin:13px 0}.rail p{color:#a5b7ae}.rail a{color:#d6e5de;text-decoration:none;border:1px solid #40564d;border-radius:8px;padding:9px 12px;text-align:center}.workspace{padding:38px clamp(24px,5vw,70px) 64px;min-width:0}.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.topbar h2{font-size:31px;letter-spacing:-.04em;margin:4px 0}.topbar p{color:var(--muted);margin:0}.status{display:inline-flex;align-items:center;gap:7px;background:var(--accent-soft);color:#245f49;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:750}.status:before{content:'';width:7px;height:7px;border-radius:50%;background:#2c9369}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(18,35,27,.04);padding:22px;margin-bottom:16px}.card h3{font-size:18px;margin:0 0 5px}.card>p{color:var(--muted);margin:0 0 18px}.token-row{display:grid;grid-template-columns:minmax(220px,1fr) auto auto;gap:10px}.field{display:grid;gap:6px}.field label{font-size:12px;font-weight:750;color:#46534d}.field input{height:44px;border:1px solid #c8d3cd;border-radius:8px;padding:0 12px;outline:none}.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.11)}.primary,.secondary{height:44px;border-radius:8px;padding:0 15px;font-weight:750}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff}.primary:hover{background:var(--accent-dark)}.secondary{border:1px solid #c8d3cd;background:#fff;color:var(--ink)}.primary:disabled,.secondary:disabled{opacity:.5;cursor:default}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.wide{grid-column:1/-1}.form-actions{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:18px}.error,.notice{padding:10px 12px;border-radius:8px;margin-top:13px}.error{color:var(--danger);background:var(--danger-soft);border:1px solid #ecc8c2}.notice{color:#245f49;background:var(--accent-soft);border:1px solid #cfe3d8}.organization-list{display:grid;gap:10px}.organization{border:1px solid var(--line);border-radius:10px;padding:15px 17px;display:flex;align-items:center;justify-content:space-between;gap:18px}.organization strong{display:block;font-size:15px}.organization small{display:block;color:var(--muted);margin-top:3px}.badge{background:var(--accent-soft);color:#245f49;border-radius:999px;padding:5px 9px;font-size:11px;font-weight:750}.empty{color:var(--muted);padding:22px 0;text-align:center}.count{color:var(--muted);font-size:12px}
@media(max-width:820px){.shell{display:block}.rail{min-height:auto;padding:22px 24px;gap:24px}.rail-copy{margin:20px 0}.rail h1{font-size:30px}.workspace{padding:25px 16px 44px}.topbar{align-items:flex-start;flex-direction:column}.token-row{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.organization{align-items:flex-start;flex-direction:column}}
</style></head><body>
<main class="shell">
  <aside class="rail"><div class="brand">otto<b>✦</b></div><div class="rail-copy"><div class="eyebrow">PLATFORM CONTROL</div><h1>平台企业管理</h1><p>创建多个相互隔离的企业，为每个企业设置首位管理员，并随时查看组织清单。</p></div><a href="/enterprise/admin">返回企业管理员登录</a></aside>
  <section class="workspace">
    <header class="topbar"><div><div class="eyebrow">MULTI-ORGANIZATION</div><h2>企业总览</h2><p>平台令牌只保存在当前标签页，关闭标签页后自动清除。</p></div><span id="authStatus" class="status hidden">平台身份已验证</span></header>
    <section class="card"><h3>验证平台身份</h3><p>输入服务器部署时配置的管理令牌。企业管理员账号不能访问此页面。</p><form id="tokenForm" class="token-row"><div class="field"><label for="platformToken">平台管理令牌</label><input id="platformToken" type="password" autocomplete="off" required></div><button id="openPlatform" class="primary" type="submit">打开企业总览</button><button id="clearToken" class="secondary" type="button">清除令牌</button></form><div id="tokenError" class="error hidden" role="alert"></div></section>
    <div id="platformWorkspace" class="hidden">
      <section class="card"><h3>创建企业</h3><p>每次提交都会创建一套独立企业空间、首位管理员和企业邀请码。</p><form id="organizationForm"><div class="grid">
        <div class="field"><label for="organizationName">企业名称</label><input id="organizationName" maxlength="80" required placeholder="例如：星河科技"></div>
        <div class="field"><label for="organizationSlug">企业标识</label><input id="organizationSlug" maxlength="48" pattern="[a-z0-9-]+" placeholder="可选，例如：galaxy-tech"></div>
        <div class="field"><label for="adminUsername">首位管理员用户名</label><input id="adminUsername" autocomplete="off" required></div>
        <div class="field"><label for="adminName">首位企业管理员姓名</label><input id="adminName" autocomplete="name" required></div>
        <div class="field"><label for="adminPhone">管理员手机号</label><input id="adminPhone" inputmode="tel" autocomplete="tel" placeholder="可选"></div>
        <div class="field"><label for="adminPassword">管理员初始密码</label><input id="adminPassword" type="password" minlength="8" autocomplete="new-password" required></div>
      </div><div class="form-actions"><span id="createStatus" class="count" role="status" aria-live="polite"></span><button id="createOrganization" class="primary" type="submit">创建企业</button></div><div id="createError" class="error hidden" role="alert"></div><div id="createNotice" class="notice hidden" role="status"></div></form></section>
      <section class="card"><div style="display:flex;align-items:center;justify-content:space-between;gap:16px"><div><h3>已创建企业</h3><p style="margin:0;color:var(--muted)">企业之间账号、邀请码和数据完全隔离。</p></div><span id="organizationCount" class="count">0 个企业</span></div><div id="organizationList" class="organization-list" style="margin-top:17px"></div><div id="listError" class="error hidden" role="alert"></div></section>
    </div>
  </section>
</main>
<script>
const KEY='otto.enterprise.platform.session';
let token=sessionStorage.getItem(KEY)||'';
const $=id=>document.getElementById(id);
function show(id,message){const element=$(id);element.textContent=message||'';element.classList.toggle('hidden',!message)}
function setAuthenticated(authenticated){$('platformWorkspace').classList.toggle('hidden',!authenticated);$('authStatus').classList.toggle('hidden',!authenticated);$('platformToken').value='';if(!authenticated){$('organizationList').replaceChildren();$('organizationCount').textContent='0 个企业'}}
async function api(path,options){const response=await fetch(path,Object.assign({},options||{},{headers:Object.assign({'content-type':'application/json'},options&&options.headers||{},token?{authorization:'Bearer '+token}:{})}));const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.error||('请求失败 '+response.status));error.status=response.status;throw error}return data}
function renderOrganizations(organizations){const list=$('organizationList');list.replaceChildren();$('organizationCount').textContent=organizations.length+' 个企业';if(!organizations.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='还没有企业，请先创建第一家企业';list.append(empty);return}organizations.forEach(organization=>{const row=document.createElement('article');row.className='organization';const copy=document.createElement('div');const name=document.createElement('strong');name.textContent=String(organization.name||'未命名企业');const meta=document.createElement('small');meta.textContent=String(organization.slug||'')+' · 创建于 '+new Date(organization.createdAt).toLocaleString('zh-CN',{hour12:false});copy.append(name,meta);const badge=document.createElement('span');badge.className='badge';badge.textContent=organization.status==='active'?'正常运行':String(organization.status||'未知');row.append(copy,badge);list.append(row)})}
async function loadOrganizations(){show('listError','');const data=await api('/enterprise/organizations');renderOrganizations(data.organizations||[]);setAuthenticated(true)}
function clearPlatformSession(message){token='';sessionStorage.removeItem(KEY);setAuthenticated(false);if(message)show('tokenError',message)}
$('tokenForm').addEventListener('submit',async event=>{event.preventDefault();show('tokenError','');const supplied=$('platformToken').value.trim();if(supplied)token=supplied;$('openPlatform').disabled=true;$('openPlatform').textContent='正在验证…';try{await loadOrganizations();sessionStorage.setItem(KEY,token)}catch(error){clearPlatformSession(error.message||'平台令牌验证失败')}finally{$('openPlatform').disabled=false;$('openPlatform').textContent='打开企业总览'}});
$('clearToken').addEventListener('click',()=>{clearPlatformSession('');$('platformToken').focus()});
$('organizationForm').addEventListener('submit',async event=>{event.preventDefault();show('createError','');show('createNotice','');const button=$('createOrganization');button.disabled=true;$('createStatus').textContent='正在创建企业…';const body={name:$('organizationName').value.trim(),admin:{username:$('adminUsername').value.trim(),name:$('adminName').value.trim(),phone:$('adminPhone').value.trim()||null,password:$('adminPassword').value}};const slug=$('organizationSlug').value.trim();if(slug)body.slug=slug;try{const data=await api('/enterprise/organizations',{method:'POST',body:JSON.stringify(body)});$('organizationForm').reset();show('createNotice','企业「'+data.organization.name+'」已创建；首位管理员 @'+data.admin.username+'；邀请码 '+data.invite.code);await loadOrganizations()}catch(error){if(error.status===401||error.status===403){clearPlatformSession('平台令牌已失效，请重新验证');$('platformToken').focus()}else show('createError',error.message)}finally{button.disabled=false;$('createStatus').textContent=''}});
if(token){loadOrganizations().catch(()=>clearPlatformSession('平台令牌已失效，请重新验证'))}else setAuthenticated(false);
</script></body></html>`;
}

function adminDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto Enterprise Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'PingFang SC',Helvetica,Arial,sans-serif}
body{background:#0f172a;color:#e2e8f0;padding:24px}
.header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.header h1{font-size:24px;color:#60a5fa;letter-spacing:.5px}
.header span{color:#64748b;font-size:13px}
.note{color:#64748b;font-size:12px;margin-bottom:20px}
.note b{color:#fb923c}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:26px}
.card{background:#1e293b;border-radius:12px;padding:18px 20px;border:1px solid #334155}
.card .label{color:#94a3b8;font-size:12px;letter-spacing:.5px;display:flex;gap:6px;align-items:center}
.card .est{font-size:10px;color:#fb923c;border:1px solid #fb923c55;border-radius:4px;padding:0 4px}
.card .value{font-size:30px;font-weight:700;margin-top:10px;color:#f1f5f9}
.card .sub{color:#64748b;font-size:12px;margin-top:5px}
.card .value.green{color:#4ade80}.card .value.blue{color:#60a5fa}.card .value.orange{color:#fb923c}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
th{background:#334155;padding:11px 12px;text-align:left;font-size:12px;color:#94a3b8;font-weight:600}
td{padding:10px 12px;border-top:1px solid #334155;font-size:13px}
.section{margin-bottom:26px}
.section h2{font-size:16px;color:#94a3b8;margin-bottom:11px}
.empty{color:#475569;font-size:13px;padding:14px;text-align:center}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;margin-bottom:26px}
.chart-card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 18px}
.chart-card h3{font-size:14px;color:#94a3b8;margin-bottom:12px;font-weight:600}
.chart-card svg{width:100%;height:auto;display:block}
.chart-empty{color:#475569;font-size:13px;padding:28px 0;text-align:center}
.bottlenecks{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.bn{background:#1e293b;border:1px solid #334155;border-left:3px solid #fb923c;border-radius:8px;padding:12px 14px}
.bn .k{color:#94a3b8;font-size:12px;margin-bottom:6px}
.bn .t{color:#f1f5f9;font-size:15px;font-weight:600}
.bn .m{color:#64748b;font-size:12px;margin-top:4px}
.auth-notice{max-width:680px;margin:18px 0 24px;padding:16px 18px;border:1px solid #475569;border-radius:10px;background:#1e293b;color:#cbd5e1}
.auth-notice p{margin:0 0 10px;line-height:1.6}.auth-notice form{display:flex;gap:8px;flex-wrap:wrap}.auth-notice input{min-width:260px;flex:1;padding:9px 11px;border:1px solid #475569;border-radius:7px;background:#0f172a;color:#f8fafc}.auth-notice button,.auth-notice a{display:inline-block;padding:9px 12px;border:1px solid #60a5fa;border-radius:7px;background:#2563eb;color:#fff;text-decoration:none;cursor:pointer}.auth-notice a{background:transparent}.hidden{display:none!important}
</style>
</head><body>
<div class="header"><h1>Otto Enterprise</h1><span id="updateTime"></span></div>
<div class="note" id="discloseNote">数据全部存在本机 <b>~/.otto-enterprise/data.db</b>，零云端。标 <b>估算</b> 的指标基于假设，非实测。</div>
<section id="authNotice" class="auth-notice hidden" aria-labelledby="authTitle">
  <p id="authTitle">看板需要管理员会话。可先前往账号管理登录，或粘贴服务器生成的平台管理令牌；令牌只保存在当前标签页。</p>
  <form id="dashboardTokenForm"><input id="dashboardToken" type="password" autocomplete="off" aria-label="平台管理令牌" placeholder="粘贴平台管理令牌"><button type="submit">打开看板</button><a href="/enterprise/admin">前往管理员登录</a></form>
</section>
<div class="grid" id="cards"></div>
<div class="charts">
  <div class="chart-card"><h3>各任务类型：耗时与次数</h3><div id="barChart"></div></div>
  <div class="chart-card"><h3>累计省时趋势（按任务累积）</h3><div id="lineChart"></div></div>
</div>
<div class="section"><h2>瓶颈提示</h2><div class="bottlenecks" id="bottlenecks"></div></div>
<div class="section"><h2>各任务类型 Token 花费</h2>
  <table id="taskTable"><thead><tr><th>任务类型</th><th>次数</th><th>时长(分)</th><th>Tokens</th><th>成本(元)</th></tr></thead><tbody></tbody></table></div>
<div class="section"><h2>员工</h2>
  <table id="empTable"><thead><tr><th>姓名</th><th>岗位</th><th>部门</th><th>状态</th><th>入职时间</th></tr></thead><tbody></tbody></table></div>
<div class="section"><h2>最近动态</h2>
  <table id="auditTable"><thead><tr><th>时间</th><th>事件</th><th>员工</th><th>详情</th></tr></thead><tbody></tbody></table></div>
<script>
const KEY='otto.enterprise.admin.session';
let TOKEN=sessionStorage.getItem(KEY)||'';
const authNotice=document.getElementById('authNotice');
function headers(){return TOKEN?{authorization:'Bearer '+TOKEN}:{}}
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function requireAuth(message){TOKEN='';sessionStorage.removeItem(KEY);authNotice.classList.remove('hidden');document.getElementById('updateTime').textContent=message||'请先登录'}
async function j(u){const r=await fetch(u,{headers:headers()});if(r.status===401||r.status===403){requireAuth('管理员会话已失效');throw new Error('管理员会话已失效')}if(!r.ok)throw new Error(u+' '+r.status);return r.json();}
// ---- 内联 SVG 图表（无外部依赖，CSP 友好）----
function barChartSVG(rows){
  if(!rows||!rows.length)return '<div class="chart-empty">暂无任务数据</div>';
  // padR 需容纳「NN分 · N次」标签；条形最长只画到 barMax，剩余留给外侧标签，避免标签越界或与条末端重叠。
  const W=460,H=40+rows.length*34,padL=90,padR=96,barH=18,labelGap=6,fontSize=11;
  const maxMin=Math.max(1,...rows.map(r=>r.minutes));
  const barMax=W-padL-padR;
  let s='<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="各任务类型耗时柱状图">';
  rows.forEach((r,i)=>{
    const y=i*34+24;
    const w=Math.max(Math.round(barMax*r.minutes/maxMin),2);
    const label=r.minutes+'分 · '+r.count+'次';
    // 估算标签像素宽（数字/点/空格约 0.55em、中文约 1em），用于判断外侧是否放得下。
    const labelW=[...label].reduce((n,ch)=>n+(/[0-9.\\s·]/.test(ch)?fontSize*0.55:fontSize),0);
    const ty=y+barH-5;
    s+='<text x="'+(padL-8)+'" y="'+ty+'" text-anchor="end" fill="#94a3b8" font-size="12">'+esc(r.taskType)+'</text>';
    s+='<rect x="'+padL+'" y="'+y+'" width="'+w+'" height="'+barH+'" rx="4" fill="#60a5fa"/>';
    // 外侧放得下 → 外侧左对齐；否则塞进条内右对齐（白字），两种情形都不会与条末端重叠或越界。
    if(padL+w+labelGap+labelW<=W-4){
      s+='<text x="'+(padL+w+labelGap)+'" y="'+ty+'" fill="#e2e8f0" font-size="'+fontSize+'">'+label+'</text>';
    }else{
      s+='<text x="'+(padL+w-labelGap)+'" y="'+ty+'" text-anchor="end" fill="#0f172a" font-size="'+fontSize+'" font-weight="600">'+label+'</text>';
    }
  });
  s+='</svg>';return s;
}
function lineChartSVG(trend){
  if(!trend||trend.length<2)return '<div class="chart-empty">数据点不足，无法绘制趋势</div>';
  const W=460,H=200,padL=44,padR=16,padT=16,padB=28;
  const n=trend.length;
  const maxY=Math.max(1,...trend.map(p=>p.cumSavedHours));
  const px=i=>padL+(W-padL-padR)*(n===1?0:i/(n-1));
  const py=v=>padT+(H-padT-padB)*(1-v/maxY);
  let path='';
  trend.forEach((p,i)=>{path+=(i?'L':'M')+px(i).toFixed(1)+' '+py(p.cumSavedHours).toFixed(1)+' ';});
  const area=path+'L'+px(n-1).toFixed(1)+' '+py(0)+' L'+px(0).toFixed(1)+' '+py(0)+' Z';
  let s='<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="累计省时趋势折线图">';
  // 网格 + Y 轴刻度
  for(let g=0;g<=2;g++){const v=maxY*g/2;const y=py(v);s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="#334155" stroke-width="1"/>';s+='<text x="'+(padL-6)+'" y="'+(y+4)+'" text-anchor="end" fill="#64748b" font-size="10">'+(Math.round(v*10)/10)+'h</text>';}
  s+='<path d="'+area+'" fill="#4ade8022"/>';
  s+='<path d="'+path.trim()+'" fill="none" stroke="#4ade80" stroke-width="2"/>';
  s+='<text x="'+padL+'" y="'+(H-8)+'" fill="#64748b" font-size="10">第1个任务</text>';
  s+='<text x="'+(W-padR)+'" y="'+(H-8)+'" text-anchor="end" fill="#64748b" font-size="10">第'+n+'个任务</text>';
  s+='</svg>';return s;
}
function bottlenecksHTML(b){
  if(!b)return '<div class="chart-empty">暂无数据</div>';
  const items=[];
  if(b.slowestTotal)items.push({k:'累计最耗时',t:b.slowestTotal.taskType,m:'共 '+b.slowestTotal.minutes+' 分钟'});
  if(b.mostFrequent)items.push({k:'最频繁',t:b.mostFrequent.taskType,m:'共 '+b.mostFrequent.count+' 次'});
  if(b.slowestAvg)items.push({k:'单次平均最慢',t:b.slowestAvg.taskType,m:'平均 '+b.slowestAvg.avgMinutes+' 分钟/次'});
  if(!items.length)return '<div class="chart-empty">暂无数据</div>';
  return items.map(x=>'<div class="bn"><div class="k">'+x.k+'</div><div class="t">'+esc(x.t)+'</div><div class="m">'+x.m+'</div></div>').join('');
}
async function load(){
  if(!TOKEN){requireAuth('请先登录');return}
  authNotice.classList.add('hidden');
  try{
    const [report,emps,audit]=await Promise.all([j('/enterprise/report?period=30'),j('/enterprise/employees'),j('/enterprise/audit')]);
    document.getElementById('updateTime').textContent='更新于 '+new Date().toLocaleTimeString();
    const est='<span class="est">估算</span>';
    const a=report.assumptions||{manualTimeMultiplier:2,cnyPerHour:50};
    // 披露文案直接引用后端返回的假设常量，不再手写数字，杜绝文案与代码打架。
    document.getElementById('discloseNote').innerHTML='数据全部存在本机 <b>~/.otto-enterprise/data.db</b>，零云端。标 '+est+' 的指标基于假设（纯人工耗时按 <b>'+a.manualTimeMultiplier+'×</b> Otto 折算、人力 <b>¥'+a.cnyPerHour+'/时</b>），非实测。省时 = Otto 耗时 ×（倍率−1），只算净节省、不双算。';
    const cards=[
      {l:'总任务数',v:report.totalTasks,c:'blue',s:'近 30 天',e:0},
      {l:'省下时间',v:report.timeSavedHours+'h',c:'green',s:'约 '+(report.timeSavedHours/8).toFixed(1)+' 个工作日（净节省）',e:1},
      {l:'省下人力成本',v:'¥'+report.laborSavedCNY,c:'green',s:'按 ¥'+a.cnyPerHour+'/时折算',e:1},
      {l:'Token 成本',v:'¥'+report.tokenCostCNY,c:'orange',s:(report.totalTokens||0)+' tokens',e:0},
      {l:'净收益',v:'¥'+report.netBenefitCNY,c:(report.netBenefitCNY>=0?'green':'orange'),s:'省下人力 − Token 成本',e:1},
      {l:'每 ¥1 Token 产出',v:'¥'+report.laborPerTokenCNY,c:'blue',s:report.laborPerTokenCapped?('已封顶 ¥'+(a.laborPerTokenCap||50)+'（估算，防极端值）'):'估算省下的人力（非纯倍率）',e:1},
      {l:'活跃员工',v:report.activeEmployees,c:'blue',s:'正在使用 Otto',e:0},
    ];
    document.getElementById('cards').innerHTML=cards.map(c=>'<div class="card"><div class="label">'+c.l+(c.e?est:'')+'</div><div class="value '+c.c+'">'+c.v+'</div><div class="sub">'+c.s+'</div></div>').join('');
    document.getElementById('barChart').innerHTML=barChartSVG(report.byType);
    document.getElementById('lineChart').innerHTML=lineChartSVG(report.trend);
    document.getElementById('bottlenecks').innerHTML=bottlenecksHTML(report.bottlenecks);
    const tb=document.querySelector('#taskTable tbody');
    tb.innerHTML=report.byType.length?report.byType.map(t=>'<tr><td>'+esc(t.taskType)+'</td><td>'+t.count+'</td><td>'+t.minutes+'</td><td>'+t.tokens+'</td><td>'+t.costCNY+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">暂无任务数据</td></tr>';
    const eb=document.querySelector('#empTable tbody');
    eb.innerHTML=emps.employees.length?emps.employees.map(e=>'<tr><td>'+esc(e.name)+'</td><td>'+esc(e.role||'-')+'</td><td>'+esc(e.department||'-')+'</td><td>'+esc(e.status)+'</td><td>'+esc(e.onboarded_at)+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">暂无员工</td></tr>';
    const ab=document.querySelector('#auditTable tbody');
    ab.innerHTML=audit.logs.length?audit.logs.slice(0,15).map(l=>'<tr><td>'+esc(l.created_at)+'</td><td>'+esc(l.event)+'</td><td>'+esc(l.employee_id)+'</td><td>'+esc(l.detail)+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">暂无动态</td></tr>';
  }catch(err){document.getElementById('updateTime').textContent='加载失败：'+err.message;}
}
document.getElementById('dashboardTokenForm').addEventListener('submit',event=>{event.preventDefault();const value=document.getElementById('dashboardToken').value.trim();if(!value)return;TOKEN=value;sessionStorage.setItem(KEY,TOKEN);document.getElementById('dashboardToken').value='';load()});
load();setInterval(()=>{if(TOKEN)load()},10000);
</script>
</body></html>`;
}

/**
 * 组装企业服务端（不 listen）。会算好 host/port/token：
 * 监听非本地又没给 token → 自动生成一枚并回传（调用方负责打印/落盘），绝不裸奔。
 */
export function createEnterpriseServer(opts: EnterpriseServerOptions = {}): {
  server: Server;
  host: string;
  port: number;
  publicBaseUrl: string;
  adminToken: string;
  generatedToken: boolean;
} {
  const host = opts.host || process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1';
  const port = opts.port
    ?? parseInt(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT), 10);
  const publicBaseUrl = resolveEnterprisePublicBaseUrl({
    configuredUrl: opts.publicUrl ?? process.env.OTTO_ENTERPRISE_PUBLIC_URL,
    host,
    port,
  });
  let adminToken = opts.adminToken ?? process.env.OTTO_ENTERPRISE_ADMIN_TOKEN ?? '';
  let generatedToken = false;
  if (!adminToken && !isLoopback(host)) {
    adminToken = randomBytes(18).toString('base64url');
    generatedToken = true;
  }
  const hasSmsEnv = Boolean(
    process.env.ALIYUN_SMS_ACCESS_KEY_ID
    && process.env.ALIYUN_SMS_ACCESS_KEY_SECRET
    && process.env.ALIYUN_SMS_SIGN_NAME
    && process.env.ALIYUN_SMS_TEMPLATE_ID,
  );
  const smsSender = opts.smsSender === undefined
    ? (hasSmsEnv ? createAliyunLoginSmsFromEnv() : null)
    : opts.smsSender;
  const repairSmsSender = opts.repairSmsSender === undefined
    ? createRepairSmsSenderFromEnv()
    : opts.repairSmsSender;
  const repairFeishuSender = opts.repairFeishuSender === undefined
    ? createRepairFeishuSenderFromEnv()
    : opts.repairFeishuSender;
  const version = opts.appVersion?.trim()
    || process.env.OTTO_APP_VERSION?.trim()
    || 'unknown';
  const buildCommit = opts.buildCommit?.trim()
    || process.env.OTTO_BUILD_COMMIT?.trim()
    || process.env.GITHUB_SHA?.trim()
    || 'unknown';
  const configuredProxyHops = nonNegativeInteger(
    opts.loginRateLimit?.trustedProxyHops
      ?? Number(process.env.OTTO_ENTERPRISE_TRUST_PROXY_HOPS),
    0,
    5,
  );
  const configuredProxyAddresses = opts.loginRateLimit?.trustedProxyAddresses
    ?? process.env.OTTO_ENTERPRISE_TRUSTED_PROXIES?.split(',')
      .map((address) => address.trim())
      .filter(Boolean)
    ?? [];
  const loginRateLimiter = createLoginRateLimiter({
    ...opts.loginRateLimit,
    trustedProxyHops: configuredProxyHops,
    trustedProxyAddresses: configuredProxyAddresses,
  });
  const featureFlags = new FeatureFlagManager(new ProjectSettingsManager(process.cwd()));
  const server = createServer(makeHandler(
    adminToken,
    smsSender,
    repairSmsSender,
    repairFeishuSender,
    publicBaseUrl,
    loginRateLimiter,
    {
      version,
      buildCommit,
      startedAt: new Date().toISOString(),
    },
    opts.localAgentPairingEnabled === true,
    featureFlags,
  ));
  return { server, host, port, publicBaseUrl, adminToken, generatedToken };
}

function persistGeneratedAdminToken(token: string): string {
  const directory = process.env.OTTO_ENTERPRISE_DIR
    || path.join(os.homedir(), '.otto-enterprise');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // 某些受限文件系统不支持 chmod；写文件仍使用最小权限。
  }
  const tokenPath = path.join(directory, 'admin-token');
  fs.writeFileSync(tokenPath, `${token}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // 同上；创建时的 mode 已是主防线。
  }
  return tokenPath;
}

function validatedStartOptions(opts: EnterpriseServerOptions): EnterpriseServerOptions {
  const host = opts.host || process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1';
  if (isLoopback(host)) return opts;

  const appVersion = opts.appVersion?.trim()
    || process.env.OTTO_APP_VERSION?.trim()
    || '';
  const buildCommit = opts.buildCommit?.trim()
    || process.env.OTTO_BUILD_COMMIT?.trim()
    || process.env.GITHUB_SHA?.trim()
    || '';
  const errors: string[] = [];
  if (!appVersion || appVersion.toLowerCase() === 'unknown') {
    errors.push('OTTO_APP_VERSION 必须设置为明确的发布版本');
  }
  if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
    errors.push('OTTO_BUILD_COMMIT 必须是完整的 40 位十六进制 Git SHA');
  }
  if (errors.length > 0) {
    throw new Error(`[Otto Enterprise] 拒绝非 loopback 启动：${errors.join('；')}`);
  }
  return {
    ...opts,
    host,
    appVersion,
    buildCommit,
  };
}

/** 组装并 listen；返回 http.Server。访问地址不包含凭证，自动令牌只落 0600 文件。 */
export function startEnterpriseServer(opts: EnterpriseServerOptions = {}): Server {
  const validatedOptions = validatedStartOptions(opts);
  const {
    server,
    host,
    port,
    publicBaseUrl,
    adminToken,
    generatedToken,
  } = createEnterpriseServer(validatedOptions);
  const generatedTokenPath = generatedToken
    ? persistGeneratedAdminToken(adminToken)
    : null;
  server.listen(port, host, () => {
    console.log(`[Otto Enterprise] 服务端运行于 http://${host}:${port}`);
    console.log(`[Otto Enterprise] 账号管理: http://localhost:${port}/enterprise/admin`);
    console.log(`[Otto Enterprise] 企业引入: ${publicBaseUrl}/enterprise/join/{邀请码}`);
    console.log(`[Otto Enterprise] 老板看板: http://localhost:${port}/enterprise/dashboard`);
    console.log(`[Otto Enterprise] 数据: ~/.otto-enterprise/data.db（本地，零云端）`);
    if (generatedTokenPath) {
      console.log(`[Otto Enterprise] 自动生成的管理令牌已安全保存: ${generatedTokenPath}`);
    } else if (adminToken) {
      console.log('[Otto Enterprise] 已使用环境中配置的平台管理令牌（不会输出令牌内容）');
    } else {
      console.log('[Otto Enterprise] 未配置平台令牌；管理页面仍要求管理员账号登录');
    }
    console.log('[Otto Enterprise] 积分管理: http://localhost:' + port + '/enterprise/admin/credits');
  console.log('[Otto Enterprise] Ctrl+C 停止');
  });
  return server;
}


function adminCreditsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Otto 积分管理</title>
<style>
:root{--ink:#18221e;--muted:#66716c;--line:#dce3df;--panel:#fff;--subtle:#edf2ef;--accent:#176a4b;--accent-hover:#11563c;--accent-soft:#e5f1eb;--danger:#aa3f35;--danger-soft:#faece9;--radius:10px;--shadow:0 12px 36px rgba(26,42,34,.12)}
*{box-sizing:border-box}body{margin:0;background:#f4f6f5;color:var(--ink);font-family:Inter,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.5}
button,input{font:inherit}button{cursor:pointer}:focus-visible{outline:3px solid rgba(23,106,75,.24);outline-offset:2px}
.hidden{display:none!important}
.header{background:var(--panel);border-bottom:1px solid var(--line);padding:16px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:5}
.header h1{font-size:22px;margin:0;letter-spacing:-.02em}
.header a{color:var(--muted);font-size:12px}
.main{max-width:960px;margin:0 auto;padding:28px 20px 60px}
.auth-notice{max-width:720px;margin:28px auto 0;padding:18px 20px;border:1px solid var(--line);border-left:4px solid var(--danger);border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow)}
.auth-notice h2{font-size:17px;margin:0 0 7px}.auth-notice p{color:var(--muted);margin:0 0 13px}.auth-notice a{display:inline-block;color:#fff;background:var(--accent);border-radius:7px;padding:9px 13px;text-decoration:none;font-weight:700}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;margin-bottom:20px}
.card h2{font-size:16px;margin:0 0 14px;letter-spacing:-.015em}
.balance{display:flex;gap:24px;flex-wrap:wrap}
.balance-item{flex:1;min-width:140px;padding:16px;background:var(--subtle);border-radius:8px;text-align:center}
.balance-item strong{display:block;font-size:32px;letter-spacing:-.03em;line-height:1.1}
.balance-item span{display:block;color:var(--muted);font-size:11px;margin-top:6px}
.balance-item.warn strong{color:var(--danger)}
.balance-item.ok strong{color:var(--accent)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.field{display:grid;gap:6px;margin:10px 0}
.field label{font-size:12px;font-weight:700;color:#46534d}
.field input,.field select{width:100%;height:40px;border:1px solid var(--line);border-radius:7px;padding:0 10px;background:#fff;color:var(--ink);outline:none}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.1)}
.btn{border-radius:7px;font-weight:700;padding:9px 15px;transition:.14s;border:1px solid var(--accent);background:var(--accent);color:#fff}
.btn:hover{background:var(--accent-hover)}
.btn-outline{border:1px solid var(--line);background:#fff;color:var(--ink)}
.btn-outline:hover{background:#f8faf9}
.btn-danger{border:1px solid var(--danger);background:var(--danger);color:#fff;margin-left:8px}
.btn-danger:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:default}
.code-list{display:grid;gap:6px;max-height:300px;overflow:auto}
.code-row{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--subtle);border-radius:7px;border:1px solid var(--line)}
.code-row b{font:bold 15px/1 monospace;letter-spacing:.04em}
.code-row span{font-size:11px;color:var(--muted)}
.code-row.redeemed{opacity:.5}
.txn-table{width:100%;font-size:12px;border-collapse:collapse}
.txn-table th{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px}
.txn-table td{padding:9px 10px;border-top:1px solid var(--line)}
.txn-table .plus{color:var(--accent)}
.txn-table .minus{color:var(--danger)}
.empty{text-align:center;color:var(--muted);padding:28px}
.msg{padding:10px 12px;border-radius:7px;margin:10px 0;font-size:12px}
.msg-ok{background:var(--accent-soft);color:var(--accent)}
.msg-err{background:var(--danger-soft);color:var(--danger)}
.nav-back{margin-bottom:20px}
.nav-back a{color:var(--muted);font-size:12px}
</style></head><body>
<div class="header"><h1>💰 Otto 企业积分管理</h1><div><a href="/enterprise/admin">← 返回账号管理</a></div></div>
<section id="authNotice" class="auth-notice hidden" aria-labelledby="authTitle">
  <h2 id="authTitle">需要管理员登录</h2>
  <p id="authMessage">请先返回账号管理页完成管理员登录，再进入积分管理。</p>
  <a href="/enterprise/admin">返回管理员登录</a>
</section>
<main id="creditsContent" class="main">
  <div class="card" id="balanceCard"><h2>积分余额</h2><div class="balance"><div class="balance-item ok"><strong id="bal">--</strong><span>可用积分</span></div><div class="balance-item"><strong id="todayConsumed">--</strong><span>今日消耗</span></div><div class="balance-item"><strong id="totalConsumed">--</strong><span>累计消耗</span></div><div class="balance-item"><strong id="totalTopped">--</strong><span>累计充值</span></div></div></div>

  <div class="card"><h2>管理员直接充值</h2>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <div class="field" style="flex:1;margin:0"><label>充值积分数量</label><input id="topupAmount" type="number" min="1" value="1000" placeholder="输入积分数量"></div>
      <div class="field" style="flex:1;margin:0"><label>备注</label><input id="topupNote" placeholder="充值备注（可选）"></div>
      <button id="topupButton" class="btn" type="button" style="height:40px;white-space:nowrap">确认充值</button>
    </div><div id="topupMsg"></div>
  </div>

  <div class="card"><h2>生成兑换码</h2>
    <div style="display:flex;gap:10px;align-items:flex-end">
      <div class="field" style="flex:1;margin:0"><label>单个面额</label><input id="codeAmount" type="number" min="1" value="100" placeholder="面额"></div>
      <div class="field" style="flex:0 0 80px;margin:0"><label>数量</label><input id="codeCount" type="number" min="1" max="100" value="10"></div>
      <button id="createCodesButton" class="btn" type="button" style="height:40px">生成</button>
    </div><div id="codeMsg"></div>
  </div>

  <div class="card"><h2>兑换码列表</h2>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <button class="btn btn-outline" type="button" data-code-status="active">可用</button>
      <button class="btn btn-outline" type="button" data-code-status="redeemed">已用</button>
      <button class="btn btn-outline" type="button" data-code-status="revoked">已作废</button>
      <button class="btn btn-outline" type="button" data-code-status="">全部</button>
    </div>
    <div id="codeList" class="code-list"><div class="empty">点击上方按钮加载</div></div>
  </div>

  <div class="card"><h2>交易流水</h2>
    <div style="max-height:300px;overflow:auto"><table class="txn-table"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>操作人</th><th>说明</th></tr></thead><tbody id="txnBody"><tr><td colspan="5" class="empty">加载中...</td></tr></tbody></table></div></div>
</main>
<script>
function $(id){return document.getElementById(id)}
const KEY='otto.enterprise.admin.session';
let TOKEN=sessionStorage.getItem(KEY)||'';
function finiteNumber(value){const number=Number(value);return Number.isFinite(number)?number:0}
function formatNumber(value){return new Intl.NumberFormat('zh-CN').format(finiteNumber(value))}
function authorizationError(message){const error=new Error(message);error.authorization=true;return error}
function requireAdminLogin(message){TOKEN='';sessionStorage.removeItem(KEY);$('authMessage').textContent=message||'请先返回账号管理页完成管理员登录，再进入积分管理。';$('authNotice').classList.remove('hidden');$('creditsContent').classList.add('hidden')}
function showCredits(){$('authNotice').classList.add('hidden');$('creditsContent').classList.remove('hidden')}
async function api(path,options){
  if(!TOKEN){requireAdminLogin('请先返回账号管理页完成管理员登录，再进入积分管理。');throw authorizationError('需要管理员登录')}
  const request=Object.assign({},options||{});
  request.headers=Object.assign({'content-type':'application/json','authorization':'Bearer '+TOKEN},request.headers||{});
  const r=await fetch(path,request);
  const data=await r.json().catch(()=>({}));
  if(r.status===401||r.status===403){requireAdminLogin('管理员登录已失效，请返回账号管理页重新登录。');throw authorizationError('管理员登录已失效')}
  if(!r.ok)throw new Error(data.error||'请求失败');
  return data
}
function msg(element,text,ok){
  const box=document.createElement('div');
  box.className='msg msg-'+(ok?'ok':'err');
  box.textContent=String(text||'');
  element.replaceChildren(box);
  setTimeout(()=>{if(element.firstChild===box)element.replaceChildren()},3000)
}
function emptyBlock(text){
  const empty=document.createElement('div');
  empty.className='empty';
  empty.textContent=text;
  return empty
}
function emptyTableRow(text){
  const row=document.createElement('tr');
  const cell=document.createElement('td');
  cell.colSpan=5;
  cell.className='empty';
  cell.textContent=text;
  row.appendChild(cell);
  return row
}
async function loadBalance(){
  try{
    const data=await api('/enterprise/credits/balance');
    $('bal').textContent=formatNumber(data.balance);
    $('todayConsumed').textContent=formatNumber(data.todayConsumed);
    $('totalConsumed').textContent=formatNumber(data.totalConsumed);
    $('totalTopped').textContent=formatNumber(data.totalToppedUp);
    const low=finiteNumber(data.balance)<finiteNumber(data.todayConsumed)*3;
    $('bal').parentElement.className='balance-item'+(low?' warn':' ok')
  }catch(error){if(!error.authorization)$('bal').textContent='ERR'}
}
async function doTopup(){
  const amount=+$('topupAmount').value;
  if(!Number.isSafeInteger(amount)||amount<=0){msg($('topupMsg'),'请输入正整数积分数量',false);return}
  try{
    await api('/enterprise/credits/topup',{method:'POST',body:JSON.stringify({amount:amount,note:$('topupNote').value})});
    msg($('topupMsg'),'充值成功',true);
    await Promise.all([loadBalance(),loadTxns()])
  }catch(error){if(!error.authorization)msg($('topupMsg'),error.message,false)}
}
async function doCreateCodes(){
  const amount=+$('codeAmount').value;
  const count=+$('codeCount').value;
  if(!Number.isSafeInteger(amount)||amount<=0||!Number.isSafeInteger(count)||count<1||count>100){msg($('codeMsg'),'面额和数量必须是有效正整数',false);return}
  try{
    const data=await api('/enterprise/credits/redeem-codes',{method:'POST',body:JSON.stringify({creditAmount:amount,count:count})});
    const codes=Array.isArray(data.codes)?data.codes:[];
    msg($('codeMsg'),'已生成 '+codes.length+' 个兑换码',true);
    await loadCodes('active')
  }catch(error){if(!error.authorization)msg($('codeMsg'),error.message,false)}
}
function renderCodes(codes){
  const list=$('codeList');
  if(codes.length===0){list.replaceChildren(emptyBlock('暂无兑换码'));return}
  const fragment=document.createDocumentFragment();
  codes.forEach(code=>{
    const row=document.createElement('div');
    row.className='code-row'+(code.status==='active'?'':' redeemed');
    const identity=document.createElement('div');
    const codeText=document.createElement('b');
    codeText.textContent=String(code.code||'');
    const amountText=document.createElement('small');
    amountText.textContent=' '+formatNumber(code.creditAmount)+' 积分';
    identity.append(codeText,amountText);
    const actions=document.createElement('div');
    const statusText=document.createElement('span');
    statusText.textContent=String(code.status||'');
    actions.appendChild(statusText);
    if(code.redeemedBy){
      const redeemer=document.createElement('span');
      redeemer.textContent=' by '+String(code.redeemedBy);
      actions.appendChild(redeemer)
    }
    if(code.status==='active'){
      const button=document.createElement('button');
      button.type='button';
      button.className='btn btn-danger';
      button.style.fontSize='11px';
      button.style.padding='4px 8px';
      button.textContent='作废';
      const id=String(code.id||'');
      button.addEventListener('click',()=>revokeCode(id));
      actions.appendChild(button)
    }
    row.append(identity,actions);
    fragment.appendChild(row)
  });
  list.replaceChildren(fragment)
}
async function loadCodes(status){
  try{
    const suffix=status?'?status='+encodeURIComponent(status):'';
    const data=await api('/enterprise/credits/redeem-codes'+suffix);
    renderCodes(Array.isArray(data.codes)?data.codes:[])
  }catch(error){if(!error.authorization)$('codeList').replaceChildren(emptyBlock('加载失败'))}
}
async function revokeCode(id){
  try{await api('/enterprise/credits/redeem-codes/'+encodeURIComponent(id)+'/revoke',{method:'POST'});await loadCodes('active')}
  catch(error){if(!error.authorization)msg($('codeMsg'),error.message,false)}
}
function renderTransactions(rows){
  const body=$('txnBody');
  if(rows.length===0){body.replaceChildren(emptyTableRow('暂无交易记录'));return}
  const fragment=document.createDocumentFragment();
  rows.forEach(row=>{
    const tableRow=document.createElement('tr');
    const timeCell=document.createElement('td');
    timeCell.textContent=String(row.createdAt||'').slice(0,19);
    const typeCell=document.createElement('td');
    typeCell.textContent=String(row.type||'');
    const amount=finiteNumber(row.amount);
    const amountCell=document.createElement('td');
    amountCell.className=amount>=0?'plus':'minus';
    amountCell.textContent=(amount>=0?'+':'')+formatNumber(amount);
    const accountCell=document.createElement('td');
    accountCell.textContent=String(row.accountName||'-');
    const descriptionCell=document.createElement('td');
    descriptionCell.textContent=String(row.description||'');
    tableRow.append(timeCell,typeCell,amountCell,accountCell,descriptionCell);
    fragment.appendChild(tableRow)
  });
  body.replaceChildren(fragment)
}
async function loadTxns(){
  try{const data=await api('/enterprise/credits/transactions?limit=50');renderTransactions(Array.isArray(data.transactions)?data.transactions:[])}
  catch(error){if(!error.authorization)$('txnBody').replaceChildren(emptyTableRow('加载失败'))}
}
$('topupButton').addEventListener('click',doTopup);
$('createCodesButton').addEventListener('click',doCreateCodes);
document.querySelectorAll('[data-code-status]').forEach(button=>button.addEventListener('click',()=>loadCodes(button.dataset.codeStatus||'')));
async function initialize(){
  if(!TOKEN){requireAdminLogin('请先返回账号管理页完成管理员登录，再进入积分管理。');return}
  showCredits();
  await Promise.all([loadBalance(),loadCodes('active'),loadTxns()])
}
initialize();
</script></body></html>`;
}
