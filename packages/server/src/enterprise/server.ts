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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAliyunLoginSmsFromEnv } from 'otto-core';
import * as db from './db.js';

import { resolveEnterprisePublicBaseUrl } from './publicInvite.js';
import {
  createRepairFeishuSenderFromEnv,
  createRepairSmsSenderFromEnv,
  type RepairNotificationSender,
} from './repairNotifications.js';
import { FeatureFlagManager, ProjectSettingsManager } from 'otto-core';
import {
  dispatchEnterpriseRoute,
  type AdminPrincipal,
} from './enterpriseRouteDispatcher.js';
import {
  FEATURE_ADMIN_PREFIX,
  isAdminRoute,
  isLicenseMaintenanceRoute,
  isMemberRoute,
  isPublicSimpleParkRoute,
} from './enterpriseRouteGuards.js';

export { adminAccountsHTML } from './adminAccountsPage.js';

const DEFAULT_PORT = 7777;

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
  keys(
    req: IncomingMessage,
    identifier: string,
  ): {
    identity: string;
    client: string;
  };
  retryAfterSeconds(keys: { identity: string; client: string }): number;
  recordFailure(keys: { identity: string; client: string }): number;
  clearIdentity(key: string): void;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
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
  if (!isLoopbackAddress(direct) && !trustedProxyAddresses.has(direct))
    return direct;
  if (typeof forwardedFor !== 'string' || forwardedFor.length > 2048)
    return direct;

  const forwardedChain = forwardedFor
    .split(',')
    .map((address) => normalizedIp(address));
  if (
    forwardedChain.length === 0 ||
    forwardedChain.some((address) => address === null)
  ) {
    return direct;
  }
  const chain = [...(forwardedChain as string[]), direct];
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
function createLoginRateLimiter(
  options: PasswordLoginRateLimitOptions = {},
): LoginRateLimiter {
  const maxFailures = positiveInteger(options.maxFailures, 5, 100);
  const maxIpFailures = positiveInteger(options.maxIpFailures, 30, 1_000);
  const windowMs = positiveInteger(
    options.windowMs,
    15 * 60 * 1000,
    24 * 60 * 60 * 1000,
  );
  const blockMs = positiveInteger(
    options.blockMs,
    60 * 1000,
    24 * 60 * 60 * 1000,
  );
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
    if (
      entry.blockedUntil <= timestamp &&
      timestamp - entry.windowStartedAt >= windowMs
    ) {
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
    const entry =
      existing && timestamp - existing.windowStartedAt < windowMs
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
        recordFailureFor(
          identityEntries,
          keys.identity,
          maxFailures,
          timestamp,
        ),
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
  if (typeof auth === 'string' && auth.startsWith('Bearer '))
    return auth.slice(7);
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
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return isLoopback(hostname);
  } catch {
    return false;
  }
}

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
  return async function handler(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // 只需要 path/query，不使用客户端可控的 Host 或 X-Forwarded-Host 作为 URL 权威源。
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    const isFeatureFlagsRoute = path.startsWith(FEATURE_ADMIN_PREFIX);
    const isPublicSimplePark = isPublicSimpleParkRoute(path, method, url);
    let adminPrincipal: AdminPrincipal | null = null;
    let memberAccount: db.AccountView | null = null;

    if (
      !localAgentPairingEnabled &&
      (path === '/enterprise/sdk/otto-discovery.js' ||
        path === '/enterprise/local-agent' ||
        path === '/enterprise/local-agent/pair' ||
        path === '/enterprise/local-agent/pair/verify')
    ) {
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
      if (
        (isAdminRoute(path) || isFeatureFlagsRoute) &&
        !isPublicSimplePark &&
        !adminToken &&
        !isLoopbackRequestHost(req)
      ) {
        sendJSON(res, 403, {
          error: 'forbidden: loopback admin host required',
        });
        return;
      }

      // 本机兼容模式允许无静态 token 管理，但仍必须阻止第三方网页借浏览器
      // 对状态变更接口发起 blind POST/PATCH（无 Origin 的 CLI/桌面调用不受影响）。
      if (
        (isAdminRoute(path) || isFeatureFlagsRoute) &&
        !isPublicSimplePark &&
        ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) &&
        isCrossOriginBrowserRequest(req)
      ) {
        sendJSON(res, 403, { error: 'forbidden: cross-origin admin request' });
        return;
      }

      // 管理端鉴权：兼容平台静态 admin token，同时允许企业管理员账号的登录会话。
      // 即便是未配置静态 token 的本机服务，也必须先登录；loopback 只限制可访问来源，
      // 绝不能等价于“任何本机进程或网页都拥有平台管理员权限”。
      if ((isAdminRoute(path) || isFeatureFlagsRoute) && !isPublicSimplePark) {
        const token = extractToken(req);
        if (adminToken && tokensMatch(token, adminToken)) {
          adminPrincipal = {
            kind: 'system',
            organizationId: db.DEFAULT_ORGANIZATION_ID,
          };
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
          adminPrincipal = {
            kind: 'account',
            organizationId: account.organizationId,
            account,
          };
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
          adminPrincipal = {
            kind: 'account',
            organizationId: account.organizationId,
            account,
          };
        }
      }

      if (isMemberRoute(path)) {
        memberAccount = db.getAccountBySession(extractToken(req));
        if (!memberAccount) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
      }
      if (
        (isAdminRoute(path) || isMemberRoute(path)) &&
        !isLicenseMaintenanceRoute(path) &&
        db.isLicenseRestricted()
      ) {
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }
      if (isPublicSimplePark && db.isLicenseRestricted()) {
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }

      if (
        await dispatchEnterpriseRoute({
          path,
          method,
          url,
          req,
          res,
          adminPrincipal,
          memberAccount,
          publicBaseUrl,
          smsSender,
          repairSmsSender,
          repairFeishuSender,
          loginRateLimiter,
          deploymentInfo,
          apiVersion: ENTERPRISE_API_VERSION,
          capabilities: ENTERPRISE_CAPABILITIES,
          atoaClaims,
          atoaClaimTtlMs: ATOA_CLAIM_TTL_MS,
          isPublicSimplePark,
          featureFlags,
          readBody,
          sendJSON,
          extractToken,
        })
      ) {
        return;
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
  const port =
    opts.port ??
    parseInt(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT), 10);
  const publicBaseUrl = resolveEnterprisePublicBaseUrl({
    configuredUrl: opts.publicUrl ?? process.env.OTTO_ENTERPRISE_PUBLIC_URL,
    host,
    port,
  });
  let adminToken =
    opts.adminToken ?? process.env.OTTO_ENTERPRISE_ADMIN_TOKEN ?? '';
  let generatedToken = false;
  if (!adminToken && !isLoopback(host)) {
    adminToken = randomBytes(18).toString('base64url');
    generatedToken = true;
  }
  const hasSmsEnv = Boolean(
    process.env.ALIYUN_SMS_ACCESS_KEY_ID &&
    process.env.ALIYUN_SMS_ACCESS_KEY_SECRET &&
    process.env.ALIYUN_SMS_SIGN_NAME &&
    process.env.ALIYUN_SMS_TEMPLATE_ID,
  );
  const smsSender =
    opts.smsSender === undefined
      ? hasSmsEnv
        ? createAliyunLoginSmsFromEnv()
        : null
      : opts.smsSender;
  const repairSmsSender =
    opts.repairSmsSender === undefined
      ? createRepairSmsSenderFromEnv()
      : opts.repairSmsSender;
  const repairFeishuSender =
    opts.repairFeishuSender === undefined
      ? createRepairFeishuSenderFromEnv()
      : opts.repairFeishuSender;
  const version =
    opts.appVersion?.trim() ||
    process.env.OTTO_APP_VERSION?.trim() ||
    'unknown';
  const buildCommit =
    opts.buildCommit?.trim() ||
    process.env.OTTO_BUILD_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    'unknown';
  const configuredProxyHops = nonNegativeInteger(
    opts.loginRateLimit?.trustedProxyHops ??
      Number(process.env.OTTO_ENTERPRISE_TRUST_PROXY_HOPS),
    0,
    5,
  );
  const configuredProxyAddresses =
    opts.loginRateLimit?.trustedProxyAddresses ??
    process.env.OTTO_ENTERPRISE_TRUSTED_PROXIES?.split(',')
      .map((address) => address.trim())
      .filter(Boolean) ??
    [];
  const loginRateLimiter = createLoginRateLimiter({
    ...opts.loginRateLimit,
    trustedProxyHops: configuredProxyHops,
    trustedProxyAddresses: configuredProxyAddresses,
  });
  const featureFlags = new FeatureFlagManager(
    new ProjectSettingsManager(process.cwd()),
  );
  const server = createServer(
    makeHandler(
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
    ),
  );
  return { server, host, port, publicBaseUrl, adminToken, generatedToken };
}

function persistGeneratedAdminToken(token: string): string {
  const directory =
    process.env.OTTO_ENTERPRISE_DIR ||
    path.join(os.homedir(), '.otto-enterprise');
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

function validatedStartOptions(
  opts: EnterpriseServerOptions,
): EnterpriseServerOptions {
  const host = opts.host || process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1';
  if (isLoopback(host)) return opts;

  const appVersion =
    opts.appVersion?.trim() || process.env.OTTO_APP_VERSION?.trim() || '';
  const buildCommit =
    opts.buildCommit?.trim() ||
    process.env.OTTO_BUILD_COMMIT?.trim() ||
    process.env.GITHUB_SHA?.trim() ||
    '';
  const errors: string[] = [];
  if (!appVersion || appVersion.toLowerCase() === 'unknown') {
    errors.push('OTTO_APP_VERSION 必须设置为明确的发布版本');
  }
  if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
    errors.push('OTTO_BUILD_COMMIT 必须是完整的 40 位十六进制 Git SHA');
  }
  if (errors.length > 0) {
    throw new Error(
      `[Otto Enterprise] 拒绝非 loopback 启动：${errors.join('；')}`,
    );
  }
  return {
    ...opts,
    host,
    appVersion,
    buildCommit,
  };
}

/** 组装并 listen；返回 http.Server。访问地址不包含凭证，自动令牌只落 0600 文件。 */
export function startEnterpriseServer(
  opts: EnterpriseServerOptions = {},
): Server {
  const validatedOptions = validatedStartOptions(opts);
  const { server, host, port, publicBaseUrl, adminToken, generatedToken } =
    createEnterpriseServer(validatedOptions);
  const generatedTokenPath = generatedToken
    ? persistGeneratedAdminToken(adminToken)
    : null;
  server.listen(port, host, () => {
    console.log(`[Otto Enterprise] 服务端运行于 http://${host}:${port}`);
    console.log(
      `[Otto Enterprise] 账号管理: http://localhost:${port}/enterprise/admin`,
    );
    console.log(
      `[Otto Enterprise] 企业引入: ${publicBaseUrl}/enterprise/join/{邀请码}`,
    );
    console.log(
      `[Otto Enterprise] 老板看板: http://localhost:${port}/enterprise/dashboard`,
    );
    console.log(
      `[Otto Enterprise] 数据: ~/.otto-enterprise/data.db（本地，零云端）`,
    );
    if (generatedTokenPath) {
      console.log(
        `[Otto Enterprise] 自动生成的管理令牌已安全保存: ${generatedTokenPath}`,
      );
    } else if (adminToken) {
      console.log(
        '[Otto Enterprise] 已使用环境中配置的平台管理令牌（不会输出令牌内容）',
      );
    } else {
      console.log(
        '[Otto Enterprise] 未配置平台令牌；管理页面仍要求管理员账号登录',
      );
    }
    console.log(
      '[Otto Enterprise] 积分管理: http://localhost:' +
        port +
        '/enterprise/admin/credits',
    );
    console.log('[Otto Enterprise] Ctrl+C 停止');
  });
  return server;
}
