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
import { adminAccountsHTML } from './adminAccountsPage.js';
import { adminCreditsHTML } from './adminCreditsPage.js';
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
import { handleCommunicationRoute } from './communicationRoutes.js';
import { handleCreditsRoute } from './creditsRoutes.js';
import { handleDeploymentRoute } from './deploymentRoutes.js';
import { handleGeneralizedParkRoute } from './generalizedParkRoutes.js';
import { handleHealthRoute } from './healthRoutes.js';
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

export {
  adminAccountsHTML,
} from './adminAccountsPage.js';

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

export interface DeploymentInfo {
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

      if (handleHealthRoute({
        path,
        method,
        res,
        apiVersion: ENTERPRISE_API_VERSION,
        capabilities: ENTERPRISE_CAPABILITIES,
        deploymentInfo,
        smsConfigured: smsSender !== null,
        repairSmsConfigured: repairSmsSender !== null,
        repairFeishuConfigured: repairFeishuSender !== null,
        sendJSON,
      })) {
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

      if (await handleCommunicationRoute({
        path,
        method,
        url,
        req,
        res,
        memberAccount: memberAccount!,
        atoaClaims,
        atoaClaimTtlMs: ATOA_CLAIM_TTL_MS,
        readBody,
        sendJSON,
      })) {
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
