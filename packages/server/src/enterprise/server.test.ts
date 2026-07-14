/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业服务端 HTTP 层单测：管理端鉴权 + 路由边界。
 * 数据安全：独立临时 OTTO_ENTERPRISE_DIR + resetModules，绝不碰真实企业库。
 * 端口用 listen(0) 让系统分配临时端口，跑完关服，不占固定 7777。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ServerModule = typeof import('./server.js');

let tmpDir: string;
let servers: Server[] = [];
const prevEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['OTTO_ENTERPRISE_DIR', 'OTTO_ENTERPRISE_ADMIN_TOKEN'] as const;

const ADMIN_TOKEN = 'test-admin-token-abc123';

/** 起一个隔离的企业服务端（临时端口），返回 baseUrl + 关闭句柄。 */
async function startIsolated(
  adminToken?: string,
  smsSender?: { sendVerificationCode(phone: string, code: string): Promise<boolean> },
): Promise<{ base: string; server: Server }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  vi.resetModules();
  const mod: ServerModule = await import('./server.js');
  const { server } = mod.createEnterpriseServer({ host: '127.0.0.1', adminToken, smsSender });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ent-srv-'));
  servers = [];
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('管理端鉴权：受保护路由需正确 token', () => {
  it('带错 token 访问 /enterprise/report → 401', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/report?token=wrong-token-xxxxxxxxxxx`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });

  it('完全不带 token 访问受保护路由 → 401', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    for (const p of ['/enterprise/report', '/enterprise/employees', '/enterprise/audit', '/enterprise/export', '/enterprise/dashboard']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, `${p} 应 401`).toBe(401);
    }
  });

  it('带正确 token（query）→ 放行 200，返回 report', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/report?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('totalTasks');
    expect(body).toHaveProperty('laborPerTokenCNY');
  });

  it('带正确 token（x-otto-admin-token header）→ 放行 200', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/employees`, {
      headers: { 'x-otto-admin-token': ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('employees');
  });

  it('带正确 token（Bearer）→ 放行 200', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/audit`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('logs');
  });
});

describe('tokensMatch 长度不等短路（不抛，稳定返回 401）', () => {
  it('错误 token 长度远短于真 token → 不抛异常，返回 401', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    // 长度不等：timingSafeEqual 会抛，tokensMatch 必须先短路。若未短路则会 500。
    const res = await fetch(`${base}/enterprise/report?token=x`);
    expect(res.status).toBe(401); // 不是 500 → 证明短路生效
  });

  it('错误 token 长度远长于真 token → 同样 401 不 500', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const longWrong = 'z'.repeat(200);
    const res = await fetch(`${base}/enterprise/report?token=${longWrong}`);
    expect(res.status).toBe(401);
  });

  it('等长但不同的 token → 401（timingSafeEqual 正常比对失败）', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const sameLenWrong = 'y'.repeat(ADMIN_TOKEN.length);
    expect(sameLenWrong.length).toBe(ADMIN_TOKEN.length);
    const res = await fetch(`${base}/enterprise/report?token=${sameLenWrong}`);
    expect(res.status).toBe(401);
  });
});

describe('受保护 vs 公开路由边界', () => {
  it('公开路由 /enterprise/health 无 token 也可达 200', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('公开路由 /enterprise/knowledge (GET) 无 token 可达 200', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/knowledge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('knowledge');
  });

  it('未配置 token 时（本机模式）受保护路由不鉴权、直接可达', async () => {
    // adminToken 为空 → 鉴权中间件跳过（仅本机场景）。
    const { base } = await startIsolated(''); // 显式空 token
    const res = await fetch(`${base}/enterprise/report`);
    expect(res.status).toBe(200);
  });

  it('未知路由 → 404', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/nope`);
    expect(res.status).toBe(404);
  });

  it('OPTIONS 预检 → 204', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/report`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });
});

describe('report/dashboard 路由基本可达', () => {
  it('admin 网页无需静态 token 即可打开，并提供管理员账号登录与完整账号编辑入口', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");

    const html = await res.text();
    expect(html).toContain('管理员登录');
    expect(html).toContain('用户名');
    expect(html).toContain('type="password"');
    expect(html).toContain('/enterprise/auth/login');
    expect(html).toContain('/enterprise/accounts');
    expect(html).toContain('editPhone');
    expect(html).toContain('sessionStorage');
    expect(html).not.toContain(ADMIN_TOKEN);
  });

  it('dashboard（带 token）返回 HTML 且含估算披露文案', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/dashboard?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('Otto Enterprise');
    expect(html).toContain('估算');
  });

  it('report 端到端：logTask 后 laborPerToken 不爆表（cost=0 场景经服务端也被兜底）', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    vi.resetModules();
    const db = await import('./db.js');
    const { base } = await startIsolated(ADMIN_TOKEN);
    // 造一个 seed 员工 + 通过 HTTP /task 上报（其中一条显式 cost_cny:0）。
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'e1', task_type: 't1', duration_min: 60, cost_cny: 0 }),
    });
    await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'e1', task_type: 't2', duration_min: 60, cost_cny: 0.03 }),
    });
    const r = await (await fetch(`${base}/enterprise/report?token=${ADMIN_TOKEN}`)).json();
    expect(r.totalTasks).toBe(2);
    // 关键：绝不再出现天文数字，封顶 ≤ 50。
    expect(r.laborPerTokenCNY).toBeLessThanOrEqual(50);
    expect(Number.isFinite(r.laborPerTokenCNY)).toBe(true);
  });

  it('POST /enterprise/task 缺字段 → 400（公开路由，参数校验）', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'e1' }), // 缺 task_type
    });
    expect(res.status).toBe(400);
  });
});

describe('预设账号登录、管理与标签工单投递 API', () => {
  async function seedAccount(
    adminToken: string,
    input: {
      username: string;
      password: string;
      name: string;
      tags?: string[];
      isAdmin?: boolean;
    },
  ): Promise<{ base: string; account: any }> {
    const { base } = await startIsolated(adminToken);
    const db = await import('./db.js');
    return { base, account: db.createAccount(input) };
  }

  it('无需邮箱：预设账号密码正确即可登录，并可用会话读取本人信息和注销', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'staff01',
      password: 'staff-password',
      name: '普通员工',
      tags: ['普通员工'],
    });

    const login = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'staff01', password: 'staff-password' }),
    });
    expect(login.status).toBe(200);
    const loginBody = await login.json();
    expect(loginBody.account.tags).toEqual(['普通员工']);
    expect(loginBody.token).toEqual(expect.any(String));
    expect(loginBody.account).not.toHaveProperty('password_hash');

    const me = await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).account.username).toBe('staff01');

    const logout = await fetch(`${base}/enterprise/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    expect(logout.status).toBe(200);
    expect((await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${loginBody.token}` },
    })).status).toBe(401);
  });

  it('账号不存在和密码错误都返回同一 401，不泄露预设账号清单', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'staff01', password: 'staff-password', name: '普通员工',
    });
    for (const body of [
      { username: 'staff01', password: 'wrong-password' },
      { username: 'missing', password: 'staff-password' },
    ]) {
      const res = await fetch(`${base}/enterprise/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: '账号或密码错误' });
    }
  });

  it('短信验证码请求不泄露手机号是否存在，正确验证码可换取登录会话', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    vi.resetModules();
    const db = await import('./db.js');
    const account = db.createAccount({
      username: 'sms01', password: 'sms-password-1', name: '短信用户', phone: '13800138000',
    });
    const sent: Array<{ phone: string; code: string }> = [];
    const sender = {
      async sendVerificationCode(phone: string, code: string): Promise<boolean> {
        sent.push({ phone, code });
        return true;
      },
    };
    const { base } = await startIsolated(ADMIN_TOKEN, sender);

    const request = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '138 0013 8000' }),
    });
    expect(request.status).toBe(200);
    const requested = await request.json();
    expect(requested.challengeId).toEqual(expect.any(String));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.phone).toBe('13800138000');

    const missing = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13700137000' }),
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ message: requested.message });
    expect(sent).toHaveLength(1);

    const verify = await fetch(`${base}/enterprise/auth/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: requested.challengeId, code: sent[0]?.code }),
    });
    expect(verify.status).toBe(200);
    const verified = await verify.json();
    expect(verified.account.id).toBe(account.id);
    expect(verified.token).toEqual(expect.any(String));
  });

  it('短信服务未配置时统一返回 503，验证码错误不会创建会话', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'sms02', password: 'sms-password-2', name: '短信用户二',
    });
    const unavailable = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900139000' }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: '短信登录暂不可用，请使用账号密码登录' });
  });

  it('短信供应商发送失败会释放挑战，用户可立刻重试而不会被冷却时间误伤', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    vi.resetModules();
    const db = await import('./db.js');
    db.createAccount({
      username: 'sms-retry', password: 'sms-retry-password', name: '重试用户', phone: '13600136000',
    });
    let succeeds = false;
    const sender = {
      async sendVerificationCode(): Promise<boolean> { return succeeds; },
    };
    const { base } = await startIsolated(ADMIN_TOKEN, sender);

    const first = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13600136000' }),
    });
    expect(first.status).toBe(502);

    succeeds = true;
    const second = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13600136000' }),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toHaveProperty('challengeId');
  });

  it('管理员会话可查看、新增、修改全部账号；普通账号不可访问', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'admin', password: 'admin-password', name: '管理员', isAdmin: true,
    });
    const db = await import('./db.js');
    db.createAccount({ username: 'staff', password: 'staff-password', name: '员工' });

    async function login(username: string, password: string): Promise<string> {
      const res = await fetch(`${base}/enterprise/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return (await res.json()).token;
    }
    const adminSession = await login('admin', 'admin-password');
    const staffSession = await login('staff', 'staff-password');
    expect((await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${staffSession}` },
    })).status).toBe(403);

    const created = await fetch(`${base}/enterprise/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSession}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'it01', password: 'it-password-1', name: 'IT 一号',
        role: '桌面支持', department: 'IT', tags: ['IT', '报修'],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.account.tags).toEqual(['IT', '报修']);

    const updated = await fetch(`${base}/enterprise/accounts/${createdBody.account.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${adminSession}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'IT 值班', tags: ['IT', '报修', '夜班'] }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).account.tags).toEqual(['IT', '夜班', '报修']);

    const list = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${adminSession}` },
    });
    expect(list.status).toBe(200);
    expect((await list.json()).accounts).toHaveLength(3);
  });

  it('新增或编辑账号时重复绑定手机号 → 409，不把数据约束错误暴露成 500', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'admin', password: 'admin-password', name: '管理员', isAdmin: true,
    });
    const db = await import('./db.js');
    const first = db.createAccount({
      username: 'first', password: 'first-password', name: '一号', phone: '13800138000',
    });
    const second = db.createAccount({
      username: 'second', password: 'second-password', name: '二号', phone: '13900139000',
    });
    const login = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
    });
    const token = (await login.json()).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const create = await fetch(`${base}/enterprise/accounts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        username: 'third', password: 'third-password', name: '三号', phone: '13800138000',
      }),
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toEqual({ error: '手机号已绑定其他账号' });

    const update = await fetch(`${base}/enterprise/accounts/${second.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ phone: '+86 138 0013 8000' }),
    });
    expect(update.status).toBe(409);
    expect(await update.json()).toEqual({ error: '手机号已绑定其他账号' });
    expect(db.getAccount(first.id)?.phone).toBe('+8613800138000');
    expect(db.getAccount(second.id)?.phone).toBe('+8613900139000');
  });

  it('提交 IT 报修后，只有对应标签账号能在收件箱真实收到工单', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'staff', password: 'staff-password', name: '员工', tags: ['普通员工'],
    });
    const db = await import('./db.js');
    db.createAccount({
      username: 'it01', password: 'it-password-1', name: 'IT 一号', tags: ['IT', '报修'],
    });
    db.createAccount({
      username: 'it02', password: 'it-password-2', name: 'IT 二号', tags: ['IT'],
    });

    async function login(username: string, password: string): Promise<string> {
      const res = await fetch(`${base}/enterprise/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      return (await res.json()).token;
    }
    const staffToken = await login('staff', 'staff-password');
    const itOneToken = await login('it01', 'it-password-1');
    const itTwoToken = await login('it02', 'it-password-2');

    const submitted = await fetch(`${base}/enterprise/tickets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '电脑无法联网', description: 'Wi-Fi 一直掉线' }),
    });
    expect(submitted.status).toBe(201);
    expect((await submitted.json()).ticket.recipientCount).toBe(1);

    const inboxOne = await fetch(`${base}/enterprise/tickets/inbox`, {
      headers: { authorization: `Bearer ${itOneToken}` },
    });
    expect((await inboxOne.json()).tickets).toHaveLength(1);
    const inboxTwo = await fetch(`${base}/enterprise/tickets/inbox`, {
      headers: { authorization: `Bearer ${itTwoToken}` },
    });
    expect((await inboxTwo.json()).tickets).toHaveLength(0);
  });
});
