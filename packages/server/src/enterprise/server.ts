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
]);

interface RouteBody {
  [key: string]: unknown;
}

export interface EnterpriseServerOptions {
  port?: number;
  host?: string;
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

function accountConflictMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message === '手机号已绑定其他账号' || /accounts\.phone|idx_accounts_phone_unique/i.test(message)) {
    return '手机号已绑定其他账号';
  }
  if (/unique constraint|accounts\.username/i.test(message)) return '账号名已存在';
  return null;
}

function makeHandler(adminToken: string, smsSender: VerificationSmsSender | null) {
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 管理端鉴权：兼容原有静态 admin token，同时允许预设管理员账号的登录会话。
    // 本机模式未配置 adminToken 时维持旧行为（仅 loopback 使用）；对外监听时 start
    // 会自动生成 admin token，因此不会出现公网裸管理接口。
    if (adminToken && isAdminRoute(path)) {
      const token = extractToken(req, url);
      if (!tokensMatch(token, adminToken)) {
        const account = db.getAccountBySession(token);
        if (!account) {
          sendJSON(res, 401, { error: 'unauthorized: admin login required' });
          return;
        }
        if (!account.isAdmin) {
          sendJSON(res, 403, { error: 'forbidden: admin account required' });
          return;
        }
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

      // ===== Preset account authentication (no email flow) =====
      if (path === '/enterprise/auth/login' && method === 'POST') {
        const body = await readBody(req);
        const username = typeof body.username === 'string' ? body.username : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const account = db.authenticateAccount(username, password);
        if (!account) {
          // 不区分「账号不存在」与「密码错误」，避免泄露预设账号清单。
          sendJSON(res, 401, { error: '账号或密码错误' });
          return;
        }
        const session = db.createAuthSession(account.id);
        sendJSON(res, 200, { account, token: session.token, expiresAt: session.expiresAt });
        return;
      }

      if (path === '/enterprise/auth/sms/request' && method === 'POST') {
        if (!smsSender) {
          sendJSON(res, 503, { error: '短信登录暂不可用，请使用账号密码登录' });
          return;
        }
        const body = await readBody(req);
        const rawPhone = typeof body.phone === 'string' ? body.phone : '';
        let phone: string;
        try {
          phone = db.normalizePhone(rawPhone);
        } catch {
          sendJSON(res, 400, { error: '请输入正确的中国大陆手机号' });
          return;
        }

        const genericMessage = '若该手机号已绑定 Otto 账号，验证码将在 5 分钟内送达';
        const account = db.findActiveAccountByPhone(phone);
        if (!account) {
          sendJSON(res, 200, {
            challengeId: `sms_${randomBytes(18).toString('base64url')}`,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            retryAfterSeconds: 60,
            message: genericMessage,
          });
          return;
        }

        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const issued = db.createSmsLoginChallenge(account.id, code);
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
          db.discardSmsLoginChallenge(issued.challengeId);
          sendJSON(res, 502, { error: '验证码发送失败，请稍后重试或使用账号密码登录' });
          return;
        }
        sendJSON(res, 200, { ...issued, message: genericMessage });
        return;
      }

      if (path === '/enterprise/auth/sms/verify' && method === 'POST') {
        const body = await readBody(req);
        const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!challengeId || !/^\d{6}$/.test(code)) {
          sendJSON(res, 400, { error: '请输入 6 位短信验证码' });
          return;
        }
        const verified = db.verifySmsLoginChallenge(challengeId, code);
        if (!verified.ok) {
          sendJSON(res, 401, {
            error: verified.reason === 'locked'
              ? '验证码错误次数过多，请重新获取'
              : '验证码错误或已失效',
            attemptsRemaining: verified.attemptsRemaining,
          });
          return;
        }
        const session = db.createAuthSession(verified.account.id);
        sendJSON(res, 200, {
          account: verified.account,
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
        sendJSON(res, 200, { accounts: db.listAccounts() });
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
        if (!accountId || !db.getAccount(accountId)) {
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
          });
          sendJSON(res, 200, { account });
        } catch (error) {
          const conflict = accountConflictMessage(error);
          if (conflict) sendJSON(res, 409, { error: conflict });
          else throw error;
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

        const emp = db.getEmployee(employee_id) as { role?: string; department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }

        db.getDB()
          .prepare('UPDATE employees SET role = ?, personality = ? WHERE id = ?')
          .run((role as string) || emp.role, personalityJson, employee_id);

        const knowledge = db.getKnowledge(emp.department);

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
        const emp = db.getEmployee(employee_id) as { department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const knowledge = db.searchKnowledge(task_type, emp.department);
        const history = db.getTaskHistory(employee_id, 5);
        sendJSON(res, 200, { knowledge: knowledge.slice(0, 5), history, department: emp.department });
        return;
      }

      // ===== Report =====
      if (path === '/enterprise/report' && method === 'GET') {
        const period = parseInt(url.searchParams.get('period') || '30', 10);
        const department = url.searchParams.get('department') || undefined;
        sendJSON(res, 200, db.getReport(period, department));
        return;
      }

      // ===== Employees list =====
      if (path === '/enterprise/employees' && method === 'GET') {
        const department = url.searchParams.get('department') || undefined;
        sendJSON(res, 200, { employees: db.listEmployees(department) });
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
        const emp = db.getEmployee(employee_id) as { name?: string; department?: string } | null;
        if (!emp) {
          sendJSON(res, 404, { error: 'Employee not found' });
          return;
        }
        const tasks = db.getTaskHistory(employee_id, 50) as Array<{ task_type: string }>;
        const byType: Record<string, number> = {};
        for (const t of tasks) byType[t.task_type] = (byType[t.task_type] || 0) + 1;
        for (const [type, count] of Object.entries(byType)) {
          db.addKnowledge({
            department: emp.department,
            category: 'offboarded_experience',
            content: `Task "${type}" executed ${count} times by ${emp.name}. Average patterns preserved.`,
            contributor: emp.name,
            confidence: 0.8,
          });
        }
        db.offboardEmployee(employee_id);
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
        const code = db.createInviteCode(department, 'admin', max_uses || 1);
        sendJSON(res, 200, { code, department, max_uses: max_uses || 1 });
        return;
      }

      // ===== Knowledge search =====
      if (path === '/enterprise/knowledge' && method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const department = url.searchParams.get('department') || undefined;
        const result = query ? db.searchKnowledge(query, department) : db.getKnowledge(department);
        sendJSON(res, 200, { knowledge: result });
        return;
      }

      // ===== Add knowledge =====
      if (path === '/enterprise/knowledge' && method === 'POST') {
        const body = await readBody(req);
        const content = body.content as string | undefined;
        if (!content) {
          sendJSON(res, 400, { error: 'content required' });
          return;
        }
        db.addKnowledge({
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
        sendJSON(res, 200, { logs: db.getAuditLogs(50) });
        return;
      }

      // ===== Export =====
      if (path === '/enterprise/export' && method === 'GET') {
        sendJSON(res, 200, db.exportAll());
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
        res.end(adminDashboardHTML(adminToken));
        return;
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
<title>Otto 账号管理</title>
<style>
:root{--ink:#18201d;--muted:#6d7772;--line:#dfe4e1;--paper:#f7f8f6;--panel:#fff;--accent:#176b50;--accent-soft:#e5f0eb;--warn:#a74c32;--shadow:0 22px 60px rgba(29,45,38,.12)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px}button,input,select{font:inherit}
button{cursor:pointer}.hidden{display:none!important}.brand{font-size:22px;font-weight:760;letter-spacing:-.04em}.brand i{font-style:normal;color:var(--accent)}
.login{min-height:100vh;display:grid;grid-template-columns:minmax(320px,1.05fr) minmax(360px,.95fr)}.login-story{padding:64px clamp(36px,7vw,96px);background:#17251f;color:#f4f7f5;display:flex;flex-direction:column;justify-content:space-between}.login-story .brand{font-size:27px}.login-story h1{font-size:clamp(38px,5vw,68px);line-height:1.04;letter-spacing:-.055em;max-width:680px;margin:80px 0 20px}.login-story p{color:#aab9b2;font-size:16px;line-height:1.8;max-width:560px}.signal{display:flex;gap:8px;align-items:center;color:#aab9b2}.signal b{width:8px;height:8px;border-radius:50%;background:#57d3a6;box-shadow:0 0 0 5px rgba(87,211,166,.12)}
.login-side{display:grid;place-items:center;padding:34px}.login-card{width:min(430px,100%)}.eyebrow{font-size:11px;letter-spacing:.14em;color:var(--accent);font-weight:750}.login-card h2{font-size:32px;letter-spacing:-.04em;margin:12px 0 8px}.login-card>p{color:var(--muted);line-height:1.7;margin:0 0 30px}.field{display:grid;gap:8px;margin:16px 0}.field label{font-size:12px;font-weight:650;color:#4c5852}.field input,.field select{width:100%;height:46px;border:1px solid var(--line);border-radius:9px;padding:0 13px;background:#fff;color:var(--ink);outline:none}.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(23,107,80,.1)}.primary{border:0;background:var(--accent);color:white;border-radius:9px;padding:12px 18px;font-weight:700}.primary:disabled{opacity:.5;cursor:default}.login-card .primary{width:100%;height:48px;margin-top:10px}.error{color:var(--warn);background:#f8ebe7;border:1px solid #efd4ca;padding:10px 12px;border-radius:8px;margin-top:14px;line-height:1.5}
.admin{min-height:100vh;display:grid;grid-template-columns:236px 1fr}.rail{background:#17251f;color:#eef4f1;padding:28px 22px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.rail .brand{margin-bottom:48px}.nav-label{font-size:11px;color:#7f948a;letter-spacing:.12em;margin:8px 10px}.nav-item{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:8px;background:#243a31;color:#f1f6f3;font-weight:650}.nav-item span{width:7px;height:7px;background:#65d6ad;border-radius:50%}.rail-foot{margin-top:auto;border-top:1px solid #30453c;padding-top:18px}.rail-user{font-weight:650}.rail-meta{color:#8fa198;font-size:12px;margin-top:4px}.ghost-dark{border:1px solid #43584f;background:transparent;color:#cbd7d1;border-radius:8px;padding:8px 11px;margin-top:14px}
.workspace{padding:34px clamp(28px,4vw,64px) 60px;min-width:0}.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:30px}.topbar h1{font-size:34px;letter-spacing:-.045em;margin:0 0 7px}.topbar p{color:var(--muted);margin:0}.stats{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:12px;margin-bottom:22px}.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}.stat strong{font-size:25px;display:block;letter-spacing:-.03em}.stat span{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:10px;margin-bottom:12px}.search{flex:1;height:42px;border:1px solid var(--line);background:#fff;border-radius:9px;padding:0 13px;outline:none}.table-wrap{background:#fff;border:1px solid var(--line);border-radius:13px;overflow:auto}.accounts{width:100%;border-collapse:collapse;min-width:800px}.accounts th{text-align:left;font-size:11px;letter-spacing:.05em;color:#7a847f;background:#f1f4f2;padding:12px 14px}.accounts td{padding:13px 14px;border-top:1px solid #edf0ee;vertical-align:middle}.accounts tr:hover td{background:#fbfcfb}.name{font-weight:700}.sub{font-size:12px;color:var(--muted);margin-top:3px}.tag{display:inline-block;background:var(--accent-soft);color:#245e49;border-radius:99px;padding:3px 8px;font-size:11px;margin:2px 3px 2px 0}.badge{font-size:11px;border-radius:99px;padding:4px 8px;background:#edf0ee}.badge.off{background:#f6e9e5;color:var(--warn)}.edit{border:1px solid var(--line);background:#fff;border-radius:7px;padding:6px 10px;color:var(--ink)}.empty{text-align:center;color:var(--muted);padding:40px!important}
.drawer-backdrop{position:fixed;inset:0;background:rgba(17,28,23,.28);display:flex;justify-content:flex-end;z-index:5}.drawer{width:min(520px,100%);height:100%;background:#fff;box-shadow:var(--shadow);padding:28px;overflow:auto}.drawer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.drawer h2{margin:0;font-size:25px;letter-spacing:-.035em}.close{border:0;background:#eef1ef;width:34px;height:34px;border-radius:50%;font-size:18px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.wide{grid-column:1/-1}.checkline{display:flex;gap:16px;margin:18px 0}.checkline label{display:flex;align-items:center;gap:7px}.drawer-actions{display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--line);padding-top:18px;margin-top:24px}.secondary{border:1px solid var(--line);background:white;border-radius:9px;padding:11px 16px}
@media(max-width:820px){.login{grid-template-columns:1fr}.login-story{display:none}.admin{grid-template-columns:1fr}.rail{height:auto;position:static;padding:18px 22px;flex-direction:row;align-items:center}.rail .brand{margin:0}.nav-label,.nav-item,.rail-meta{display:none}.rail-foot{margin:0 0 0 auto;border:0;padding:0;display:flex;align-items:center;gap:10px}.ghost-dark{margin:0}.workspace{padding:24px 16px 44px}.topbar{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body>
<main id="loginView" class="login">
  <section class="login-story"><div class="brand">otto<i>✦</i></div><div><div class="eyebrow" style="color:#65d6ad">ENTERPRISE CONTROL</div><h1>账号有边界，协作才清晰。</h1><p>管理员在这里维护预设账号、部门、角色与标签。没有公开注册，也没有邮箱验证流程。</p></div><div class="signal"><b></b> Ubuntu-wysn · 管理服务在线</div></section>
  <section class="login-side"><form id="loginForm" class="login-card"><div class="eyebrow">SECURE ADMIN ACCESS</div><h2>管理员登录</h2><p>请输入管理员账号的用户名与强密码。普通员工账号无法进入此页面。</p><div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required autofocus></div><div class="field"><label for="password">强密码</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required></div><button id="loginButton" class="primary" type="submit">进入账号管理</button><div id="loginError" class="error hidden" role="alert"></div></form></section>
</main>
<main id="adminView" class="admin hidden">
  <aside class="rail"><div class="brand">otto<i>✦</i></div><div class="nav-label">管理</div><div class="nav-item"><span></span>全部账号</div><div class="rail-foot"><div><div id="railUser" class="rail-user"></div><div class="rail-meta">系统管理员</div></div><button id="logoutButton" class="ghost-dark">退出</button></div></aside>
  <section class="workspace"><header class="topbar"><div><h1>企业身份目录</h1><p>统一维护账号、手机登录、组织角色和职责标签。</p></div><button id="createButton" class="primary">＋ 新增账号</button></header><div class="stats"><div class="stat"><strong id="allCount">0</strong><span>全部账号</span></div><div class="stat"><strong id="activeCount">0</strong><span>可登录</span></div><div class="stat"><strong id="smsCount">0</strong><span>已绑定手机</span></div><div class="stat"><strong id="itCount">0</strong><span>IT 报修接收人</span></div></div><div class="toolbar"><input id="searchInput" class="search" placeholder="搜索姓名、账号、手机号、部门、标签"></div><div class="table-wrap"><table class="accounts"><thead><tr><th>账号</th><th>角色 / 部门</th><th>标签</th><th>权限</th><th>状态</th><th></th></tr></thead><tbody id="accountRows"></tbody></table></div><div id="pageError" class="error hidden" role="alert"></div></section>
</main>
<div id="drawerWrap" class="drawer-backdrop hidden"><form id="accountForm" class="drawer"><div class="drawer-head"><div><div class="eyebrow">IDENTITY DETAIL</div><h2 id="drawerTitle">新增账号</h2></div><button id="closeDrawer" class="close" type="button" aria-label="关闭">×</button></div><input id="accountId" type="hidden"><div class="form-grid"><div class="field"><label for="editUsername">用户名</label><input id="editUsername" required></div><div class="field"><label for="editName">姓名</label><input id="editName" required></div><div class="field wide"><label for="editPhone">手机号码（短信验证码登录）</label><input id="editPhone" inputmode="tel" placeholder="13800138000"></div><div class="field"><label for="editRole">角色</label><input id="editRole"></div><div class="field"><label for="editDepartment">部门</label><input id="editDepartment"></div><div class="field wide"><label for="editTags">标签（用逗号分隔）</label><input id="editTags" placeholder="普通员工, IT, 报修"></div><div class="field wide"><label for="editPassword">密码</label><input id="editPassword" type="password" minlength="8" autocomplete="new-password"><small id="passwordHint" class="sub">至少 8 位</small></div><div class="field"><label for="editStatus">状态</label><select id="editStatus"><option value="active">可登录</option><option value="disabled">已停用</option></select></div></div><div class="checkline"><label><input id="editAdmin" type="checkbox"> 管理员权限</label></div><div id="formError" class="error hidden" role="alert"></div><div class="drawer-actions"><button id="cancelEdit" class="secondary" type="button">取消</button><button id="saveAccount" class="primary" type="submit">保存账号</button></div></form></div>
<script>
const KEY='otto.enterprise.admin.session';let token=sessionStorage.getItem(KEY)||'';let currentAdmin=null;let accounts=[];
const $=id=>document.getElementById(id);const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showError(id,message){const el=$(id);el.textContent=message||'';el.classList.toggle('hidden',!message)}
async function api(path,options){const o=options||{};o.headers=Object.assign({'content-type':'application/json'},o.headers||{},token?{authorization:'Bearer '+token}:{});const r=await fetch(path,o);const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('请求失败 '+r.status));return data}
function showLogin(message){$('adminView').classList.add('hidden');$('loginView').classList.remove('hidden');if(message)showError('loginError',message)}
function showAdmin(){showError('loginError','');$('loginView').classList.add('hidden');$('adminView').classList.remove('hidden');$('railUser').textContent=currentAdmin.name+' · '+currentAdmin.username}
function tags(value){return String(value||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean)}
function render(){const q=$('searchInput').value.trim().toLowerCase();const rows=accounts.filter(a=>!q||[a.name,a.username,a.phone,a.role,a.department].concat(a.tags||[]).some(v=>String(v||'').toLowerCase().includes(q)));$('allCount').textContent=String(accounts.length);$('activeCount').textContent=String(accounts.filter(a=>a.status==='active').length);$('smsCount').textContent=String(accounts.filter(a=>a.phone).length);$('itCount').textContent=String(accounts.filter(a=>a.tags.includes('IT')&&a.tags.includes('报修')).length);$('accountRows').innerHTML=rows.length?rows.map(a=>'<tr><td><div class="name">'+esc(a.name)+'</div><div class="sub">@'+esc(a.username)+(a.phone?' · '+esc(a.phone):' · 未绑定手机')+'</div></td><td>'+esc(a.role||'—')+'<div class="sub">'+esc(a.department||'未分配部门')+'</div></td><td>'+((a.tags||[]).map(t=>'<span class="tag">'+esc(t)+'</span>').join('')||'<span class="sub">无标签</span>')+'</td><td>'+(a.isAdmin?'<span class="badge">管理员</span>':'<span class="sub">员工</span>')+'</td><td><span class="badge '+(a.status==='active'?'':'off')+'">'+(a.status==='active'?'可登录':'已停用')+'</span></td><td><button class="edit" data-id="'+esc(a.id)+'">编辑</button></td></tr>').join(''):'<tr><td class="empty" colspan="6">没有匹配账号</td></tr>';document.querySelectorAll('button[data-id]').forEach(b=>b.addEventListener('click',()=>openEditor(accounts.find(a=>a.id===b.dataset.id))))}
async function loadAccounts(){const data=await api('/enterprise/accounts');accounts=data.accounts||[];render()}
function openEditor(a){const editing=!!a;$('drawerTitle').textContent=editing?'编辑账号':'新增账号';$('accountId').value=editing?a.id:'';$('editUsername').value=editing?a.username:'';$('editName').value=editing?a.name:'';$('editPhone').value=editing?(a.phone||'').replace(/^\\+86/,''):'';$('editRole').value=editing?(a.role||''):'';$('editDepartment').value=editing?(a.department||''):'';$('editTags').value=editing?(a.tags||[]).join(', '):'';$('editPassword').value='';$('editPassword').required=!editing;$('passwordHint').textContent=editing?'留空表示不修改密码':'至少 8 位，建议使用大小写字母、数字和符号';$('editStatus').value=editing?a.status:'active';$('editAdmin').checked=editing&&a.isAdmin;showError('formError','');$('drawerWrap').classList.remove('hidden');$('editUsername').focus()}
function closeEditor(){$('drawerWrap').classList.add('hidden')}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();showError('loginError','');$('loginButton').disabled=true;try{const data=await api('/enterprise/auth/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})});if(!data.account||!data.account.isAdmin)throw new Error('该账号没有管理员权限');token=data.token;currentAdmin=data.account;sessionStorage.setItem(KEY,token);$('password').value='';showAdmin();await loadAccounts()}catch(err){token='';sessionStorage.removeItem(KEY);showLogin(err.message)}finally{$('loginButton').disabled=false}});
$('logoutButton').addEventListener('click',async()=>{try{await api('/enterprise/auth/logout',{method:'POST'})}catch{}token='';currentAdmin=null;sessionStorage.removeItem(KEY);showLogin('')});$('searchInput').addEventListener('input',render);$('createButton').addEventListener('click',()=>openEditor(null));$('closeDrawer').addEventListener('click',closeEditor);$('cancelEdit').addEventListener('click',closeEditor);$('drawerWrap').addEventListener('click',e=>{if(e.target===$('drawerWrap'))closeEditor()});
$('accountForm').addEventListener('submit',async e=>{e.preventDefault();showError('formError','');const id=$('accountId').value;const password=$('editPassword').value;const body={username:$('editUsername').value.trim(),name:$('editName').value.trim(),phone:$('editPhone').value.trim()||null,role:$('editRole').value.trim(),department:$('editDepartment').value.trim(),tags:tags($('editTags').value),status:$('editStatus').value,isAdmin:$('editAdmin').checked};if(password)body.password=password;if(!id&&!password){showError('formError','新增账号必须设置密码');return}$('saveAccount').disabled=true;try{await api(id?'/enterprise/accounts/'+encodeURIComponent(id):'/enterprise/accounts',{method:id?'PATCH':'POST',body:JSON.stringify(body)});closeEditor();await loadAccounts()}catch(err){showError('formError',err.message)}finally{$('saveAccount').disabled=false}});
(async()=>{if(!token)return showLogin('');try{const data=await api('/enterprise/auth/me');if(!data.account.isAdmin)throw new Error('该账号没有管理员权限');currentAdmin=data.account;showAdmin();await loadAccounts()}catch{token='';sessionStorage.removeItem(KEY);showLogin('登录已失效，请重新登录')}})();
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
  adminToken: string;
  generatedToken: boolean;
} {
  const host = opts.host || process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1';
  const port = opts.port || parseInt(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT), 10);
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
  const server = createServer(makeHandler(adminToken, smsSender));
  return { server, host, port, adminToken, generatedToken };
}

/** 组装并 listen；返回 http.Server。打印访问地址与（如有）自动生成的 token。 */
export function startEnterpriseServer(opts: EnterpriseServerOptions = {}): Server {
  const { server, host, port, adminToken, generatedToken } = createEnterpriseServer(opts);
  server.listen(port, host, () => {
    const tokenQuery = adminToken ? `?token=${adminToken}` : '';
    console.log(`[Otto Enterprise] 服务端运行于 http://${host}:${port}`);
    console.log(`[Otto Enterprise] 账号管理: http://localhost:${port}/enterprise/admin`);
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
