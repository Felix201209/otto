/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Server - HTTP API for Otto Enterprise.
 * 跑在管理员/老板设备上，所有数据本地（node:sqlite），零云端。
 *
 * 相对 enterprise 分支原版做的加固（optimize）：
 *   1. 默认只监听 127.0.0.1（原版 0.0.0.0 全网裸奔）；要局域网暴露须显式设 HOST。
 *   2. 管理端路由（invite/offboard/export/audit/employees/report/dashboard）需 admin token；
 *      监听非本地又没设 token 时自动生成并打印，绝不无鉴权对外。
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
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createAliyunLoginSmsFromEnv } from 'otto-core';
import * as db from './db.js';
import {
  buildOrganizationInviteLink,
  isOrganizationInviteCode,
  resolveEnterprisePublicBaseUrl,
} from './publicInvite.js';
import { sendPublicInvitePage } from './publicInvitePage.js';
import * as park from './park.js';
import { handleFeatureFlagsRoute } from './featureFlagsAdmin.js';
import { FeatureFlagManager, ProjectSettingsManager } from 'otto-core';

const DEFAULT_PORT = 7777;

/** 需要管理员令牌的路由（读/写全公司数据或改员工状态）。 */
const ADMIN_ROUTES = new Set([
  '/enterprise/invite',
  '/enterprise/offboard',
  '/enterprise/export',
  '/enterprise/audit',
  '/enterprise/employees',
  '/enterprise/report',
  '/enterprise/dashboard',
  '/enterprise/accounts',
  '/enterprise/organization/invite',
  '/enterprise/usage/summary',
  '/enterprise/organizations',
  '/enterprise/park',
  '/enterprise/park/invite',
  '/enterprise/park/services/assign',
]);

/** 会读取或写入企业内部数据的成员路由，必须使用账号会话。 */
const MEMBER_ROUTES = new Set([
  '/enterprise/onboard',
  '/enterprise/task',
  '/enterprise/recall',
  '/enterprise/knowledge',
]);

/** 特性开关管理路由（需管理员令牌）。 */
const FEATURE_ADMIN_PREFIX = '/admin/features';

interface RouteBody {
  [key: string]: unknown;
}

export interface EnterpriseServerOptions {
  port?: number;
  host?: string;
  /** 对外企业引入页基址；不传则读 OTTO_ENTERPRISE_PUBLIC_URL，再回落到内置公网地址。 */
  publicUrl?: string;
  /** 管理端令牌；不传则读 OTTO_ENTERPRISE_ADMIN_TOKEN。 */
  adminToken?: string;
  /** 验证码发送器；测试可注入，显式 null 表示关闭。 */
  smsSender?: VerificationSmsSender | null;
}

export interface VerificationSmsSender {
  sendVerificationCode(phone: string, code: string): Promise<boolean>;
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

/** 从 header / bearer / query 里取令牌。 */
function extractToken(req: IncomingMessage, url: URL): string {
  const h = req.headers['x-otto-admin-token'];
  if (typeof h === 'string' && h) return h;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token') || '';
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
  return ADMIN_ROUTES.has(path) || path.startsWith('/enterprise/accounts/');
}

type AdminPrincipal =
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: db.AccountView };

function accountConflictMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '手机号已绑定其他账号' || /accounts\.phone|idx_accounts_phone_unique/i.test(message)) {
    return '手机号已绑定其他账号';
  }
  if (/unique constraint|accounts\.username/i.test(message)) return '账号名已存在';
  return null;
}

function withPublicInviteLink(
  invite: db.OrganizationInviteView | null,
  publicBaseUrl: string,
): db.OrganizationInviteView | null {
  return invite
    ? { ...invite, link: buildOrganizationInviteLink(publicBaseUrl, invite.code) }
    : null;
}

function makeHandler(
  adminToken: string,
  smsSender: VerificationSmsSender | null,
  publicBaseUrl: string,
  featureFlags?: FeatureFlagManager,
) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 只需要 path/query，不使用客户端可控的 Host 或 X-Forwarded-Host 作为 URL 权威源。
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    let adminPrincipal: AdminPrincipal | null = null;
    let memberAccount: db.AccountView | null = null;

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 浏览器会自动请求站点图标；显式无内容响应，避免管理后台验收出现无关 404。
    if (path === '/favicon.ico' && method === 'GET') {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      res.end();
      return;
    }

    const isFeatureFlagsRoute = path.startsWith(FEATURE_ADMIN_PREFIX);

    // 管理端鉴权：兼容原有静态 admin token，同时允许预设管理员账号的登录会话。
    // 本机模式未配置 adminToken 时维持旧行为（仅 loopback 使用）；对外监听时 start
    // 会自动生成 admin token，因此不会出现公网裸管理接口。
    if (isAdminRoute(path) || isFeatureFlagsRoute) {
      const token = extractToken(req, url);
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
        // 仅限未配置 token 的本机兼容模式。若带了有效管理员会话，仍按其企业隔离；
        // 无会话时沿用旧版默认企业管理行为。
        const account = db.getAccountBySession(token);
        if (account) {
          if (!account.isAdmin) {
            sendJSON(res, 403, { error: 'forbidden: admin account required' });
            return;
          }
          adminPrincipal = { kind: 'account', organizationId: account.organizationId, account };
        } else {
          adminPrincipal = { kind: 'system', organizationId: db.DEFAULT_ORGANIZATION_ID };
        }
      }
    }

    if (MEMBER_ROUTES.has(path)) {
      memberAccount = db.getAccountBySession(extractToken(req, url));
      if (!memberAccount) {
        sendJSON(res, 401, { error: '登录已失效，请重新登录' });
        return;
      }
    }

    try {
      // ===== Health =====
      if (path === '/enterprise/health' && method === 'GET') {
        sendJSON(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          db: 'connected',
          sms: { configured: smsSender !== null },
        });
        return;
      }

      // ===== Public enterprise onboarding landing page =====
      if (path.startsWith('/enterprise/join/') && method === 'GET') {
        const encodedCode = path.slice('/enterprise/join/'.length);
        let code = '';
        try {
          code = decodeURIComponent(encodedCode).toLocaleUpperCase('en-US');
        } catch {
          sendPublicInvitePage(res, 404);
          return;
        }
        if (!isOrganizationInviteCode(code)) {
          sendPublicInvitePage(res, 404);
          return;
        }
        const invite = db.inspectOrganizationInvite(code);
        if (invite.status === 'invalid') {
          sendPublicInvitePage(res, 404);
          return;
        }
        if (invite.status !== 'active') {
          sendPublicInvitePage(res, 410);
          return;
        }
        sendPublicInvitePage(res, 200, code);
        return;
      }

      // ===== Password authentication + first-time SMS registration =====
      if (path === '/enterprise/auth/login' && method === 'POST') {
        const body = await readBody(req);
        const identifier = typeof body.identifier === 'string'
          ? body.identifier
          : typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const account = db.authenticateAccount(identifier, password);
        if (!account) {
          // 不区分「账号不存在」与「密码错误」，避免泄露预设账号清单。
          sendJSON(res, 401, { error: '账号或密码错误' });
          return;
        }
        const session = db.createAuthSession(account.id);
        sendJSON(res, 200, { account, token: session.token, expiresAt: session.expiresAt });
        return;
      }

      if ((path === '/enterprise/auth/sms/request' || path === '/enterprise/auth/sms/verify')
        && method === 'POST') {
        sendJSON(res, 410, { error: '短信验证码仅用于首次注册，请使用密码登录' });
        return;
      }

      if (path === '/enterprise/auth/register/sms/request' && method === 'POST') {
        if (!smsSender) {
          sendJSON(res, 503, { error: '短信注册暂不可用，请稍后重试' });
          return;
        }
        const body = await readBody(req);
        const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode : '';
        const organization = db.resolveOrganizationInvite(inviteCode);
        if (!organization) {
          sendJSON(res, 403, { error: '企业邀请码无效或已过期，请联系管理员重新生成' });
          return;
        }
        const rawPhone = typeof body.phone === 'string' ? body.phone : '';
        let phone: string;
        try {
          phone = db.normalizePhone(rawPhone);
        } catch {
          sendJSON(res, 400, { error: '请输入正确的中国大陆手机号' });
          return;
        }

        if (db.findAccountByPhone(phone)) {
          sendJSON(res, 409, { error: '该手机号已注册，请直接登录' });
          return;
        }
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const issued = db.createSmsRegistrationChallenge(phone, code, organization.id);
        if (!issued.ok) {
          res.setHeader('Retry-After', String(issued.retryAfterSeconds));
          sendJSON(res, 429, {
            error: issued.reason === 'cooldown'
              ? '验证码发送过于频繁，请稍后再试'
              : '本小时验证码发送次数已达上限',
            retryAfterSeconds: issued.retryAfterSeconds,
          });
          return;
        }

        let sent = false;
        try {
          sent = await smsSender.sendVerificationCode(phone.slice(3), code);
        } catch {
          sent = false;
        }
        if (!sent) {
          db.discardSmsRegistrationChallenge(issued.challengeId);
          sendJSON(res, 502, { error: '验证码发送失败，请稍后重试' });
          return;
        }
        sendJSON(res, 200, {
          ...issued,
          message: '验证码已发送，5 分钟内有效',
          organization: { id: organization.id, name: organization.name },
        });
        return;
      }

      if (path === '/enterprise/auth/register/sms/verify' && method === 'POST') {
        const body = await readBody(req);
        const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!challengeId.startsWith('smsreg_') || !/^\d{6}$/.test(code)) {
          sendJSON(res, 400, { error: '请输入 6 位短信验证码' });
          return;
        }
        if (!name || name.length > 40 || password.length < 8) {
          sendJSON(res, 400, { error: '请填写姓名，并设置至少 8 位登录密码' });
          return;
        }
        const verified = db.verifySmsRegistrationChallenge(challengeId, code);
        if (!verified.ok) {
          sendJSON(res, 401, {
            error: verified.reason === 'locked'
              ? '验证码错误次数过多，请重新获取'
              : '验证码错误或已失效',
            attemptsRemaining: verified.attemptsRemaining,
          });
          return;
        }
        let account: db.AccountView;
        try {
          account = db.createSelfRegisteredAccount({
            organizationId: verified.organizationId,
            phone: verified.phone,
            name,
            password,
          });
        } catch (error) {
          const conflict = accountConflictMessage(error) || (error instanceof Error ? error.message : null);
          if (conflict === '手机号已绑定其他账号' || conflict === '该手机号已注册，请直接登录') {
            sendJSON(res, 409, { error: '该手机号已注册，请直接登录' });
            return;
          }
          throw error;
        }
        const session = db.createAuthSession(account.id);
        sendJSON(res, 200, {
          account,
          token: session.token,
          expiresAt: session.expiresAt,
        });
        return;
      }

      if (path === '/enterprise/auth/me' && method === 'GET') {
        const account = db.getAccountBySession(extractToken(req, url));
        if (!account) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
        sendJSON(res, 200, { account });
        return;
      }

      if (path === '/enterprise/auth/logout' && method === 'POST') {
        const token = extractToken(req, url);
        const account = db.getAccountBySession(token);
        if (!account) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
        db.revokeAuthSession(token);
        sendJSON(res, 200, { status: 'logged_out' });
        return;
      }

      // ===== Complete account management entry =====
      if (path === '/enterprise/accounts' && method === 'GET') {
        const organizationId = adminPrincipal!.organizationId;
        const usage = db.getOrganizationUsageSummary(organizationId, 30);
        const usageByAccount = new Map(usage.byAccount.map((row) => [row.accountId, row]));
        sendJSON(res, 200, {
          accounts: db.listAccounts(organizationId).map((account) => ({
            ...account,
            usage: usageByAccount.get(account.id) || {
              accountId: account.id,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              requestCount: 0,
              lastUsedAt: null,
            },
          })),
        });
        return;
      }

      if (path === '/enterprise/accounts' && method === 'POST') {
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const name = typeof body.name === 'string' ? body.name : '';
        if (!username || password.length < 8 || !name) {
          sendJSON(res, 400, { error: 'username, name and password (at least 8 characters) required' });
          return;
        }
        try {
          const account = db.createAccount({
            organizationId: adminPrincipal!.organizationId,
            username,
            password,
            name,
            phone: typeof body.phone === 'string' ? body.phone : null,
            role: typeof body.role === 'string' ? body.role : null,
            department: typeof body.department === 'string' ? body.department : null,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            isAdmin: body.isAdmin === true,
          });
          sendJSON(res, 201, { account });
        } catch (error) {
          const conflict = accountConflictMessage(error);
          if (conflict) sendJSON(res, 409, { error: conflict });
          else throw error;
        }
        return;
      }

      if (path.startsWith('/enterprise/accounts/') && method === 'PATCH') {
        const accountId = decodeURIComponent(path.slice('/enterprise/accounts/'.length));
        const organizationId = adminPrincipal!.organizationId;
        if (!accountId || !db.getAccount(accountId, organizationId)) {
          sendJSON(res, 404, { error: 'Account not found' });
          return;
        }
        const body = await readBody(req);
        const status = body.status === 'active' || body.status === 'disabled' ? body.status : undefined;
        try {
          const account = db.updateAccount(accountId, {
            username: typeof body.username === 'string' ? body.username : undefined,
            password: typeof body.password === 'string' && body.password ? body.password : undefined,
            name: typeof body.name === 'string' ? body.name : undefined,
            phone: typeof body.phone === 'string' || body.phone === null ? body.phone : undefined,
            role: typeof body.role === 'string' || body.role === null ? body.role : undefined,
            department: typeof body.department === 'string' || body.department === null
              ? body.department
              : undefined,
            tags: Array.isArray(body.tags)
              ? body.tags.filter((tag): tag is string => typeof tag === 'string')
              : undefined,
            isAdmin: typeof body.isAdmin === 'boolean' ? body.isAdmin : undefined,
            status,
          }, organizationId);
          sendJSON(res, 200, { account });
        } catch (error) {
          const conflict = accountConflictMessage(error);
          if (conflict) sendJSON(res, 409, { error: conflict });
          else throw error;
        }
        return;
      }

      // ===== Enterprise-scoped registration invite (manual, exactly 7 days) =====
      if (path === '/enterprise/organization/invite' && method === 'GET') {
        const organization = db.getOrganization(adminPrincipal!.organizationId);
        sendJSON(res, 200, {
          organization,
          invite: withPublicInviteLink(
            db.getOrganizationInvite(adminPrincipal!.organizationId),
            publicBaseUrl,
          ),
        });
        return;
      }

      if (path === '/enterprise/organization/invite' && method === 'POST') {
        const principal = adminPrincipal!;
        const organization = db.getOrganization(principal.organizationId);
        const invite = withPublicInviteLink(
          db.issueOrganizationInvite(
            principal.organizationId,
            Date.now(),
            principal.kind === 'account' ? principal.account.id : null,
          ),
          publicBaseUrl,
        );
        sendJSON(res, 201, { organization, invite });
        return;
      }

      // ===== Per-account provider-reported Token usage =====
      if (path === '/enterprise/usage' && method === 'POST') {
        const account = db.getAccountBySession(extractToken(req, url));
        if (!account) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
        const body = await readBody(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const messageId = typeof body.messageId === 'string' ? body.messageId : '';
        if (!sessionId.trim() || !messageId.trim()) {
          sendJSON(res, 400, { error: 'sessionId and messageId required' });
          return;
        }
        try {
          const recorded = db.recordTokenUsage({
            accountId: account.id,
            sessionId,
            messageId,
            model: typeof body.model === 'string' ? body.model : null,
            inputTokens: Number(body.inputTokens),
            outputTokens: Number(body.outputTokens),
            totalTokens: Number(body.totalTokens),
          });
          sendJSON(res, recorded ? 201 : 200, { recorded, source: 'client_reported' });
        } catch (error) {
          sendJSON(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (path === '/enterprise/usage/summary' && method === 'GET') {
        const period = parseInt(url.searchParams.get('period') || '30', 10);
        sendJSON(
          res,
          200,
          db.getOrganizationUsageSummary(adminPrincipal!.organizationId, period),
        );
        return;
      }

      // ===== Platform-only organization provisioning =====
      if (path === '/enterprise/organizations' && method === 'GET') {
        if (adminPrincipal!.kind !== 'system') {
          sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
          return;
        }
        sendJSON(res, 200, { organizations: db.listOrganizations() });
        return;
      }

      if (path === '/enterprise/organizations' && method === 'POST') {
        if (adminPrincipal!.kind !== 'system') {
          sendJSON(res, 403, { error: 'forbidden: platform admin token required' });
          return;
        }
        const body = await readBody(req);
        const admin = body.admin && typeof body.admin === 'object'
          ? body.admin as Record<string, unknown>
          : {};
        const name = typeof body.name === 'string' ? body.name : '';
        const username = typeof admin.username === 'string' ? admin.username : '';
        const password = typeof admin.password === 'string' ? admin.password : '';
        const adminName = typeof admin.name === 'string' ? admin.name : '';
        if (!name.trim() || !username.trim() || !adminName.trim() || password.length < 8) {
          sendJSON(res, 400, {
            error: '企业名称及首位管理员的用户名、姓名和至少 8 位密码不能为空',
          });
          return;
        }
        try {
          const organization = db.createOrganization({
            name,
            slug: typeof body.slug === 'string' ? body.slug : undefined,
          });
          const firstAdmin = db.createAccount({
            organizationId: organization.id,
            username,
            password,
            name: adminName,
            phone: typeof admin.phone === 'string' ? admin.phone : null,
            role: '企业管理员',
            tags: ['企业管理员'],
            isAdmin: true,
          });
          const invite = withPublicInviteLink(
            db.issueOrganizationInvite(organization.id, Date.now(), firstAdmin.id),
            publicBaseUrl,
          );
          sendJSON(res, 201, { organization, admin: firstAdmin, invite });
        } catch (error) {
          const conflict = accountConflictMessage(error);
          if (conflict) sendJSON(res, 409, { error: conflict });
          else if (/unique constraint|organizations\.slug/i.test(String(error))) {
            sendJSON(res, 409, { error: '企业标识已存在' });
          } else throw error;
        }
        return;
      }

      // ===== IT ticket routing: persist one delivery for every matching account =====
      if (path === '/enterprise/tickets' && method === 'POST') {
        const account = db.getAccountBySession(extractToken(req, url));
        if (!account) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
        const body = await readBody(req);
        const title = typeof body.title === 'string' ? body.title : '';
        const description = typeof body.description === 'string' ? body.description : '';
        if (!title.trim() || !description.trim()) {
          sendJSON(res, 400, { error: 'title and description required' });
          return;
        }
        const targetTags = Array.isArray(body.targetTags)
          ? body.targetTags.filter((tag): tag is string => typeof tag === 'string')
          : ['IT', '报修'];
        const ticket = db.createTicket({
          createdByAccountId: account.id,
          title,
          description,
          targetTags,
        });
        sendJSON(res, 201, { ticket });
        return;
      }

      if (path === '/enterprise/tickets/inbox' && method === 'GET') {
        const account = db.getAccountBySession(extractToken(req, url));
        if (!account) {
          sendJSON(res, 401, { error: '登录已失效，请重新登录' });
          return;
        }
        sendJSON(res, 200, { tickets: db.listTicketInbox(account.id) });
        return;
      }

      // ===== Park / Industrial Park endpoints =====
      if (path === '/enterprise/park' && method === 'POST') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        const address = typeof body.address === 'string' ? body.address : '';
        if (!name.trim()) {
          sendJSON(res, 400, { error: '园区名称不能为空' });
          return;
        }
        const adminUserIds = Array.isArray(body.adminUserIds)
          ? body.adminUserIds.filter((id): id is string => typeof id === 'string') : [];
        const p = park.createPark({ name, address, adminUserIds });
        sendJSON(res, 201, { park: p });
        return;
      }

      if (path === '/enterprise/park/invite' && method === 'POST') {
        const body = await readBody(req);
        const parkId = typeof body.parkId === 'string' ? body.parkId : '';
        const createdBy = adminPrincipal!.kind === 'account'
          ? adminPrincipal!.account.id : 'platform-admin';
        if (!parkId || !park.getPark(parkId)) {
          sendJSON(res, 404, { error: '园区不存在' });
          return;
        }
        const maxUses = typeof body.maxUses === 'number' ? body.maxUses : undefined;
        const invite = park.createInviteCode({ parkId, createdBy, maxUses });
        sendJSON(res, 201, { invite });
        return;
      }

      if (path === '/enterprise/park/join' && method === 'POST') {
        const body = await readBody(req);
        const code = typeof body.code === 'string' ? body.code : '';
        const enterpriseId = typeof body.enterpriseId === 'string' ? body.enterpriseId : '';
        if (!code || !enterpriseId) {
          sendJSON(res, 400, { error: '邀请码和企业ID不能为空' });
          return;
        }
        const result = park.useInviteCode(code, enterpriseId);
        if (!result.success) {
          sendJSON(res, 403, { error: result.error });
          return;
        }
        sendJSON(res, 200, { parkId: result.parkId, enterpriseId });
        return;
      }

      if (path === '/enterprise/park/services' && method === 'GET') {
        const parkId = url.searchParams.get('parkId') || '';
        if (!parkId || !park.getPark(parkId)) {
          sendJSON(res, 404, { error: '园区不存在' });
          return;
        }
        const status = url.searchParams.get('status') || undefined;
        sendJSON(res, 200, {
          requests: park.getParkServiceRequests(parkId, status),
          specialists: park.getSpecialists(parkId),
        });
        return;
      }

      if (path === '/enterprise/park/services/request' && method === 'POST') {
        const body = await readBody(req);
        const parkId = typeof body.parkId === 'string' ? body.parkId : '';
        const enterpriseId = typeof body.enterpriseId === 'string' ? body.enterpriseId : '';
        const type = typeof body.type === 'string' ? body.type : '';
        const description = typeof body.description === 'string' ? body.description : '';
        if (!parkId || !enterpriseId || !type || !description) {
          sendJSON(res, 400, { error: '园区ID、企业ID、服务类型和描述不能为空' });
          return;
        }
        const req_ = park.createServiceRequest({ parkId, enterpriseId, type, description });
        const routed = park.routeServiceRequest(req_.id);
        sendJSON(res, 201, { request: routed });
        return;
      }

      if (path === '/enterprise/park/services/assign' && method === 'POST') {
        const body = await readBody(req);
        const parkId = typeof body.parkId === 'string' ? body.parkId : '';
        const userId = typeof body.userId === 'string' ? body.userId : '';
        const serviceTypes = Array.isArray(body.serviceTypes)
          ? body.serviceTypes.filter((t): t is string => typeof t === 'string') : [];
        if (!parkId || !userId || serviceTypes.length === 0) {
          sendJSON(res, 400, { error: '园区ID、用户ID和服务类型不能为空' });
          return;
        }
        const specialist = park.assignSpecialist({ parkId, userId, serviceTypes });
        sendJSON(res, 201, { specialist });
        return;
      }

      // ===== Join (employee uses invite code) =====
      if (path === '/enterprise/join' && method === 'POST') {
        const body = await readBody(req);
        const invite_code = body.invite_code as string | undefined;
        const employee_name = body.employee_name as string | undefined;
        if (!invite_code || !employee_name) {
          sendJSON(res, 400, { error: 'invite_code and employee_name required' });
          return;
        }
        const result = db.validateInviteCode(invite_code);
        if (!result.valid) {
          sendJSON(res, 403, { error: result.error });
          return;
        }
        const empId = `emp_${Date.now()}_${randomBytes(3).toString('hex')}`;
        db.createEmployee({
          id: empId,
          organizationId: result.organizationId,
          name: employee_name,
          invite_code,
          department: result.department,
        });
        sendJSON(res, 200, {
          employee_id: empId,
          department: result.department,
          message: `Welcome ${employee_name}! Please complete onboarding.`,
          next_step: 'onboard',
        });
        return;
      }

      // ===== Onboard (5 questions) =====
      if (path === '/enterprise/onboard' && method === 'POST') {
        const body = await readBody(req);
        const employee_id = body.employee_id as string | undefined;
        const { role, pain_points, preferred_device, help_focus } = body;
        if (!employee_id) {
          sendJSON(res, 400, { error: 'employee_id required' });
          return;
        }

        const personalityJson = JSON.stringify({
          role,
          pain_points,
          preferred_device,
          help_focus,
          onboarded_at: new Date().toISOString(),
        });

        const emp = db.getEmployee(employee_id, memberAccount!.organizationId) as {
          role?: string;
          department?: string;
          organization_id?: string;
        } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        if (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }

        db.getDB()
          .prepare(
            'UPDATE employees SET role = ?, personality = ? WHERE id = ? AND organization_id = ?',
          )
          .run((role as string) || emp.role, personalityJson, employee_id, emp.organization_id);

        const knowledge = db.getKnowledge(emp.department, undefined, emp.organization_id);

        sendJSON(res, 200, {
          employee_id,
          message: 'Onboarding complete!',
          inherited_knowledge: knowledge.slice(0, 10),
          total_knowledge_items: knowledge.length,
          next_step: 'start_working',
        });
        return;
      }

      // ===== Log task =====
      if (path === '/enterprise/task' && method === 'POST') {
        const body = await readBody(req);
        const employee_id = body.employee_id as string | undefined;
        const task_type = body.task_type as string | undefined;
        if (!employee_id || !task_type) {
          sendJSON(res, 400, { error: 'employee_id and task_type required' });
          return;
        }
        const employee = db.getEmployee(employee_id, memberAccount!.organizationId);
        if (!employee
          || (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id)) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        db.logTask({
          employee_id,
          task_type,
          context: body.context as string | undefined,
          result: body.result as string | undefined,
          duration_min: (body.duration_min as number) || 0,
          // 直接透传原始上报值；成本/token 的兜底口径统一交给 db.logTask 里的归一化。
          // 之前用 `?? default` 时，显式上报 cost_cny:0 不会兜底、会存 0，导致
          // 多数任务 cost=0 时 totalCost 塌小、laborPerToken 爆表。
          tokens_used: body.tokens_used as number | undefined,
          cost_cny: body.cost_cny as number | undefined,
        });
        sendJSON(res, 200, { status: 'logged' });
        return;
      }

      // ===== Recall knowledge =====
      if (path === '/enterprise/recall' && method === 'GET') {
        const employee_id = url.searchParams.get('employee_id') || '';
        const task_type = url.searchParams.get('task_type') || '';
        const emp = db.getEmployee(employee_id, memberAccount!.organizationId) as {
          department?: string;
          organization_id?: string;
        } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        if (!memberAccount!.isAdmin && memberAccount!.employeeId !== employee_id) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const knowledge = db.searchKnowledge(task_type, emp.department, emp.organization_id);
        const history = db.getTaskHistory(employee_id, 5, emp.organization_id);
        sendJSON(res, 200, { knowledge: knowledge.slice(0, 5), history, department: emp.department });
        return;
      }

      // ===== Report =====
      if (path === '/enterprise/report' && method === 'GET') {
        const period = parseInt(url.searchParams.get('period') || '30', 10);
        const department = url.searchParams.get('department') || undefined;
        sendJSON(
          res,
          200,
          db.getReport(period, department, adminPrincipal!.organizationId),
        );
        return;
      }

      // ===== Employees list =====
      if (path === '/enterprise/employees' && method === 'GET') {
        const department = url.searchParams.get('department') || undefined;
        sendJSON(res, 200, {
          employees: db.listEmployees(department, adminPrincipal!.organizationId),
        });
        return;
      }

      // ===== Offboard =====
      if (path === '/enterprise/offboard' && method === 'POST') {
        const body = await readBody(req);
        const employee_id = body.employee_id as string | undefined;
        if (!employee_id) {
          sendJSON(res, 400, { error: 'employee_id required' });
          return;
        }
        const organizationId = adminPrincipal!.organizationId;
        const emp = db.getEmployee(employee_id, organizationId) as {
          name?: string;
          department?: string;
        } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const tasks = db.getTaskHistory(employee_id, 50, organizationId) as Array<{ task_type: string }>;
        const byType: Record<string, number> = {};
        for (const t of tasks) byType[t.task_type] = (byType[t.task_type] || 0) + 1;
        for (const [type, count] of Object.entries(byType)) {
          db.addKnowledge({
            organizationId,
            department: emp.department,
            category: 'offboarded_experience',
            content: `Task "${type}" executed ${count} times by ${emp.name}. Average patterns preserved.`,
            contributor: emp.name,
            confidence: 0.8,
          });
        }
        db.offboardEmployee(employee_id, organizationId);
        sendJSON(res, 200, {
          status: 'offboarded',
          merged_tasks: tasks.length,
          merged_patterns: Object.keys(byType).length,
          message: 'Experience merged to department. No manual handover needed.',
        });
        return;
      }

      // ===== Create invite code (admin) =====
      if (path === '/enterprise/invite' && method === 'POST') {
        const body = await readBody(req);
        const department = body.department as string | undefined;
        const max_uses = body.max_uses as number | undefined;
        if (!department) {
          sendJSON(res, 400, { error: 'department required' });
          return;
        }
        const code = db.createInviteCode(
          department,
          adminPrincipal!.kind === 'account' ? adminPrincipal!.account.id : 'platform-admin',
          max_uses || 1,
          adminPrincipal!.organizationId,
        );
        sendJSON(res, 200, { code, department, max_uses: max_uses || 1 });
        return;
      }

      // ===== Knowledge search =====
      if (path === '/enterprise/knowledge' && method === 'GET') {
        const organizationId = memberAccount!.organizationId;
        const query = url.searchParams.get('q') || '';
        const department = url.searchParams.get('department') || undefined;
        const result = query
          ? db.searchKnowledge(query, department, organizationId)
          : db.getKnowledge(department, undefined, organizationId);
        sendJSON(res, 200, { knowledge: result });
        return;
      }

      // ===== Add knowledge =====
      if (path === '/enterprise/knowledge' && method === 'POST') {
        const organizationId = memberAccount!.organizationId;
        const body = await readBody(req);
        const content = body.content as string | undefined;
        if (!content) {
          sendJSON(res, 400, { error: 'content required' });
          return;
        }
        db.addKnowledge({
          organizationId,
          department: body.department as string | undefined,
          category: (body.category as string) || 'general',
          content,
          contributor: body.contributor as string | undefined,
          confidence: (body.confidence as number) || 0.5,
        });
        sendJSON(res, 200, { status: 'added' });
        return;
      }

      // ===== Audit logs =====
      if (path === '/enterprise/audit' && method === 'GET') {
        sendJSON(res, 200, {
          logs: db.getAuditLogs(50, adminPrincipal!.organizationId),
        });
        return;
      }

      // ===== Export =====
      if (path === '/enterprise/export' && method === 'GET') {
        sendJSON(res, 200, db.exportAll(adminPrincipal!.organizationId));
        return;
      }

      // ===== Preset account admin web app =====
      // 页面本身公开可达，但不包含任何静态管理 token；所有账号数据请求仍必须使用
      // 管理员预设账号登录后拿到的短期会话。
      if (path === '/enterprise/admin' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        res.end(adminAccountsHTML());
        return;
      }

      // ===== Admin Dashboard HTML =====
      if (path === '/enterprise/dashboard' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        });
        // 使用本次请求实际通过鉴权的凭证。企业管理员会话因此只会加载本企业报表；
        // 不再无条件把平台级静态 token 交给所有 dashboard 访问者。
        res.end(adminDashboardHTML(extractToken(req, url)));
        return;
      }

      // ===== Feature Flags Admin API =====
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
      const m = err instanceof Error ? err.message : String(err);
      sendJSON(res, 500, { error: m });
    }
  };
}

function adminAccountsHTML(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Otto 企业账号管理</title>
<style>
:root{--ink:#18221e;--muted:#66716c;--line:#dce3df;--line-strong:#c9d3ce;--paper:#f4f6f5;--panel:#fff;--subtle:#edf2ef;--accent:#176a4b;--accent-hover:#11563c;--accent-soft:#e5f1eb;--danger:#aa3f35;--danger-soft:#faece9;--nav:#14231d;--nav-line:#2d4038;--radius:10px;--shadow:0 18px 48px rgba(26,42,34,.16)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.5}button,input,select{font:inherit}button{cursor:pointer}.hidden{display:none!important}:focus-visible{outline:3px solid rgba(23,106,75,.24);outline-offset:2px}.brand{font-size:23px;font-weight:800;letter-spacing:-.04em}.brand-mark{color:#69d5ab;margin-left:3px}.eyebrow{font-size:11px;letter-spacing:.13em;color:var(--accent);font-weight:750;text-transform:uppercase}
.login{min-height:100vh;display:grid;grid-template-columns:minmax(360px,1fr) minmax(420px,.82fr)}.login-story{padding:54px clamp(36px,7vw,92px);background:var(--nav);color:#f4f8f6;display:flex;flex-direction:column;justify-content:space-between}.login-story .brand{font-size:28px}.story-copy{max-width:650px;margin:72px 0}.story-copy h1{font-size:clamp(38px,5vw,66px);line-height:1.05;letter-spacing:-.055em;margin:14px 0 22px}.story-copy p{color:#aebdb6;font-size:16px;line-height:1.8;max-width:570px}.signal{display:flex;gap:10px;align-items:center;color:#9fb0a8;font-size:13px}.signal b{width:8px;height:8px;border-radius:50%;background:#65d6ad}.login-side{display:grid;place-items:center;padding:42px}.login-card{width:min(420px,100%)}.login-card h2{font-size:31px;letter-spacing:-.035em;margin:13px 0 8px}.login-card>p{color:var(--muted);line-height:1.7;margin:0 0 28px}
.field{display:grid;gap:7px;margin:15px 0}.field label,.field-title{font-size:12px;font-weight:700;color:#46534d}.field input,.field select,.search{width:100%;height:44px;border:1px solid var(--line-strong);border-radius:8px;padding:0 12px;background:#fff;color:var(--ink);outline:none}.field input:focus,.field select:focus,.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,106,75,.1)}.primary,.secondary,.danger,.ghost-dark,.edit,.template-button,.tag-choice{border-radius:8px;font-weight:700;transition:background-color .14s,border-color .14s,color .14s}.primary{border:1px solid var(--accent);background:var(--accent);color:#fff;padding:11px 17px}.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.primary:disabled,.danger:disabled{opacity:.5;cursor:default}.secondary{border:1px solid var(--line-strong);background:#fff;color:var(--ink);padding:10px 15px}.secondary:hover,.edit:hover{border-color:#9caaa3;background:#f8faf9}.danger{border:1px solid var(--danger);background:var(--danger);color:#fff;padding:10px 15px}.login-card .primary{width:100%;height:47px;margin-top:8px}.error{color:var(--danger);background:var(--danger-soft);border:1px solid #edcbc5;padding:10px 12px;border-radius:8px;margin-top:13px;line-height:1.5}
.admin{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr)}.rail{background:var(--nav);color:#edf5f1;padding:26px 19px 20px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.rail .brand{padding:0 9px;margin-bottom:38px}.nav-label{font-size:10px;color:#7f958b;letter-spacing:.12em;margin:8px 11px}.nav-item{display:flex;align-items:center;gap:10px;padding:10px 11px;border:1px solid var(--nav-line);border-radius:8px;background:#20372e;color:#f0f6f3;font-weight:700}.nav-dot{width:7px;height:7px;background:#65d6ad;border-radius:50%}.rail-foot{margin-top:auto;border-top:1px solid var(--nav-line);padding:17px 9px 0}.rail-user{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rail-meta{color:#8fa198;font-size:12px;margin-top:3px}.ghost-dark{border:1px solid #435950;background:transparent;color:#cfdbd5;padding:8px 11px;margin-top:14px;width:100%}.ghost-dark:hover{background:#263d34;border-color:#5a7066}
.workspace{padding:31px clamp(24px,4vw,58px) 56px;min-width:0}.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.topbar h1{font-size:30px;letter-spacing:-.035em;margin:0 0 5px}.topbar p{color:var(--muted);margin:0}.summary-strip{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:17px;overflow:hidden}.summary-item{padding:15px 18px;border-left:1px solid var(--line)}.summary-item:first-child{border-left:0}.summary-item strong{display:block;font-size:23px;line-height:1.2;letter-spacing:-.025em}.summary-item span{display:block;color:var(--muted);font-size:12px;margin-top:4px}.toolbar{display:flex;align-items:center;gap:14px;margin-bottom:11px}.search-wrap{flex:1}.result-count{color:var(--muted);font-size:12px;white-space:nowrap}.table-wrap{background:#fff;border:1px solid var(--line);border-radius:var(--radius);overflow:auto}.accounts{width:100%;border-collapse:collapse;min-width:820px}.accounts th{text-align:left;font-size:11px;letter-spacing:.045em;color:#68736e;background:#edf2ef;padding:11px 14px;border-bottom:1px solid var(--line)}.accounts td{padding:13px 14px;border-top:1px solid #ebefed;vertical-align:middle}.accounts tbody tr:first-child td{border-top:0}.accounts tr:hover td{background:#fafcfb}.name{font-weight:750}.sub{font-size:12px;color:var(--muted);margin-top:3px}.tag{display:inline-block;background:var(--accent-soft);color:#245e49;border:1px solid #d3e6dc;border-radius:999px;padding:3px 8px;font-size:11px;margin:2px 3px 2px 0}.badge{display:inline-block;font-size:11px;border-radius:999px;padding:4px 8px;background:#edf1ef;color:#3f4b45}.badge.ok{background:var(--accent-soft);color:#245e49}.badge.off{background:var(--danger-soft);color:var(--danger)}.edit{border:1px solid var(--line-strong);background:#fff;padding:6px 10px;color:var(--ink)}.empty{text-align:center;color:var(--muted);padding:44px!important}
.ops-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr);gap:14px;margin-bottom:17px}.ops-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;min-width:0}.ops-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.ops-head h2{font-size:16px;margin:2px 0 4px;letter-spacing:-.015em}.ops-head p{font-size:12px;color:var(--muted);margin:0}.invite-row{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-top:18px}.invite-code{font:800 clamp(25px,3vw,38px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.075em;color:var(--ink);white-space:nowrap}.invite-meta{display:flex;align-items:center;gap:8px;margin-top:10px;min-height:25px}.invite-link-preview{max-width:100%;margin-top:10px;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--subtle);color:var(--muted);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.invite-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.token-number{font-size:36px;font-weight:800;letter-spacing:-.045em;line-height:1.1;margin:18px 0 4px}.token-split{display:flex;gap:14px;color:var(--muted);font-size:12px}.token-note{border-top:1px solid var(--line);padding-top:11px;margin-top:14px;color:var(--muted);font-size:11px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.copy{border:1px solid var(--line-strong);background:#fff;color:var(--ink);padding:10px 13px;border-radius:8px;font-weight:700}.copy:hover{background:#f8faf9;border-color:#9caaa3}
.drawer-backdrop{position:fixed;inset:0;background:rgba(15,27,21,.38);display:flex;justify-content:flex-end;z-index:10}.drawer{width:min(620px,100%);height:100%;background:#fff;box-shadow:var(--shadow);padding:27px 30px;overflow:auto}.drawer-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:21px}.drawer h2{margin:3px 0 0;font-size:25px;letter-spacing:-.03em}.close{border:1px solid var(--line);background:#f4f6f5;width:35px;height:35px;border-radius:8px;font-size:20px;line-height:1;color:#53605a}.form-section{border-top:1px solid var(--line);padding-top:18px;margin-top:19px}.form-section:first-of-type{border-top:0;padding-top:0;margin-top:0}.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}.section-head strong{font-size:13px}.section-head span{font-size:12px;color:var(--muted)}.template-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.template-button{border:1px solid var(--line);background:#f8faf9;color:var(--ink);padding:10px 11px;text-align:left}.template-button b{display:block;font-size:13px}.template-button span{display:block;color:var(--muted);font-size:11px;font-weight:500;margin-top:2px}.template-button:hover,.template-button.is-active{border-color:#82a493;background:var(--accent-soft);color:#174f3b}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.wide{grid-column:1/-1}.preset-tags{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 12px}.tag-choice{border:1px solid var(--line-strong);background:#fff;color:#4c5953;padding:6px 10px;font-size:12px}.tag-choice:hover,.tag-choice[aria-pressed=true]{border-color:#6d9b84;background:var(--accent-soft);color:#174f3b}.checkline{display:flex;gap:16px;margin:17px 0}.checkline label{display:flex;align-items:center;gap:7px;font-weight:650}.drawer-actions{display:flex;justify-content:flex-end;gap:9px;border-top:1px solid var(--line);padding-top:18px;margin-top:23px}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,27,21,.5);display:grid;place-items:center;padding:22px;z-index:20}.modal{width:min(420px,100%);background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:24px}.modal-kicker{font-size:11px;color:var(--danger);font-weight:750;letter-spacing:.1em}.modal h2{font-size:22px;letter-spacing:-.025em;margin:8px 0}.modal p{color:var(--muted);margin:0;line-height:1.7}.modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:23px}
@media(max-width:900px){.login{grid-template-columns:1fr}.login-story{display:none}.admin{display:block}.rail{height:auto;position:static;padding:16px 18px;flex-direction:row;align-items:center;gap:18px}.rail .brand{margin:0;padding:0}.nav-label,.nav-item,.rail-meta{display:none}.rail-foot{margin:0 0 0 auto;border:0;padding:0;display:flex;align-items:center;gap:11px}.rail-user{max-width:190px}.ghost-dark{margin:0;width:auto}.workspace{padding:24px 16px 42px}.accounts{min-width:820px}.accounts th,.accounts td{padding-left:10px;padding-right:10px}.ops-grid{grid-template-columns:1fr}}@media(max-width:620px){.login-side{padding:28px 20px}.topbar{align-items:flex-start;flex-direction:column}.topbar .primary{width:100%}.summary-strip{grid-template-columns:1fr 1fr}.summary-item:nth-child(3){border-left:0;border-top:1px solid var(--line)}.summary-item:nth-child(4){border-top:1px solid var(--line)}.toolbar{align-items:stretch;flex-direction:column}.result-count{padding-left:2px}.drawer{padding:23px 18px}.template-grid,.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}.invite-row{align-items:flex-start;flex-direction:column}.invite-actions{justify-content:flex-start}.invite-code{font-size:27px}}
</style></head><body>
<main id="loginView" class="login">
  <section class="login-story"><div class="brand">otto<span class="brand-mark">✦</span></div><div class="story-copy"><div class="eyebrow" style="color:#65d6ad">ENTERPRISE IDENTITY</div><h1>让每个数字同事，都有清晰的身份。</h1><p>集中维护企业成员、部门、职责标签与管理权限。手机号验证码只用于首次注册，之后使用账号或手机号和密码登录。</p></div><div class="signal"><b></b> 企业身份服务在线</div></section>
  <section class="login-side"><form id="loginForm" class="login-card"><div class="eyebrow">ADMIN CONSOLE</div><h2>管理员登录</h2><p>使用管理员账号进入企业身份目录。普通成员无法访问此页面。</p><div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required autofocus></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required></div><button id="loginButton" class="primary" type="submit">进入管理后台</button><div id="loginError" class="error hidden" role="alert"></div></form></section>
</main>
<main id="adminView" class="admin hidden">
  <aside class="rail"><div class="brand">otto<span class="brand-mark">✦</span></div><div class="nav-label">企业管理</div><div class="nav-item"><span class="nav-dot"></span>成员与用量</div><div class="rail-foot"><div><div id="railUser" class="rail-user"></div><div id="railMeta" class="rail-meta">企业管理员</div></div><button id="logoutButton" class="ghost-dark" type="button">退出登录</button></div></aside>
  <section class="workspace"><header class="topbar"><div><div class="eyebrow">ORGANIZATION CONTROL</div><h1 id="organizationTitle">企业账号</h1><p>成员、注册入口、职责标签与 AI 用量都只属于当前企业。</p></div><button id="createButton" class="primary" type="button">新增账号</button></header>
    <div class="ops-grid">
      <section class="ops-card" aria-labelledby="inviteTitle"><div class="ops-head"><div><div class="eyebrow">MEMBER ONBOARDING</div><h2 id="inviteTitle">企业成员引入链接</h2><p>成员点击后由 Otto 打开首次注册并自动填入企业信息；精确有效 7 天，生成新链接会立即废止旧链接。</p></div><span id="inviteBadge" class="badge off">尚未生成</span></div><div class="invite-row"><div><div id="inviteCode" class="invite-code">••••-••••</div><div class="invite-meta"><span id="inviteCountdown" class="sub">等待管理员生成</span></div><div id="inviteLinkPreview" class="invite-link-preview hidden" aria-label="当前企业引入链接"></div></div><div class="invite-actions"><button id="copyInviteLink" class="primary" type="button" disabled>复制企业引入链接</button><button id="copyInvite" class="copy" type="button" disabled>复制邀请码</button><button id="issueInvite" class="secondary" type="button">生成引入链接</button></div></div><div id="inviteError" class="error hidden" role="alert"></div></section>
      <section class="ops-card" aria-labelledby="usageTitle"><div class="ops-head"><div><div class="eyebrow">AI CONSUMPTION</div><h2 id="usageTitle">近 30 天 Token</h2><p>按登录账号汇总模型返回的用量。</p></div><span class="badge">客户端回传</span></div><div id="totalTokens" class="token-number">0</div><div class="token-split"><span>输入 <b id="inputTokens">0</b></span><span>输出 <b id="outputTokens">0</b></span><span>请求 <b id="requestCount">0</b></span></div><div class="token-note">用于企业内部用量观察，不等同于模型供应商的计费账单。</div></section>
    </div>
    <div class="summary-strip" aria-label="账号摘要"><div class="summary-item"><strong id="allCount">0</strong><span>全部账号</span></div><div class="summary-item"><strong id="activeCount">0</strong><span>可登录</span></div><div class="summary-item"><strong id="smsCount">0</strong><span>已绑定手机</span></div><div class="summary-item"><strong id="itCount">0</strong><span>IT 报修接收人</span></div></div>
    <div class="toolbar"><div class="search-wrap"><input id="searchInput" class="search" aria-label="搜索账号" placeholder="搜索姓名、账号、手机号、部门或标签"></div><div id="resultCount" class="result-count">0 个账号</div></div>
    <div class="table-wrap"><table class="accounts"><thead><tr><th>账号</th><th>角色 / 部门</th><th>职责标签</th><th>30 天 Token</th><th>权限</th><th>状态</th><th><span class="hidden">操作</span></th></tr></thead><tbody id="accountRows"></tbody></table></div><div id="pageError" class="error hidden" role="alert"></div>
  </section>
</main>
<div id="drawerWrap" class="drawer-backdrop hidden"><form id="accountForm" class="drawer" aria-labelledby="drawerTitle"><div class="drawer-head"><div><div class="eyebrow">ACCOUNT DETAIL</div><h2 id="drawerTitle">新增账号</h2></div><button id="closeDrawer" class="close" type="button" aria-label="关闭账号表单">×</button></div><input id="accountId" type="hidden">
  <section class="form-section" aria-labelledby="templateTitle"><div class="section-head"><strong id="templateTitle">账户模板</strong><span>选择后仍可继续调整</span></div><div class="template-grid">
    <button class="template-button" type="button" data-account-template="member"><b>普通成员</b><span>基础协作与日常任务</span></button>
    <button class="template-button" type="button" data-account-template="lead"><b>部门负责人</b><span>部门管理与审批职责</span></button>
    <button class="template-button" type="button" data-account-template="it"><b>IT 支持</b><span>接收报修与技术支持</span></button>
    <button class="template-button" type="button" data-account-template="finance"><b>财务审批</b><span>财务流程与审批职责</span></button>
    <button class="template-button" type="button" data-account-template="admin"><b>系统管理员</b><span>完整后台管理权限</span></button>
  </div></section>
  <section class="form-section"><div class="section-head"><strong>基本信息</strong><span>姓名与手机号用于识别成员</span></div><div class="form-grid">
    <div class="field"><label for="editUsername">用户名</label><input id="editUsername" autocomplete="off" required></div><div class="field"><label for="editName">姓名</label><input id="editName" autocomplete="off" required></div>
    <div class="field wide"><label for="editPhone">手机号码</label><input id="editPhone" inputmode="tel" autocomplete="tel" placeholder="13800138000"></div>
    <div class="field"><label for="editRole">角色</label><input id="editRole" placeholder="例如：产品经理"></div><div class="field"><label for="editDepartment">部门</label><input id="editDepartment" list="departmentPresetList" placeholder="选择或输入部门"><datalist id="departmentPresetList"></datalist></div>
  </div></section>
  <section class="form-section"><div class="section-head"><strong>预设标签</strong><span>可多选，也可输入自定义标签</span></div><div id="tagPresets" class="preset-tags" aria-label="预设标签"></div><div class="field"><label for="editTags">自定义标签（用逗号分隔）</label><input id="editTags" placeholder="例如：产品, 审批, 夜班"></div></section>
  <section class="form-section"><div class="section-head"><strong>登录与权限</strong><span>新增账号必须设置密码</span></div><div class="form-grid"><div class="field wide"><label for="editPassword">登录密码</label><input id="editPassword" type="password" minlength="8" autocomplete="new-password"><small id="passwordHint" class="sub">至少 8 位</small></div><div class="field"><label for="editStatus">账号状态</label><select id="editStatus"><option value="active">可登录</option><option value="disabled">已停用</option></select></div></div><div class="checkline"><label><input id="editAdmin" type="checkbox"> 允许访问管理员后台</label></div></section>
  <div id="formError" class="error hidden" role="alert"></div><div class="drawer-actions"><button id="cancelEdit" class="secondary" type="button">取消</button><button id="saveAccount" class="primary" type="submit">保存账号</button></div>
</form></div>
<div id="logoutModal" class="modal-backdrop hidden"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="logoutTitle"><div class="modal-kicker">SECURITY CHECK</div><h2 id="logoutTitle">确认退出管理员后台</h2><p>退出后需要重新输入管理员用户名和密码。未保存的账号修改不会保留。</p><div class="modal-actions"><button id="cancelLogout" class="secondary" type="button">取消</button><button id="confirmLogout" class="danger" type="button">确认退出</button></div></section></div>
<div id="inviteModal" class="modal-backdrop hidden"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="inviteConfirmTitle"><div class="modal-kicker">MEMBER ONBOARDING</div><h2 id="inviteConfirmTitle">生成新的企业引入链接？</h2><p>新链接将在生成时开始计时，7 天后失效。当前仍有效的链接会立即作废，已发出的旧链接将无法用于首次注册。</p><div class="modal-actions"><button id="cancelInvite" class="secondary" type="button">取消</button><button id="confirmInvite" class="primary" type="button">确认生成</button></div></section></div>
<script>
const KEY='otto.enterprise.admin.session';
const departmentPresets=['总经办','人力资源部','财务部','法务部','销售部','市场部','产品部','研发部','设计部','IT部','客户成功部','采购部'];
const tagPresets=['普通成员','部门负责人','行政','人事','财务','审批','法务','销售','市场','产品','研发','设计','IT','报修','客户支持','采购','数据','夜班'];
const accountTemplates={
  member:{role:'成员',department:'',tags:['普通成员'],isAdmin:false},
  lead:{role:'部门负责人',department:'',tags:['部门负责人','审批'],isAdmin:false},
  it:{role:'IT 支持',department:'IT部',tags:['IT','报修'],isAdmin:false},
  finance:{role:'财务审批',department:'财务部',tags:['财务','审批'],isAdmin:false},
  admin:{role:'系统管理员',department:'IT部',tags:['系统管理员','IT'],isAdmin:true}
};
let token=sessionStorage.getItem(KEY)||'';let currentAdmin=null;let accounts=[];let currentInvite=null;let usageSummary=null;let inviteTimer=null;
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showError(id,message){const el=$(id);el.textContent=message||'';el.classList.toggle('hidden',!message)}
async function api(path,options){const o=options||{};o.headers=Object.assign({'content-type':'application/json'},o.headers||{},token?{authorization:'Bearer '+token}:{});const response=await fetch(path,o);const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||('请求失败 '+response.status));return data}
function showLogin(message){$('adminView').classList.add('hidden');$('loginView').classList.remove('hidden');showError('loginError',message||'')}
function showAdmin(){showError('loginError','');$('loginView').classList.add('hidden');$('adminView').classList.remove('hidden');$('railUser').textContent=currentAdmin.name+' · '+currentAdmin.username;$('railMeta').textContent=currentAdmin.organizationName+' · 企业管理员';$('organizationTitle').textContent=currentAdmin.organizationName}
function tags(value){return Array.from(new Set(String(value||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean)))}
function number(value){return new Intl.NumberFormat('zh-CN').format(Number(value)||0)}
function setTags(values){$('editTags').value=tags(values.join(', ')).join(', ');updateTagPresetState()}
function updateTagPresetState(){const selected=new Set(tags($('editTags').value));document.querySelectorAll('[data-tag-preset]').forEach(button=>button.setAttribute('aria-pressed',selected.has(button.dataset.tagPreset)?'true':'false'))}
function renderPresets(){$('departmentPresetList').innerHTML=departmentPresets.map(item=>'<option value="'+esc(item)+'"></option>').join('');$('tagPresets').innerHTML=tagPresets.map(item=>'<button class="tag-choice" type="button" data-tag-preset="'+esc(item)+'" aria-pressed="false">'+esc(item)+'</button>').join('');document.querySelectorAll('[data-tag-preset]').forEach(button=>button.addEventListener('click',()=>{const selected=tags($('editTags').value);const index=selected.indexOf(button.dataset.tagPreset);if(index>=0)selected.splice(index,1);else selected.push(button.dataset.tagPreset);setTags(selected)}))}
function render(){const q=$('searchInput').value.trim().toLowerCase();const rows=accounts.filter(account=>!q||[account.name,account.username,account.phone,account.role,account.department].concat(account.tags||[]).some(value=>String(value||'').toLowerCase().includes(q)));$('allCount').textContent=String(accounts.length);$('activeCount').textContent=String(accounts.filter(account=>account.status==='active').length);$('smsCount').textContent=String(accounts.filter(account=>account.phone).length);$('itCount').textContent=String(accounts.filter(account=>(account.tags||[]).includes('IT')&&(account.tags||[]).includes('报修')).length);$('resultCount').textContent=rows.length+' 个账号';$('accountRows').innerHTML=rows.length?rows.map(account=>'<tr><td><div class="name">'+esc(account.name)+'</div><div class="sub">@'+esc(account.username)+(account.phone?' · '+esc(account.phone):' · 未绑定手机')+'</div></td><td>'+esc(account.role||'未设置角色')+'<div class="sub">'+esc(account.department||'未分配部门')+'</div></td><td>'+((account.tags||[]).map(tag=>'<span class="tag">'+esc(tag)+'</span>').join('')||'<span class="sub">无标签</span>')+'</td><td><div class="name mono">'+number(account.usage&&account.usage.totalTokens)+'</div><div class="sub">'+number(account.usage&&account.usage.requestCount)+' 次请求</div></td><td>'+(account.isAdmin?'<span class="badge">管理员</span>':'<span class="sub">普通成员</span>')+'</td><td><span class="badge '+(account.status==='active'?'ok':'off')+'">'+(account.status==='active'?'可登录':'已停用')+'</span></td><td><button class="edit" type="button" data-id="'+esc(account.id)+'">编辑</button></td></tr>').join(''):'<tr><td class="empty" colspan="7">没有匹配账号，请调整搜索条件</td></tr>';document.querySelectorAll('button[data-id]').forEach(button=>button.addEventListener('click',()=>openEditor(accounts.find(account=>account.id===button.dataset.id))))}
function renderUsage(){const summary=usageSummary||{};$('totalTokens').textContent=number(summary.totalTokens);$('inputTokens').textContent=number(summary.totalInputTokens);$('outputTokens').textContent=number(summary.totalOutputTokens);$('requestCount').textContent=number(summary.requestCount)}
function registrationInviteLink(){return currentInvite&&typeof currentInvite.link==='string'?currentInvite.link:''}
function renderInvite(){if(inviteTimer){clearInterval(inviteTimer);inviteTimer=null}const active=currentInvite&&currentInvite.status==='active'&&new Date(currentInvite.expiresAt).getTime()>Date.now();const link=active?registrationInviteLink():'';$('inviteCode').textContent=currentInvite?currentInvite.code:'••••-••••';$('copyInvite').disabled=!active;$('copyInviteLink').disabled=!active;$('inviteLinkPreview').textContent=link;$('inviteLinkPreview').classList.toggle('hidden',!link);$('issueInvite').textContent=currentInvite?'生成新链接':'生成引入链接';$('inviteBadge').className='badge '+(active?'ok':'off');$('inviteBadge').textContent=active?'有效 7 天':currentInvite?'已失效':'尚未生成';function tick(){if(!currentInvite)return;const left=new Date(currentInvite.expiresAt).getTime()-Date.now();if(left<=0){currentInvite.status='expired';renderInvite();return}const h=Math.floor(left/3600000);const m=Math.floor((left%3600000)/60000);const s=Math.floor((left%60000)/1000);$('inviteCountdown').textContent='剩余 '+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+' · 到期 '+new Date(currentInvite.expiresAt).toLocaleString('zh-CN',{hour12:false})}if(active){tick();inviteTimer=setInterval(tick,1000)}else $('inviteCountdown').textContent=currentInvite?'已到期，请手动生成新的企业引入链接':'等待管理员生成'}
async function loadWorkspace(){const results=await Promise.all([api('/enterprise/accounts'),api('/enterprise/organization/invite'),api('/enterprise/usage/summary?period=30')]);accounts=results[0].accounts||[];currentInvite=results[1].invite||null;usageSummary=results[2]||null;render();renderInvite();renderUsage()}
function clearTemplateSelection(){document.querySelectorAll('[data-account-template]').forEach(button=>button.classList.remove('is-active'))}
function applyTemplate(key,button){const template=accountTemplates[key];if(!template)return;$('editRole').value=template.role;$('editDepartment').value=template.department;setTags(template.tags);$('editAdmin').checked=template.isAdmin;clearTemplateSelection();button.classList.add('is-active')}
function openEditor(account){const editing=!!account;$('drawerTitle').textContent=editing?'编辑账号':'新增账号';$('accountId').value=editing?account.id:'';$('editUsername').value=editing?account.username:'';$('editName').value=editing?account.name:'';$('editPhone').value=editing?(account.phone||'').replace('+86',''):'';$('editRole').value=editing?(account.role||''):'';$('editDepartment').value=editing?(account.department||''):'';$('editTags').value=editing?(account.tags||[]).join(', '):'';$('editPassword').value='';$('editPassword').required=!editing;$('passwordHint').textContent=editing?'留空表示不修改密码':'至少 8 位，建议混合字母、数字和符号';$('editStatus').value=editing?account.status:'active';$('editAdmin').checked=editing&&account.isAdmin;clearTemplateSelection();updateTagPresetState();showError('formError','');$('drawerWrap').classList.remove('hidden');$('editUsername').focus()}
function closeEditor(){$('drawerWrap').classList.add('hidden')}
function openLogout(){$('logoutModal').classList.remove('hidden');$('cancelLogout').focus()}
function closeLogout(){$('logoutModal').classList.add('hidden');$('logoutButton').focus()}
async function logout(){const button=$('confirmLogout');button.disabled=true;button.textContent='正在退出';try{await api('/enterprise/auth/logout',{method:'POST'})}catch{}finally{token='';currentAdmin=null;sessionStorage.removeItem(KEY);button.disabled=false;button.textContent='确认退出';$('logoutModal').classList.add('hidden');showLogin('')}}
function openInviteConfirm(){$('inviteModal').classList.remove('hidden');$('cancelInvite').focus()}
function closeInviteConfirm(){$('inviteModal').classList.add('hidden');$('issueInvite').focus()}
async function issueInvite(){const button=$('confirmInvite');button.disabled=true;button.textContent='正在生成';showError('inviteError','');try{const data=await api('/enterprise/organization/invite',{method:'POST'});currentInvite=data.invite;$('inviteModal').classList.add('hidden');renderInvite()}catch(error){$('inviteModal').classList.add('hidden');showError('inviteError',error.message)}finally{button.disabled=false;button.textContent='确认生成'}}
async function copyInvite(){if(!currentInvite||currentInvite.status!=='active')return;try{await navigator.clipboard.writeText(currentInvite.code);const button=$('copyInvite');button.textContent='已复制邀请码';setTimeout(()=>{button.textContent='复制邀请码'},1500)}catch{showError('inviteError','复制失败，请手动选择邀请码')}}
async function copyInviteLink(){const link=registrationInviteLink();if(!link||!currentInvite||currentInvite.status!=='active')return;try{await navigator.clipboard.writeText(link);const button=$('copyInviteLink');button.textContent='已复制引入链接';setTimeout(()=>{button.textContent='复制企业引入链接'},1500)}catch{showError('inviteError','复制失败，可手动选择下方的企业引入链接')}}
renderPresets();
document.querySelectorAll('[data-account-template]').forEach(button=>button.addEventListener('click',()=>applyTemplate(button.dataset.accountTemplate,button)));
$('editTags').addEventListener('input',updateTagPresetState);
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();showError('loginError','');$('loginButton').disabled=true;try{const data=await api('/enterprise/auth/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})});if(!data.account||!data.account.isAdmin)throw new Error('该账号没有管理员权限');token=data.token;currentAdmin=data.account;sessionStorage.setItem(KEY,token);$('password').value='';showAdmin();await loadWorkspace()}catch(error){token='';sessionStorage.removeItem(KEY);showLogin(error.message)}finally{$('loginButton').disabled=false}});
$('logoutButton').addEventListener('click',openLogout);$('cancelLogout').addEventListener('click',closeLogout);$('confirmLogout').addEventListener('click',logout);$('logoutModal').addEventListener('click',event=>{if(event.target===$('logoutModal'))closeLogout()});
$('issueInvite').addEventListener('click',openInviteConfirm);$('cancelInvite').addEventListener('click',closeInviteConfirm);$('confirmInvite').addEventListener('click',issueInvite);$('inviteModal').addEventListener('click',event=>{if(event.target===$('inviteModal'))closeInviteConfirm()});$('copyInvite').addEventListener('click',copyInvite);$('copyInviteLink').addEventListener('click',copyInviteLink);
$('searchInput').addEventListener('input',render);$('createButton').addEventListener('click',()=>openEditor(null));$('closeDrawer').addEventListener('click',closeEditor);$('cancelEdit').addEventListener('click',closeEditor);$('drawerWrap').addEventListener('click',event=>{if(event.target===$('drawerWrap'))closeEditor()});
$('accountForm').addEventListener('submit',async event=>{event.preventDefault();showError('formError','');const id=$('accountId').value;const password=$('editPassword').value;const body={username:$('editUsername').value.trim(),name:$('editName').value.trim(),phone:$('editPhone').value.trim()||null,role:$('editRole').value.trim(),department:$('editDepartment').value.trim(),tags:tags($('editTags').value),status:$('editStatus').value,isAdmin:$('editAdmin').checked};if(password)body.password=password;if(!id&&!password){showError('formError','新增账号必须设置密码');return}$('saveAccount').disabled=true;try{await api(id?'/enterprise/accounts/'+encodeURIComponent(id):'/enterprise/accounts',{method:id?'PATCH':'POST',body:JSON.stringify(body)});closeEditor();await loadWorkspace()}catch(error){showError('formError',error.message)}finally{$('saveAccount').disabled=false}});
document.addEventListener('keydown',event=>{if(event.key!=='Escape')return;if(!$('inviteModal').classList.contains('hidden'))closeInviteConfirm();else if(!$('logoutModal').classList.contains('hidden'))closeLogout();else if(!$('drawerWrap').classList.contains('hidden'))closeEditor()});
(async()=>{if(!token)return showLogin('');try{const data=await api('/enterprise/auth/me');if(!data.account.isAdmin)throw new Error('该账号没有管理员权限');currentAdmin=data.account;showAdmin();await loadWorkspace()}catch{token='';sessionStorage.removeItem(KEY);showLogin('登录已失效，请重新登录')}})();
</script></body></html>`;
}

function adminDashboardHTML(token: string): string {
  // 看板自身的 fetch 要带上 admin token（report/employees/audit 都是管理路由）。
  const tokenJson = JSON.stringify(token || '');
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
</style>
</head><body>
<div class="header"><h1>Otto Enterprise</h1><span id="updateTime"></span></div>
<div class="note" id="discloseNote">数据全部存在本机 <b>~/.otto-enterprise/data.db</b>，零云端。标 <b>估算</b> 的指标基于假设，非实测。</div>
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
const TOKEN=${tokenJson};
const H=TOKEN?{'x-otto-admin-token':TOKEN}:{};
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function j(u){const r=await fetch(u,{headers:H});if(!r.ok)throw new Error(u+' '+r.status);return r.json();}
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
load();setInterval(load,10000);
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
  const port = opts.port || parseInt(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT), 10);
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

  // 构造 FeatureFlagManager（读取当前工作目录下的项目配置）
  const cwd = process.cwd();
  const settingsManager = new ProjectSettingsManager(cwd);
  settingsManager.load();
  const featureFlags = new FeatureFlagManager(settingsManager);

  const server = createServer(
    makeHandler(adminToken, smsSender, publicBaseUrl, featureFlags),
  );
  return { server, host, port, publicBaseUrl, adminToken, generatedToken };
}

/** 组装并 listen；返回 http.Server。打印访问地址与（如有）自动生成的 token。 */
export function startEnterpriseServer(opts: EnterpriseServerOptions = {}): Server {
  const {
    server,
    host,
    port,
    publicBaseUrl,
    adminToken,
    generatedToken,
  } = createEnterpriseServer(opts);
  server.listen(port, host, () => {
    const tokenQuery = adminToken ? `?token=${adminToken}` : '';
    console.log(`[Otto Enterprise] 服务端运行于 http://${host}:${port}`);
    console.log(`[Otto Enterprise] 账号管理: http://localhost:${port}/enterprise/admin`);
    console.log(`[Otto Enterprise] 企业引入: ${publicBaseUrl}/enterprise/join/{邀请码}`);
    console.log(`[Otto Enterprise] 老板看板: http://localhost:${port}/enterprise/dashboard${tokenQuery}`);
    console.log(`[Otto Enterprise] 数据: ~/.otto-enterprise/data.db（本地，零云端）`);
    if (adminToken) {
      console.log(
        `[Otto Enterprise] 管理令牌${generatedToken ? '（自动生成，请保存）' : ''}: ${adminToken}`,
      );
    } else {
      console.log('[Otto Enterprise] 仅本机访问，未设管理令牌（设 OTTO_ENTERPRISE_ADMIN_TOKEN 可加固）');
    }
    console.log('[Otto Enterprise] Ctrl+C 停止');
  });
  return server;
}
