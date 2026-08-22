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
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAliyunLoginSmsFromEnv } from 'otto-core';
import * as db from './db.js';
import { e2eeProductionCapabilities } from './e2eeProductionReleasePolicy.js';

import { resolveEnterprisePublicBaseUrl } from '../modules/identity_organization/index.js';
import {
  createRepairFeishuSenderFromEnv,
  createRepairSmsSenderFromEnv,
  type RepairNotificationSender,
} from '../modules/integration_adapters/index.js';
import { FeatureFlagManager, ProjectSettingsManager } from 'otto-core';
import {
  dispatchEnterpriseRoute,
  type AdminPrincipal,
} from './enterpriseRouteDispatcher.js';
import {
  commercialFeatureForEnterpriseRoute,
  FEATURE_ADMIN_PREFIX,
  isAdminRoute,
  isLicenseMaintenanceRoute,
  isMemberRoute,
  isPublicSimpleParkRoute,
} from '../modules/authorization/index.js';
import {
  createLoginRateLimiter,
  extractToken,
  isCrossOriginBrowserRequest,
  isLoopbackRequestHost,
  licenseBlockedPayload,
  nonNegativeInteger,
  tokensMatch,
  type LoginRateLimiter,
  type PasswordLoginRateLimitOptions,
} from './enterpriseHttpSecurity.js';
import {
  BillingAdmissionError,
  commercialBillingOperationForRoute,
  startPrivateDeploymentRuntime,
} from '../modules/commercial_control/index.js';
import {
  controlPublicKeysFromEnv,
  type ControlCommandEnvelope,
} from '../modules/control_commands/index.js';
import { createEnterpriseInitiationCommandExecutor } from '../modules/enterprise_initiation/index.js';
import { createEnterpriseControlCommandBoundary } from './controlCommandIntegration.js';
import {
  startPrivateDeploymentBootstrapRuntime,
  type PrivateDeploymentBootstrapCoordinator,
} from '../modules/deployment_lifecycle/index.js';
import { createEnterprisePrivateDeploymentBootstrap } from './privateDeploymentBootstrapIntegration.js';

export { adminAccountsHTML } from './adminAccountsPage.js';
export {
  resolveEnterpriseClientAddress,
  type EnterpriseProxyOptions,
  type PasswordLoginRateLimitOptions,
} from './enterpriseHttpSecurity.js';

const DEFAULT_PORT = 7777;
const BODY_TOO_LARGE = Symbol('bodyTooLarge');

interface RouteBody {
  [key: string]: unknown;
  [BODY_TOO_LARGE]?: true;
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
  /** Test seam for the signed commercial-control billing channel. */
  billingFetch?: typeof fetch;
  /** Control 信任根公钥（PEM 列表）；不传则读 OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS。未配置时 CONTROL-12 端点 fail closed 不挂载。 */
  controlPublicKeys?: string[];
  /** 回执签名私钥（PEM）；不传则不签名（只含 digest）。 */
  controlSigningPrivateKey?: string;
  /** 执行 Control 下发指令的业务钩子（对接 SERVER-16 企业开通）。未传则 CONTROL-12 不启用执行。 */
  controlCommandExecute?: (command: ControlCommandEnvelopeLike) => ControlCommandRunResultShim;
  /** 密码登录限流参数；生产使用安全默认值，测试可注入时钟和较小阈值。 */
  loginRateLimit?: PasswordLoginRateLimitOptions;
  /** Test seam; production derives this from server-side environment only. */
  privateDeploymentBootstrapCoordinator?: PrivateDeploymentBootstrapCoordinator;
}

/** 与 control_command 边界的信封/执行结果类型对齐（避免 server.ts 循环依赖）。 */
interface ControlCommandEnvelopeLike {
  commandId: string;
  deploymentId: string;
  type: string;
  schemaVersion: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey?: string;
  payloadDigest: string;
  payload: Record<string, unknown>;
  signature: string;
}
interface ControlCommandRunResultShim {
  status: 'succeeded' | 'failed' | 'unknown_outcome' | 'expired' | 'cancelled';
  resultSummary: string;
  resourceId?: string;
  errorCategory?: string;
}

export interface VerificationSmsSender {
  sendVerificationCode(phone: string, code: string): Promise<boolean>;
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
  'data_governance_v1',
  'privacy_self_service',
  'multi_organization',
  'direct_messages',
  'federation_chat_v1',
  'e2ee_private_messages_v1',
  'e2ee_device_trust_v1',
  'e2ee_mls_transport_v1',
  'e2ee_mls_resource_governance_v1',
  'e2ee_mls_transport_session_reset_v1',
  ...e2eeProductionCapabilities(),
  'direct_message_attachments_v1',
  'encrypted_attachment_storage_v1',
  'encrypted_message_storage_v1',
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
  'park_service_statistics_v1',
  'private_deployment_v1',
  'private_deployment_bootstrap_v1',
  'license_enforcement_v1',
  'encrypted_telemetry_queue_v1',
  'signed_telemetry_transport_v1',
  'diagnostic_bundle_v1',
  'data_protection_v1',
  'park_resources_v1',
  'park_meeting_slots_v1',
  'modular_update_push_v1',
  'signed_update_policy_v1',
  'control_command_queue_v1',
  'account_data_sync_v1',
  'enterprise_skill_market_v1',
  'federation_gateway_v1',
] as const;

export interface DeploymentInfo {
  version: string;
  buildCommit: string;
  startedAt: string;
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

function readBody(
  req: IncomingMessage,
  maxLength = 1_000_000,
): Promise<RouteBody> {
  if (req.readableEnded || req.complete) return Promise.resolve({});
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > maxLength) {
        tooLarge = true;
        body = '';
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        resolve({ [BODY_TOO_LARGE]: true });
        return;
      }
      try {
        resolve(body ? (JSON.parse(body) as RouteBody) : {});
      } catch {
        resolve({});
      }
    });
  });
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
  privateDeploymentBootstrap: PrivateDeploymentBootstrapCoordinator,
  featureFlags?: FeatureFlagManager,
  billingFetch: typeof fetch = fetch,
  controlCommandHandle?: (deps: {
    path: string;
    method: string;
    url: URL;
    req: IncomingMessage;
    res: ServerResponse;
    readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
    sendJSON(res: ServerResponse, status: number, data: unknown): void;
  }) => Promise<boolean>,
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
      const commercialOrganizationId =
        memberAccount?.organizationId ?? adminPrincipal?.organizationId ?? null;
      const commercialActorId = memberAccount?.id ?? (
        adminPrincipal?.kind === 'account' ? adminPrincipal.account.id : null
      );
      const auditCommercialDecision = (
        event: string,
        detail: Record<string, unknown>,
      ) => {
        try {
          db.logAudit(
            event,
            commercialActorId,
            JSON.stringify({ method, path, ...detail }),
            commercialOrganizationId ?? db.DEFAULT_ORGANIZATION_ID,
          );
        } catch (error) {
          console.error('[Otto Enterprise] commercial decision audit failed', {
            event,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };
      if (
        (isAdminRoute(path) || isMemberRoute(path)) &&
        !isLicenseMaintenanceRoute(path, method) &&
        db.isLicenseRestricted()
      ) {
        auditCommercialDecision('commercial_license_denied', {
          code: 'deployment_license_inactive',
        });
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }
      if (isPublicSimplePark && db.isLicenseRestricted()) {
        auditCommercialDecision('commercial_license_denied', {
          code: 'deployment_license_inactive',
        });
        sendJSON(res, 402, licenseBlockedPayload());
        return;
      }
      const commercialFeature = commercialFeatureForEnterpriseRoute(path);
      if (
        commercialFeature &&
        !db.isLicenseUsableForOrganizationFeature(
          commercialFeature,
          commercialOrganizationId,
        )
      ) {
        auditCommercialDecision('commercial_module_denied', {
          code: 'commercial_module_not_entitled',
          feature: commercialFeature,
        });
        sendJSON(res, 402, {
          error: 'commercial module is not entitled',
          code: 'commercial_module_not_entitled',
          feature: commercialFeature,
        });
        return;
      }
      if (
        commercialFeature &&
        commercialOrganizationId &&
        !db.isOrganizationFeatureEnabled(
          commercialOrganizationId,
          commercialFeature,
        )
      ) {
        auditCommercialDecision('commercial_module_denied', {
          code: 'organization_feature_disabled',
          feature: commercialFeature,
        });
        sendJSON(res, 403, {
          error:
            commercialFeature === 'knowledge'
              ? '企业知识功能已由管理员关闭'
              : 'organization feature is disabled',
          code: 'organization_feature_disabled',
          feature: commercialFeature,
        });
        return;
      }

      const billingOperation = commercialBillingOperationForRoute(path, method);
      if (billingOperation) {
        if (!commercialOrganizationId) {
          sendJSON(res, 401, {
            error: 'authenticated organization is required for billing',
            code: 'billing_organization_required',
          });
          return;
        }
        const rawIdempotencyKey = req.headers['x-otto-idempotency-key'];
        const idempotencyKey = Array.isArray(rawIdempotencyKey)
          ? rawIdempotencyKey[0] ?? ''
          : rawIdempotencyKey ?? '';
        const referenceId = `op_${createHash('sha256')
          .update(`${method}\0${path}\0${idempotencyKey}`, 'utf8')
          .digest('hex')}`;
        try {
          const admission = await db.authorizeBillingOperation(
            {
              ...billingOperation,
              organizationId: commercialOrganizationId,
              idempotencyKey,
              referenceId,
            },
            billingFetch,
          );
          if (admission.required) {
            auditCommercialDecision('commercial_billing_admitted', {
              module: billingOperation.module,
              referenceId,
              holdId: admission.holdId,
            });
            res.setHeader('X-Otto-Billing-Admission', admission.holdId ?? 'required');
            res.once('finish', () => {
              const outcome = res.statusCode >= 200 && res.statusCode < 400
                ? 'capture'
                : 'release';
              auditCommercialDecision('commercial_billing_finalization_queued', {
                module: billingOperation.module,
                referenceId,
                outcome,
              });
              void db.finalizeBillingOperation(
                admission,
                outcome,
                billingFetch,
              ).catch((error: unknown) => {
                console.error('[Otto Enterprise] billing finalization failed', {
                  code: outcome,
                  message: error instanceof Error ? error.message : String(error),
                });
              });
            });
          }
        } catch (error) {
          if (error instanceof BillingAdmissionError) {
            auditCommercialDecision('commercial_billing_denied', {
              module: billingOperation.module,
              code: error.code,
            });
            sendJSON(res, error.statusCode, {
              error: error.message,
              code: error.code,
              module: billingOperation.module,
            });
            return;
          }
          throw error;
        }
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
          billingFetch,
          loginRateLimiter,
          deploymentInfo,
          apiVersion: ENTERPRISE_API_VERSION,
          capabilities: ENTERPRISE_CAPABILITIES,
          privateDeploymentBootstrap,
          atoaClaims,
          atoaClaimTtlMs: ATOA_CLAIM_TTL_MS,
          isPublicSimplePark,
          featureFlags,
          readBody,
          sendJSON,
          extractToken,
          controlCommandHandle,
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
 * 工单通知升级任务运行时：周期扫描持久化队列，发送到期的短信升级 / 飞书重试。
 * 任务存于 SQLite，服务器重启后由本运行时继续执行。
 */
function startTicketNotificationRuntime(options: {
  smsSender: RepairNotificationSender | null;
  feishuSender: RepairNotificationSender | null;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): () => void {
  const timer = setInterval(() => {
    db.processTicketNotificationTasks({
      smsSender: options.smsSender,
      feishuSender: options.feishuSender,
      resolveRecipientChannel: (accountId) => {
        const account = db.getAccount(accountId);
        return {
          phone: account?.phone ?? null,
          feishuOpenId: account?.feishuOpenId ?? null,
        };
      },
    }).catch((error) => options.onError?.(error));
  }, options.intervalMs ?? 15_000);
  timer.unref?.();
  return () => clearInterval(timer);
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
  repairSmsSender: RepairNotificationSender | null;
  repairFeishuSender: RepairNotificationSender | null;
  privateDeploymentBootstrap: PrivateDeploymentBootstrapCoordinator;
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
  // CONTROL-12：配置了 Control 信任根公钥 + 业务执行钩子时才启用端点（其余 fail closed）。
  const controlKeys =
    opts.controlPublicKeys ?? controlPublicKeysFromEnv(process.env);
  const controlExecute =
    opts.controlCommandExecute ??
    createEnterpriseInitiationCommandExecutor({
      getDeploymentLicense: db.getDeploymentLicense,
      provision: db.provisionBootstrapEnterprise,
    });
  const controlBoundary = createEnterpriseControlCommandBoundary({
    deploymentId: db.getDeploymentId(),
    controlPublicKeys: controlKeys,
    signingPrivateKey: opts.controlSigningPrivateKey,
    execute: controlExecute,
  });
  const applyProvisioningCommand = (command: unknown): void => {
    if (!controlBoundary.enabled) {
      throw new Error('bootstrap_provisioning_not_configured');
    }
    const submitted = controlBoundary.submit(command as ControlCommandEnvelope);
    if (submitted.kind !== 'accepted') {
      throw new Error(
        submitted.kind === 'invalid_signature'
          ? 'bootstrap_provisioning_signature_invalid'
          : 'bootstrap_provisioning_rejected',
      );
    }
    for (let index = 0; index < 100; index += 1) {
      const receipt = controlBoundary.services.queryReceipt(
        submitted.commandId,
      );
      if (receipt) {
        if (receipt.status !== 'succeeded') {
          throw new Error('bootstrap_provisioning_failed');
        }
        return;
      }
      if (!controlBoundary.services.drainOnce().executed) break;
    }
    throw new Error('bootstrap_provisioning_incomplete');
  };
  const deploymentInfo = {
    version,
    buildCommit,
    startedAt: new Date().toISOString(),
  };
  const privateDeploymentBootstrap =
    opts.privateDeploymentBootstrapCoordinator ??
    createEnterprisePrivateDeploymentBootstrap({
      appVersion: version,
      buildCommit,
      publicOrigin: publicBaseUrl,
      applyProvisioningCommand,
    });
  const server = createServer(
    makeHandler(
      adminToken,
      smsSender,
      repairSmsSender,
      repairFeishuSender,
      publicBaseUrl,
      loginRateLimiter,
      deploymentInfo,
      opts.localAgentPairingEnabled === true,
      privateDeploymentBootstrap,
      featureFlags,
      opts.billingFetch,
      controlBoundary.enabled ? controlBoundary.handleRoute : undefined,
    ),
  );
  return {
    server,
    host,
    port,
    publicBaseUrl,
    adminToken,
    generatedToken,
    repairSmsSender,
    repairFeishuSender,
    privateDeploymentBootstrap,
  };
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
  db.getDatabaseReadiness();
  db.ensureDirectMessageContentEncrypted();
  db.ensureDeploymentLicenseSecretsEncrypted();
  const {
    server,
    host,
    port,
    publicBaseUrl,
    adminToken,
    generatedToken,
    repairSmsSender,
    repairFeishuSender,
    privateDeploymentBootstrap,
  } = createEnterpriseServer(validatedOptions);
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
  const stopPrivateDeploymentRuntime = startPrivateDeploymentRuntime(db, {
    onError: (error) =>
      console.error(
        '[Otto Enterprise] private deployment runtime failed',
        error,
      ),
  });
  const stopPrivateDeploymentBootstrapRuntime =
    startPrivateDeploymentBootstrapRuntime(privateDeploymentBootstrap, {
      onError: (error) =>
        console.error(
          '[Otto Enterprise] private deployment bootstrap failed',
          error,
        ),
    });
  let stopFederationRuntime: () => void;
  try {
    stopFederationRuntime = db.startFederationRuntime();
  } catch (error) {
    stopPrivateDeploymentRuntime();
    stopPrivateDeploymentBootstrapRuntime();
    server.close();
    throw error;
  }
  let stopDataProtectionRuntime: () => void;
  try {
    stopDataProtectionRuntime = db.startDataProtectionRuntime();
  } catch (error) {
    stopPrivateDeploymentRuntime();
    stopPrivateDeploymentBootstrapRuntime();
    stopFederationRuntime();
    server.close();
    throw error;
  }
  let mlsCleanupRunning = false;
  const runMlsCleanup = () => {
    if (mlsCleanupRunning) return;
    mlsCleanupRunning = true;
    try {
      db.cleanupExpiredMlsResources({ limit: 500 });
    } catch (error) {
      console.error('[Otto Enterprise] MLS resource cleanup failed', error);
    } finally {
      mlsCleanupRunning = false;
    }
  };
  const mlsCleanupTimer = setInterval(runMlsCleanup, 15 * 60 * 1_000);
  mlsCleanupTimer.unref();
  const initialMlsCleanup = setImmediate(runMlsCleanup);
  initialMlsCleanup.unref();
  let stopTicketNotificationRuntime: () => void;
  try {
    stopTicketNotificationRuntime = startTicketNotificationRuntime({
      smsSender: repairSmsSender,
      feishuSender: repairFeishuSender,
      onError: (error) =>
        console.error('[Otto Enterprise] 工单通知升级任务失败', error),
    });
  } catch (error) {
    clearImmediate(initialMlsCleanup);
    clearInterval(mlsCleanupTimer);
    stopPrivateDeploymentRuntime();
    stopPrivateDeploymentBootstrapRuntime();
    stopFederationRuntime();
    stopDataProtectionRuntime();
    server.close();
    throw error;
  }
  server.once('close', () => {
    clearImmediate(initialMlsCleanup);
    clearInterval(mlsCleanupTimer);
    stopPrivateDeploymentRuntime();
    stopPrivateDeploymentBootstrapRuntime();
    stopFederationRuntime();
    stopDataProtectionRuntime();
    stopTicketNotificationRuntime();
  });
  return server;
}
