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
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ENTERPRISE_ADMIN_TOKEN',
  'OTTO_ENTERPRISE_PUBLIC_URL',
] as const;

const ADMIN_TOKEN = 'test-admin-token-abc123';

/** 起一个隔离的企业服务端（临时端口），返回 baseUrl + 关闭句柄。 */
async function startIsolated(
  adminToken?: string,
  smsSender?: { sendVerificationCode(phone: string, code: string): Promise<boolean> },
): Promise<{ base: string; server: Server }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  process.env.OTTO_ENTERPRISE_PUBLIC_URL = 'https://join.otto.example';
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

// 首个用例会动态加载完整企业服务模块；并行全量回归时冷启动可能超过 Vitest
// 默认 5 秒。给隔离服务套件留出确定余量，避免把模块编译争用误报成鉴权失败。
describe('管理端鉴权：受保护路由需正确 token', { timeout: 15_000 }, () => {
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

  it('企业知识库无登录会话不可读取', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/knowledge`);
    expect(res.status).toBe(401);
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

describe('公网企业引入链接与公开落地页', () => {
  it('API 返回配置的公网链接，绝不采用 Host 或 X-Forwarded-Host', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const response = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: {
        'x-otto-admin-token': ADMIN_TOKEN,
        host: 'evil.example',
        'x-forwarded-host': 'also-evil.example',
      },
    });

    expect(response.status).toBe(201);
    const { invite } = await response.json();
    expect(invite.link).toBe(`https://join.otto.example/enterprise/join/${invite.code}`);
    expect(invite.link).not.toContain('evil.example');
  });

  it('进程选项可覆盖环境公网基址，便于不同部署使用自己的 HTTPS 地址', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    process.env.OTTO_ENTERPRISE_PUBLIC_URL = 'https://from-env.otto.example';
    vi.resetModules();
    const mod: ServerModule = await import('./server.js');
    const created = mod.createEnterpriseServer({
      host: '127.0.0.1',
      publicUrl: 'https://from-option.otto.example/company/',
      adminToken: ADMIN_TOKEN,
      smsSender: null,
    });

    expect(created.publicBaseUrl).toBe('https://from-option.otto.example/company');
  });

  it('有效链接返回干净落地页、App 唤起按钮、邀请码与严格安全头，不泄露企业名称', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
    const secretName = '机密企业 <script>alert(1)</script>';
    const organization = db.createOrganization({ name: secretName, slug: 'private-company' });
    const invite = db.issueOrganizationInvite(organization.id);

    const response = await fetch(`${base}/enterprise/join/${invite.code}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8$/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');

    const html = await response.text();
    expect(html).toContain('打开 Otto');
    expect(html).toContain('如果按钮没有反应');
    expect(html).toContain(invite.code);
    expect(html).toContain(`otto://enterprise/join?invite=${invite.code}`);
    expect(html).not.toContain(secretName);
    expect(html).not.toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('不存在或格式恶意的邀请码返回 404，且不会反射未转义输入', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const missing = await fetch(`${base}/enterprise/join/AAAA-2222`);
    expect(missing.status).toBe(404);

    const injected = await fetch(
      `${base}/enterprise/join/%3Cscript%3Ealert(1)%3C%2Fscript%3E`,
    );
    expect(injected.status).toBe(404);
    expect(await injected.text()).not.toContain('<script>alert(1)</script>');
  });

  it('过期与换新后撤销的链接均返回 410，不再提供 App 唤起入口', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
    const organization = db.createOrganization({ name: '时效测试企业', slug: 'expiry-test' });

    const expired = db.issueOrganizationInvite(
      organization.id,
      Date.now() - db.ORGANIZATION_INVITE_VALIDITY_MS - 1_000,
    );
    const expiredResponse = await fetch(`${base}/enterprise/join/${expired.code}`);
    expect(expiredResponse.status).toBe(410);
    expect(await expiredResponse.text()).not.toContain('otto://enterprise/join');

    const revoked = db.issueOrganizationInvite(organization.id);
    db.issueOrganizationInvite(organization.id);
    const revokedResponse = await fetch(`${base}/enterprise/join/${revoked.code}`);
    expect(revokedResponse.status).toBe(410);
    expect(await revokedResponse.text()).not.toContain('otto://enterprise/join');
  });
});

describe('report/dashboard 路由基本可达', () => {
  it('admin 网页无需静态 token 即可打开，并提供管理员账号登录与完整账号编辑入口', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const favicon = await fetch(`${base}/favicon.ico`);
    expect(favicon.status).toBe(204);
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
    expect(html).toContain('账户模板');
    expect(html).toContain('预设标签');
    expect(html).toContain('class="summary-strip"');
    expect(html).toContain('data-account-template="it"');
    expect(html).toContain('data-tag-preset');
    expect(html).toContain('departmentPresetList');
    expect(html).toContain('departmentPresets');
    expect(html).toContain('tagPresets');
    expect(html).toContain('普通成员');
    expect(html).toContain('IT 支持');
    expect(html).toContain('logoutModal');
    expect(html).toContain('确认退出管理员后台');
    expect(html).toContain('企业成员引入链接');
    expect(html).toContain('精确有效 5 小时');
    expect(html).toContain('/enterprise/organization/invite');
    expect(html).toContain('currentInvite.link');
    expect(html).not.toContain("server:location.origin");
    expect(html).toContain('复制企业引入链接');
    expect(html).toContain('复制邀请码');
    expect(html).toContain('/enterprise/usage/summary?period=30');
    expect(html).toContain('近 30 天 Token');
    expect(html).toContain('inviteModal');
    expect(html).toContain('生成新的企业引入链接？');
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
    db.createAccount({
      employeeId: 'e1', username: 'reporter', password: 'reporter-password', name: '张三',
    });
    const login = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'reporter', password: 'reporter-password' }),
    });
    const sessionToken = (await login.json()).token;
    await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ employee_id: 'e1', task_type: 't1', duration_min: 60, cost_cny: 0 }),
    });
    await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({ employee_id: 'e1', task_type: 't2', duration_min: 60, cost_cny: 0.03 }),
    });
    const r = await (await fetch(`${base}/enterprise/report?token=${ADMIN_TOKEN}`)).json();
    expect(r.totalTasks).toBe(2);
    // 关键：绝不再出现天文数字，封顶 ≤ 50。
    expect(r.laborPerTokenCNY).toBeLessThanOrEqual(50);
    expect(Number.isFinite(r.laborPerTokenCNY)).toBe(true);
  });

  it('POST /enterprise/task 无登录先返回 401', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'e1' }), // 缺 task_type
    });
    expect(res.status).toBe(401);
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

  it('短信验证码只用于首次注册，注册时保存姓名和密码，之后用手机号密码登录', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    vi.resetModules();
    const db = await import('./db.js');
    const defaultInvite = db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID).code;
    db.createAccount({
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

    const existing = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '138 0013 8000', inviteCode: defaultInvite }),
    });
    expect(existing.status).toBe(409);
    expect(await existing.json()).toEqual({ error: '该手机号已注册，请直接登录' });
    expect(sent).toHaveLength(0);

    const request = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13700137000', inviteCode: defaultInvite }),
    });
    expect(request.status).toBe(200);
    const registrationChallenge = await request.json();
    expect(registrationChallenge).toMatchObject({
      challengeId: expect.stringMatching(/^smsreg_/),
      message: '验证码已发送，5 分钟内有效',
      organization: { id: db.DEFAULT_ORGANIZATION_ID, name: '默认企业' },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.phone).toBe('13700137000');

    const incomplete = await fetch(`${base}/enterprise/auth/register/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: registrationChallenge.challengeId, code: sent[0]?.code }),
    });
    expect(incomplete.status).toBe(400);

    const register = await fetch(`${base}/enterprise/auth/register/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: registrationChallenge.challengeId,
        code: sent[0]?.code,
        name: '王小明',
        password: 'registered-password-1',
      }),
    });
    expect(register.status).toBe(200);
    const registered = await register.json();
    expect(registered.account).toMatchObject({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      organizationName: '默认企业',
      phone: '+8613700137000',
      name: '王小明',
      role: '成员',
      isAdmin: false,
      status: 'active',
      tags: ['普通成员'],
    });
    expect(registered.token).toEqual(expect.any(String));

    const adminDenied = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(adminDenied.status).toBe(403);

    const login = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: '137 0013 7000', password: 'registered-password-1' }),
    });
    expect(login.status).toBe(200);
    const loggedIn = await login.json();
    expect(loggedIn.account.id).toBe(registered.account.id);
    expect(loggedIn.token).toEqual(expect.any(String));

    const deprecatedSmsLogin = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13700137000' }),
    });
    expect(deprecatedSmsLogin.status).toBe(410);
    expect(await deprecatedSmsLogin.json()).toEqual({ error: '短信验证码仅用于首次注册，请使用密码登录' });
  });

  it('短信服务未配置时注册入口返回 503', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'sms02', password: 'sms-password-2', name: '短信用户二',
    });
    const unavailable = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900139000' }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: '短信注册暂不可用，请稍后重试' });
  });

  it('注册短信发送失败会释放挑战，用户可立刻重试而不会被冷却时间误伤', async () => {
    process.env.OTTO_ENTERPRISE_DIR = tmpDir;
    vi.resetModules();
    const db = await import('./db.js');
    const defaultInvite = db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID).code;
    let succeeds = false;
    const sender = {
      async sendVerificationCode(): Promise<boolean> { return succeeds; },
    };
    const { base } = await startIsolated(ADMIN_TOKEN, sender);

    const first = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13600136000', inviteCode: defaultInvite }),
    });
    expect(first.status).toBe(502);

    succeeds = true;
    const second = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13600136000', inviteCode: defaultInvite }),
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

describe('B2B 企业隔离、邀请码与 Token 用量 API', () => {
  async function login(base: string, identifier: string, password: string): Promise<string> {
    const response = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    expect(response.status).toBe(200);
    return (await response.json()).token;
  }

  it('邀请码只允许在 5 小时窗口内申请短信，注册账号固定加入邀请码所属企业', async () => {
    const sent: Array<{ phone: string; code: string }> = [];
    const { base } = await startIsolated(ADMIN_TOKEN, {
      async sendVerificationCode(phone, code) {
        sent.push({ phone, code });
        return true;
      },
    });
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const invite = db.issueOrganizationInvite(alpha.id);

    const invalid = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', inviteCode: 'AAAA-BBBB' }),
    });
    expect(invalid.status).toBe(403);
    expect(sent).toHaveLength(0);

    const request = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000', inviteCode: invite.code }),
    });
    expect(request.status).toBe(200);
    const challenge = await request.json();
    expect(challenge.organization).toEqual({ id: alpha.id, name: 'Alpha 科技' });

    const register = await fetch(`${base}/enterprise/auth/register/sms/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        code: sent[0]?.code,
        name: 'Alpha 新员工',
        password: 'alpha-member-password',
      }),
    });
    expect(register.status).toBe(200);
    expect((await register.json()).account).toMatchObject({
      organizationId: alpha.id,
      organizationName: 'Alpha 科技',
      name: 'Alpha 新员工',
    });
  });

  it('企业管理员只能查看和修改本企业账号，并可在后台手动生成新的 5 小时邀请码', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    const alphaAdmin = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.admin', password: 'alpha-admin-password', name: 'Alpha 管理员', isAdmin: true,
    });
    const alphaStaff = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.staff', password: 'alpha-staff-password', name: 'Alpha 员工',
    });
    const betaAdmin = db.createAccount({
      organizationId: beta.id,
      username: 'beta.admin', password: 'beta-admin-password', name: 'Beta 管理员', isAdmin: true,
    });
    const betaStaff = db.createAccount({
      organizationId: beta.id,
      username: 'beta.staff', password: 'beta-staff-password', name: 'Beta 员工',
    });
    const alphaToken = await login(base, alphaAdmin.username, 'alpha-admin-password');
    const betaToken = await login(base, betaAdmin.username, 'beta-admin-password');
    const alphaStaffToken = await login(base, alphaStaff.username, 'alpha-staff-password');

    const alphaAccounts = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const betaAccounts = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${betaToken}` },
    });
    expect((await alphaAccounts.json()).accounts.map((account: any) => account.id).sort())
      .toEqual([alphaAdmin.id, alphaStaff.id].sort());
    expect((await betaAccounts.json()).accounts.map((account: any) => account.id).sort())
      .toEqual([betaAdmin.id, betaStaff.id].sort());

    const crossTenantPatch = await fetch(`${base}/enterprise/accounts/${betaStaff.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '不应成功' }),
    });
    expect(crossTenantPatch.status).toBe(404);
    expect(db.getAccount(betaStaff.id)?.name).toBe('Beta 员工');

    const memberInvite = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaStaffToken}` },
    });
    expect(memberInvite.status).toBe(403);

    const first = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(first.status).toBe(201);
    const firstInvite = (await first.json()).invite;
    expect(firstInvite).toMatchObject({
      status: 'active',
      validHours: 5,
      link: `https://join.otto.example/enterprise/join/${firstInvite.code}`,
    });

    const second = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const secondInvite = (await second.json()).invite;
    expect(secondInvite.code).not.toBe(firstInvite.code);
    expect(db.resolveOrganizationInvite(firstInvite.code)).toBeNull();
    expect(db.resolveOrganizationInvite(secondInvite.code)?.id).toBe(alpha.id);

    const current = await fetch(`${base}/enterprise/organization/invite`, {
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect((await current.json())).toMatchObject({
      organization: { id: alpha.id, name: 'Alpha 科技' },
      invite: { code: secondInvite.code, status: 'active' },
    });
  });

  it('模型返回的 Token 用量按登录账号归属，重复消息幂等且企业管理员看不到别家数据', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    const alphaAdmin = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.admin', password: 'alpha-admin-password', name: 'Alpha 管理员', isAdmin: true,
    });
    const alphaStaff = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.staff', password: 'alpha-staff-password', name: 'Alpha 员工',
    });
    const betaStaff = db.createAccount({
      organizationId: beta.id,
      username: 'beta.staff', password: 'beta-staff-password', name: 'Beta 员工',
    });
    const adminToken = await login(base, alphaAdmin.username, 'alpha-admin-password');
    const alphaToken = await login(base, alphaStaff.username, 'alpha-staff-password');
    const betaToken = await login(base, betaStaff.username, 'beta-staff-password');

    const usage = {
      sessionId: 'chat-alpha', messageId: 'message-alpha-1', model: 'gpt-5.5',
      inputTokens: 120, outputTokens: 30, totalTokens: 150,
    };
    const recorded = await fetch(`${base}/enterprise/usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(usage),
    });
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toEqual({ recorded: true, source: 'client_reported' });
    const duplicate = await fetch(`${base}/enterprise/usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(usage),
    });
    expect(await duplicate.json()).toEqual({ recorded: false, source: 'client_reported' });

    await fetch(`${base}/enterprise/usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${betaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'chat-beta', messageId: 'message-beta-1', model: 'gpt-5.5',
        inputTokens: 900, outputTokens: 100, totalTokens: 1_000,
      }),
    });

    const summaryResponse = await fetch(`${base}/enterprise/usage/summary?period=30`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json();
    expect(summary).toMatchObject({
      organizationId: alpha.id,
      totalTokens: 150,
      requestCount: 1,
      source: 'client_reported',
    });
    expect(JSON.stringify(summary)).not.toContain(betaStaff.id);

    const accountsResponse = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const accounts = (await accountsResponse.json()).accounts;
    expect(accounts.find((account: any) => account.id === alphaStaff.id).usage)
      .toMatchObject({ totalTokens: 150, requestCount: 1 });
  });

  it('成员任务与知识接口必须登录且不能用其他企业的员工 ID', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    db.createEmployee({ id: 'alpha-worker', organizationId: alpha.id, name: 'Alpha 员工' });
    db.createEmployee({ id: 'beta-worker', organizationId: beta.id, name: 'Beta 员工' });
    const alphaAccount = db.createAccount({
      organizationId: alpha.id,
      employeeId: 'alpha-worker',
      username: 'alpha.worker', password: 'alpha-worker-password', name: 'Alpha 员工',
    });
    db.addKnowledge({ organizationId: alpha.id, category: 'alpha', content: 'Alpha 知识' });
    db.addKnowledge({ organizationId: beta.id, category: 'beta', content: 'Beta 知识' });
    const alphaToken = await login(base, alphaAccount.username, 'alpha-worker-password');

    const crossTenant = await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'beta-worker', task_type: 'forbidden' }),
    });
    expect(crossTenant.status).toBe(404);

    const ownTask = await fetch(`${base}/enterprise/task`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ employee_id: 'alpha-worker', task_type: 'allowed' }),
    });
    expect(ownTask.status).toBe(200);
    expect(db.getReport(30, undefined, alpha.id).totalTasks).toBe(1);
    expect(db.getReport(30, undefined, beta.id).totalTasks).toBe(0);

    const knowledge = await fetch(`${base}/enterprise/knowledge`, {
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    expect(JSON.stringify(await knowledge.json())).toContain('Alpha 知识');
    expect(JSON.stringify(db.getKnowledge(undefined, undefined, alpha.id))).not.toContain('Beta 知识');
  });

  it('平台令牌可创建新企业及首位管理员，企业管理员不能创建其他企业', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const provision = await fetch(`${base}/enterprise/organizations`, {
      method: 'POST',
      headers: { 'x-otto-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gamma 商贸',
        slug: 'gamma',
        admin: {
          username: 'gamma.owner',
          password: 'gamma-owner-password',
          name: 'Gamma 管理员',
        },
      }),
    });
    expect(provision.status).toBe(201);
    const created = await provision.json();
    expect(created).toMatchObject({
      organization: { name: 'Gamma 商贸', slug: 'gamma' },
      admin: { organizationId: expect.any(String), username: 'gamma.owner', isAdmin: true },
      invite: { status: 'active', validHours: 5 },
    });

    const ownerToken = await login(base, 'gamma.owner', 'gamma-owner-password');
    const denied = await fetch(`${base}/enterprise/organizations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '越权企业', slug: 'forbidden' }),
    });
    expect(denied.status).toBe(403);
  });
});
