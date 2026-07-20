/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业服务端 HTTP 层单测：管理端鉴权 + 路由边界。
 * 数据安全：独立临时 OTTO_ENTERPRISE_DIR + resetModules，绝不碰真实企业库。
 * 端口用 listen(0) 让系统分配临时端口，跑完关服，不占固定 7777。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ServerModule = typeof import('./server.js');
type DatabaseModule = typeof import('./db.js');
type AccountView = ReturnType<DatabaseModule['createAccount']>;

let tmpDir: string;
let servers: Server[] = [];
let closeDatabases: Array<() => void> = [];
const prevEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ENTERPRISE_ADMIN_TOKEN',
  'OTTO_ENTERPRISE_PUBLIC_URL',
  'OTTO_ENTERPRISE_HOST',
  'OTTO_ENTERPRISE_PORT',
  'OTTO_APP_VERSION',
  'OTTO_BUILD_COMMIT',
  'GITHUB_SHA',
  'OTTO_ENTERPRISE_TRUST_PROXY_HOPS',
  'OTTO_ENTERPRISE_TRUSTED_PROXIES',
  'ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID',
  'OTTO_ENTERPRISE_FEISHU_APP_ID',
  'OTTO_ENTERPRISE_FEISHU_APP_SECRET',
  'OTTO_ENTERPRISE_FEISHU_DOMAIN',
] as const;

const ADMIN_TOKEN = 'test-admin-token-abc123';

/** 起一个隔离的企业服务端（临时端口），返回 baseUrl + 关闭句柄。 */
async function startIsolated(
  adminToken?: string,
  smsSender?: { sendVerificationCode(phone: string, code: string): Promise<boolean> } | null,
  serverOptions: Record<string, unknown> = {},
): Promise<{ base: string; server: Server }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  process.env.OTTO_ENTERPRISE_PUBLIC_URL = 'https://join.otto.example';
  vi.resetModules();
  const mod: ServerModule = await import('./server.js');
  const database: DatabaseModule = await import('./db.js');
  closeDatabases.push(database.closeEnterpriseDatabase);
  const { server } = mod.createEnterpriseServer({
    host: '127.0.0.1',
    adminToken,
    smsSender,
    repairSmsSender: null,
    repairFeishuSender: null,
    ...serverOptions,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ent-srv-'));
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  servers = [];
  closeDatabases = [];
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  for (const closeDatabase of closeDatabases.reverse()) closeDatabase();
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

// The first isolated server cold-loads the enterprise module graph. Under the
// full workspace suite that transform can exceed 15s even though each request
// still returns immediately, so keep the assertions strict but allow CI startup.
describe('本地 Agent 配对路由默认关闭', { timeout: 30_000 }, () => {
  it('默认对 SDK、检测页、令牌生成与验证统一返回 404', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const requests: Array<[string, RequestInit | undefined]> = [
      ['/enterprise/sdk/otto-discovery.js', undefined],
      ['/enterprise/local-agent', undefined],
      ['/enterprise/local-agent/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: 'test-instance' }),
      }],
      ['/enterprise/local-agent/pair/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'ABCDEF' }),
      }],
    ];

    for (const [route, init] of requests) {
      const res = await fetch(`${base}${route}`, init);
      await res.arrayBuffer();
      expect(res.status, `${route} 应默认隐藏`).toBe(404);
    }
  });

  it('只有显式启用时才保留 SDK、检测页与一次性令牌验证链路', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      localAgentPairingEnabled: true,
    });

    const sdk = await fetch(`${base}/enterprise/sdk/otto-discovery.js`);
    expect(sdk.status).toBe(200);
    expect(sdk.headers.get('content-type')).toContain('application/javascript');

    const page = await fetch(`${base}/enterprise/local-agent`);
    expect(page.status).toBe(200);

    const pair = await fetch(`${base}/enterprise/local-agent/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: 'test-instance' }),
    });
    expect(pair.status).toBe(200);
    const pairBody = await pair.json() as {
      data: { token: string };
    };

    const verify = await fetch(`${base}/enterprise/local-agent/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairBody.data.token }),
    });
    expect(verify.status).toBe(200);
    await expect(verify.json()).resolves.toMatchObject({
      ok: true,
      data: {
        verified: true,
        instanceId: 'test-instance',
      },
    });
  });
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
    for (const p of ['/enterprise/report', '/enterprise/employees', '/enterprise/audit', '/enterprise/export']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, `${p} 应 401`).toBe(401);
    }
  });

  it('即使 query 带正确 token 也拒绝，避免令牌进入 URL、代理日志与浏览器历史', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/report?token=${ADMIN_TOKEN}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty('error');
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

  it('鉴权阶段数据库异常由 handler 收口为不泄露内部细节的 500', async () => {
    const { server } = await startIsolated(ADMIN_TOKEN);
    const database = await import('./db.js');
    database.getDB().close();
    // 上面故意关闭底层连接来模拟鉴权数据库故障；避免 afterEach 对同一连接二次 close。
    closeDatabases = [];

    const listener = server.listeners('request')[0] as (
      req: Record<string, unknown>,
      res: Record<string, unknown>,
    ) => Promise<void>;
    let statusCode = 0;
    let responseBody = '';
    let headersSent = false;
    const response = {
      get headersSent() { return headersSent; },
      setHeader() {},
      writeHead(status: number) {
        statusCode = status;
        headersSent = true;
        return this;
      },
      end(body?: string) {
        responseBody = body || '';
        return this;
      },
      destroy() {
        return this;
      },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(listener({
        url: '/enterprise/report',
        method: 'GET',
        headers: {
          host: '127.0.0.1',
          authorization: 'Bearer invalid-account-session',
        },
      }, response)).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }

    expect(statusCode).toBe(500);
    expect(JSON.parse(responseBody)).toEqual({ error: '企业服务暂时不可用，请稍后重试' });
    expect(responseBody).not.toMatch(/database|sqlite|closed/i);
  });
});

describe('tokensMatch 长度不等短路（不抛，稳定返回 401）', () => {
  it('错误 token 长度远短于真 token → 不抛异常，返回 401', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    // 长度不等：timingSafeEqual 会抛，tokensMatch 必须先短路。若未短路则会 500。
    const res = await fetch(`${base}/enterprise/report`, {
      headers: { 'x-otto-admin-token': 'x' },
    });
    expect(res.status).toBe(401); // 不是 500 → 证明短路生效
  });

  it('错误 token 长度远长于真 token → 同样 401 不 500', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const longWrong = 'z'.repeat(200);
    const res = await fetch(`${base}/enterprise/report`, {
      headers: { 'x-otto-admin-token': longWrong },
    });
    expect(res.status).toBe(401);
  });

  it('等长但不同的 token → 401（timingSafeEqual 正常比对失败）', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const sameLenWrong = 'y'.repeat(ADMIN_TOKEN.length);
    expect(sameLenWrong.length).toBe(ADMIN_TOKEN.length);
    const res = await fetch(`${base}/enterprise/report`, {
      headers: { 'x-otto-admin-token': sameLenWrong },
    });
    expect(res.status).toBe(401);
  });
});

describe('正式公网启动的部署身份安全门', () => {
  it('非 loopback 监听缺少 OTTO_APP_VERSION / 完整 OTTO_BUILD_COMMIT 时同步拒绝启动', async () => {
    process.env.OTTO_ENTERPRISE_PORT = '0';
    delete process.env.OTTO_APP_VERSION;
    delete process.env.OTTO_BUILD_COMMIT;
    delete process.env.GITHUB_SHA;
    vi.resetModules();
    const mod: ServerModule = await import('./server.js');

    let started: Server | null = null;
    let error: unknown;
    try {
      started = mod.startEnterpriseServer({
        host: '0.0.0.0',
        port: 0,
        adminToken: ADMIN_TOKEN,
      });
    } catch (caught) {
      error = caught;
    }
    if (started) servers.push(started);

    expect(String(error)).toContain('OTTO_APP_VERSION');
    expect(String(error)).toContain('OTTO_BUILD_COMMIT');
  });

  it('非 loopback 监听拒绝短 SHA；loopback 开发在无构建标识时仍可启动', async () => {
    process.env.OTTO_ENTERPRISE_PORT = '0';
    process.env.OTTO_APP_VERSION = '1.8.4';
    process.env.OTTO_BUILD_COMMIT = 'abc123';
    vi.resetModules();
    const publicModule: ServerModule = await import('./server.js');
    let publicStarted: Server | null = null;
    let publicError: unknown;
    try {
      publicStarted = publicModule.startEnterpriseServer({
        host: '0.0.0.0',
        port: 0,
        adminToken: ADMIN_TOKEN,
      });
    } catch (caught) {
      publicError = caught;
    }
    if (publicStarted) servers.push(publicStarted);
    expect(String(publicError)).toMatch(/OTTO_BUILD_COMMIT.*40/i);

    delete process.env.OTTO_APP_VERSION;
    delete process.env.OTTO_BUILD_COMMIT;
    vi.resetModules();
    const localModule: ServerModule = await import('./server.js');
    const local = localModule.startEnterpriseServer({ host: '127.0.0.1', port: 0 });
    servers.push(local);
    await new Promise<void>((resolve) => local.once('listening', resolve));
    expect((local.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('非 loopback 监听在版本和完整 40 位 SHA 齐备时可启动', async () => {
    process.env.OTTO_ENTERPRISE_PORT = '0';
    process.env.OTTO_APP_VERSION = '1.8.4';
    process.env.OTTO_BUILD_COMMIT = '0123456789abcdef0123456789abcdef01234567';
    vi.resetModules();
    const mod: ServerModule = await import('./server.js');
    const server = mod.startEnterpriseServer({
      host: '0.0.0.0',
      port: 0,
      adminToken: ADMIN_TOKEN,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('非 loopback 监听接受调用方显式传入的版本和完整提交，不强制依赖进程环境', async () => {
    process.env.OTTO_ENTERPRISE_PORT = '7777';
    delete process.env.OTTO_APP_VERSION;
    delete process.env.OTTO_BUILD_COMMIT;
    delete process.env.GITHUB_SHA;
    vi.resetModules();
    const mod: ServerModule = await import('./server.js');
    const server = mod.startEnterpriseServer({
      host: '0.0.0.0',
      port: 0,
      adminToken: ADMIN_TOKEN,
      appVersion: '1.8.4',
      buildCommit: '0123456789abcdef0123456789abcdef01234567',
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    expect((server.address() as AddressInfo).port).not.toBe(7777);
  });
});

describe('可信反向代理客户端地址解析', () => {
  it('trustedProxyHops=0 或直连来源不可信时忽略 X-Forwarded-For', async () => {
    const mod: ServerModule = await import('./server.js');
    expect(mod.resolveEnterpriseClientAddress(
      '203.0.113.10',
      '198.51.100.23',
      { trustedProxyHops: 0 },
    )).toBe('203.0.113.10');
    expect(mod.resolveEnterpriseClientAddress(
      '203.0.113.10',
      '198.51.100.23',
      { trustedProxyHops: 1, trustedProxyAddresses: ['10.0.0.5'] },
    )).toBe('203.0.113.10');
  });

  it('仅对 loopback 或明确可信直连代理按 trustedProxyHops 取 XFF 客户端', async () => {
    const mod: ServerModule = await import('./server.js');
    expect(mod.resolveEnterpriseClientAddress(
      '::1',
      '198.51.100.23',
      { trustedProxyHops: 1 },
    )).toBe('198.51.100.23');
    expect(mod.resolveEnterpriseClientAddress(
      '10.0.0.5',
      '198.51.100.23, 10.0.0.4',
      { trustedProxyHops: 2, trustedProxyAddresses: ['10.0.0.5'] },
    )).toBe('198.51.100.23');
  });

  it('XFF 格式非法、重复 header 或链长不足时 fail closed 回落直连地址', async () => {
    const mod: ServerModule = await import('./server.js');
    for (const forwarded of [
      'not-an-ip',
      ['198.51.100.23', '198.51.100.24'],
      '198.51.100.23',
    ]) {
      expect(mod.resolveEnterpriseClientAddress(
        '127.0.0.1',
        forwarded,
        { trustedProxyHops: forwarded === '198.51.100.23' ? 2 : 1 },
      )).toBe('127.0.0.1');
    }
  });
});

describe('受保护 vs 公开路由边界', () => {
  it('公开路由 /enterprise/health 无 token 也可达 200', async () => {
    process.env.OTTO_APP_VERSION = '1.8.4-test';
    process.env.OTTO_BUILD_COMMIT = 'abc123def456';
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      db: 'connected',
      service: 'otto-enterprise',
      apiVersion: 3,
      version: '1.8.4-test',
      appVersion: '1.8.4-test',
      buildCommit: 'abc123def456',
      schemaVersion: 3,
      capabilities: [
        'password_auth',
        'sms_login',
        'sms_registration',
        'personal_registration',
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
      ],
    });
    expect(body.uptime).toEqual(expect.any(Number));
  });

  it('企业知识库无登录会话不可读取', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/knowledge`);
    expect(res.status).toBe(401);
  });

  it('未配置静态 token 时，本机管理路由仍必须使用管理员登录会话', async () => {
    const { base } = await startIsolated(''); // 显式空 token
    const database = await import('./db.js');
    database.createAccount({
      username: 'local-admin',
      password: 'local-admin-password',
      name: '本机管理员',
      isAdmin: true,
    });

    expect((await fetch(`${base}/enterprise/report`)).status).toBe(401);

    const login = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-admin', password: 'local-admin-password' }),
    });
    expect(login.status).toBe(200);
    const token = (await login.json()).token;
    expect((await fetch(`${base}/enterprise/report`, {
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(200);
  });

  it('本机模式拒绝第三方网页跨域改写企业邀请码，并只向已登录管理员保留同源能力', async () => {
    const { base } = await startIsolated('');
    const db = await import('./db.js');
    db.createAccount({
      username: 'local-admin',
      password: 'local-admin-password',
      name: '本机管理员',
      isAdmin: true,
    });
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID)).toBeNull();

    const crossOrigin = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID)).toBeNull();

    const port = new URL(base).port;
    const rebindingStatus = await new Promise<number>((resolve, reject) => {
      const target = new URL(`${base}/enterprise/organization/invite`);
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.end();
    });
    expect(rebindingStatus).toBe(403);
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID)).toBeNull();

    const login = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-admin', password: 'local-admin-password' }),
    });
    const token = (await login.json()).token;
    const sameOrigin = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { origin: base, authorization: `Bearer ${token}` },
    });
    expect(sameOrigin.status).toBe(201);
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID)).not.toBeNull();
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
    expect(html).toContain('账号或手机号');
    expect(html).toContain('type="password"');
    expect(html).toContain('id="togglePassword"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('/enterprise/auth/admin/login');
    expect(html).toContain('loadWorkspaceWithFeedback');
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
    expect(html).toContain('精确有效 7 天');
    expect(html).toContain('/enterprise/organization/invite');
    expect(html).toContain('currentInvite.link');
    expect(html).not.toContain("server:location.origin");
    expect(html).toContain('复制企业引入链接');
    expect(html).toContain('复制邀请码');
    expect(html).toContain('/enterprise/usage/summary?period=30');
    expect(html).toContain('近 30 天 Token');
    expect(html).toContain('inviteModal');
    expect(html).toContain('生成新的岗位邀请码？');
    expect(html).toContain('id="organizationTitle" tabindex="-1"');
    expect(html).toContain('id="resultCount" class="result-count" role="status"');
    expect(html).toContain('id="drawerWrap" class="drawer-backdrop hidden" role="dialog"');
    expect(html).toContain('aria-describedby="passwordHint"');
    expect(html).toContain('<th scope="col">账号</th>');
    expect(html).toContain('<span class="sr-only">操作</span>');
    expect(html).toContain('aria-label="编辑');
    expect(html).toContain('aria-pressed="false"><b>普通成员</b>');
    expect(html).toContain('function trapFocus');
    expect(html).toContain('function expireAdminSession');
    expect(html).toContain('href="/enterprise/admin/credits"');
    expect(html).toContain('积分管理');
    expect(html).toContain('id="deleteAccount"');
    expect(html).toContain("method:'DELETE'");
    expect(html).toContain('删除账号');
    expect(html).toContain('href="/enterprise/admin/platform"');
    expect(html).toContain('多企业管理');
    expect(html).not.toContain(ADMIN_TOKEN);
  });

  it('平台管理页通过手动令牌创建并列出多个企业，不在 HTML 中泄露平台令牌', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/admin/platform`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');

    const html = await res.text();
    expect(html).toContain('平台企业管理');
    expect(html).toContain('id="platformToken"');
    expect(html).toContain('id="organizationForm"');
    expect(html).toContain("api('/enterprise/organizations'");
    expect(html).toContain("method:'POST'");
    expect(html).toContain('首位企业管理员');
    expect(html).toContain('全部企业');
    expect(html).toContain('id="organizationNav"');
    expect(html).toContain('id="organizationPanel"');
    expect(html).toContain('企业工作台');
    expect(html).toContain('成员账号');
    expect(html).toContain('部门成员目录');
    expect(html).toContain('/enterprise/platform/organizations/');
    expect(html).toContain('platformRequestEpoch');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('sessionStorage');
    expect(html).not.toContain(ADMIN_TOKEN);
  });

  it('积分管理复用账号后台会话，未登录或会话失效时明确引导返回管理员登录', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/admin/credits`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');

    const html = await res.text();
    expect(html).toContain("const KEY='otto.enterprise.admin.session'");
    expect(html).toContain('sessionStorage.getItem(KEY)');
    expect(html).toContain('sessionStorage.removeItem(KEY)');
    expect(html).not.toContain('otto_admin_token');
    expect(html).toContain('id="authNotice"');
    expect(html).toContain('href="/enterprise/admin"');
    expect(html).toContain('返回管理员登录');
    expect(html).toContain('function requireAdminLogin');
    expect(html).toContain('if(!TOKEN)');
    expect(html).toMatch(/status===401\s*\|\|\s*r\.status===403/);
    expect(html).not.toContain(ADMIN_TOKEN);
  });

  it('积分管理只用 DOM 与 textContent 渲染服务端字段，杜绝存储型 XSS', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const html = await (await fetch(`${base}/enterprise/admin/credits`)).text();

    expect(html).not.toContain('innerHTML');
    expect(html).toContain('document.createElement');
    expect(html).toContain('replaceChildren');
    expect(html).toContain('codeText.textContent=String(code.code');
    expect(html).toContain('statusText.textContent=String(code.status');
    expect(html).toContain('redeemer.textContent=');
    expect(html).toContain('accountCell.textContent=String(row.accountName');
    expect(html).toContain('descriptionCell.textContent=String(row.description');
    expect(html).toContain('encodeURIComponent(id)');
    expect(html).not.toMatch(/\+code\.(?:code|status|redeemedBy|id)\+/);
    expect(html).not.toMatch(/\+row\.(?:accountName|description|type)\+/);
  });

  it('dashboard 公开返回安全页面外壳，令牌只允许从 sessionStorage 或表单输入', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const res = await fetch(`${base}/enterprise/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    expect(html).toContain('Otto Enterprise');
    expect(html).toContain('估算');
    expect(html).toContain("sessionStorage.getItem(KEY)");
    expect(html).toContain('id="dashboardToken"');
    expect(html).toContain("authorization:'Bearer '+TOKEN");
    expect(html).not.toContain(ADMIN_TOKEN);

    const queryToken = await fetch(`${base}/enterprise/dashboard?token=${ADMIN_TOKEN}`);
    expect(queryToken.status).toBe(400);
    expect(queryToken.headers.get('cache-control')).toBe('no-store');
  });

  it('report 端到端：logTask 后 laborPerToken 不爆表（cost=0 场景经服务端也被兜底）', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
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
    const r = await (await fetch(`${base}/enterprise/report`, {
      headers: { 'x-otto-admin-token': ADMIN_TOKEN },
    })).json();
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
  ): Promise<{ base: string; account: AccountView }> {
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

  it('密码登录按 identifier + 客户端地址限流，429 带 Retry-After，且错误文案不枚举账号', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      loginRateLimit: {
        maxFailures: 3,
        windowMs: 60_000,
        blockMs: 60_000,
        maxEntries: 8,
      },
    });
    const db = await import('./db.js');
    db.createAccount({
      username: 'limited-user',
      password: 'limited-password',
      name: '限流用户',
      phone: '13800138000',
    });

    const login = (identifier: string, password: string) => fetch(
      `${base}/enterprise/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      },
    );

    const missing = await login('missing-user', 'wrong-password');
    const wrongPassword = await login('limited-user', 'wrong-password');
    expect(missing.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await missing.json()).toEqual({ error: '账号或密码错误' });
    expect(await wrongPassword.json()).toEqual({ error: '账号或密码错误' });

    expect((await login('limited-user', 'wrong-password')).status).toBe(401);
    const blocked = await login('limited-user', 'wrong-password');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({
      error: '登录尝试过于频繁，请稍后再试',
      retryAfterSeconds: expect.any(Number),
    });

    // 同一个手机号的常见展示格式必须归入同一 identifier，不能靠空格或 +86 绕过。
    expect((await login('13800138000', 'wrong-password')).status).toBe(401);
    expect((await login('138 0013 8000', 'wrong-password')).status).toBe(401);
    const phoneBlocked = await login('+86 138-0013-8000', 'wrong-password');
    expect(phoneBlocked.status).toBe(429);
  });

  it('密码登录成功会清理失败计数，时间窗过期会衰减，限流表达到上限会淘汰旧键', async () => {
    let now = 1_000;
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      loginRateLimit: {
        maxFailures: 3,
        windowMs: 1_000,
        blockMs: 60_000,
        maxEntries: 2,
        now: () => now,
      },
    });
    const db = await import('./db.js');
    db.createAccount({
      username: 'decay-user',
      password: 'decay-password',
      name: '衰减用户',
    });
    const login = (identifier: string, password: string) => fetch(
      `${base}/enterprise/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      },
    );

    expect((await login('decay-user', 'wrong-password')).status).toBe(401);
    expect((await login('decay-user', 'wrong-password')).status).toBe(401);
    expect((await login('decay-user', 'decay-password')).status).toBe(200);
    expect((await login('decay-user', 'wrong-password')).status).toBe(401);
    expect((await login('decay-user', 'wrong-password')).status).toBe(401);

    now += 1_001;
    expect((await login('decay-user', 'wrong-password')).status).toBe(401);

    // maxEntries=2：第三个 identifier 进入后会淘汰最旧键，旧键再次失败仍从 1 开始。
    expect((await login('oldest-key', 'wrong-password')).status).toBe(401);
    expect((await login('second-key', 'wrong-password')).status).toBe(401);
    expect((await login('third-key', 'wrong-password')).status).toBe(401);
    expect((await login('oldest-key', 'wrong-password')).status).toBe(401);
  });

  it('显式信任一层反向代理时按真实客户端 IP 隔离，且取最靠近代理的 XFF 地址防伪造', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      loginRateLimit: {
        maxFailures: 2,
        windowMs: 60_000,
        blockMs: 60_000,
        trustedProxyHops: 1,
      },
    });
    const login = (forwardedFor: string) => fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': forwardedFor,
      },
      body: JSON.stringify({ identifier: 'known-admin', password: 'wrong-password' }),
    });

    expect((await login('203.0.113.10')).status).toBe(401);
    expect((await login('198.51.100.20')).status).toBe(401);
    expect((await login('203.0.113.10')).status).toBe(429);
    // 代理追加真实客户端地址时，攻击者自带的最左侧伪造值不能更换限流身份。
    expect((await login('192.0.2.99, 203.0.113.10')).status).toBe(429);
    // 另一真实客户端仍有自己的失败预算，不会被同机 Caddy 的 loopback 地址连坐。
    expect((await login('198.51.100.20')).status).toBe(429);
  });

  it('独立客户端 IP 桶限制跨账号密码喷洒，不因更换 identifier 绕过', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      loginRateLimit: {
        maxFailures: 5,
        maxIpFailures: 3,
        windowMs: 60_000,
        blockMs: 60_000,
        trustedProxyHops: 1,
      },
    });
    const login = (identifier: string, forwardedFor: string) => fetch(
      `${base}/enterprise/auth/login`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor,
        },
        body: JSON.stringify({ identifier, password: 'wrong-password' }),
      },
    );

    expect((await login('user-a', '203.0.113.50')).status).toBe(401);
    expect((await login('user-b', '203.0.113.50')).status).toBe(401);
    expect((await login('user-c', '203.0.113.50')).status).toBe(429);
    expect((await login('user-d', '203.0.113.50')).status).toBe(429);
    expect((await login('user-d', '198.51.100.60')).status).toBe(401);
  });

  it('管理员专用登录只给管理员创建会话，普通成员被拒绝且不留下孤儿会话', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
    db.createAccount({
      username: 'staff01', password: 'staff-password', name: '普通成员',
    });
    db.createAccount({
      username: 'admin01', password: 'admin-password', name: '管理员',
      phone: '13800138000', isAdmin: true,
    });

    const sessionsBefore = (db.getDB().prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count;
    const staffLogin = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'staff01', password: 'staff-password' }),
    });
    expect(staffLogin.status).toBe(403);
    expect(await staffLogin.json()).toEqual({ error: '该账号没有管理员权限' });
    const sessionsAfterStaff = (db.getDB().prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count;
    expect(sessionsAfterStaff).toBe(sessionsBefore);

    const adminLogin = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: '13800138000', password: 'admin-password' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminBody = await adminLogin.json();
    expect(adminBody.account).toMatchObject({ username: 'admin01', isAdmin: true });
    expect(adminBody.token).toEqual(expect.any(String));
    const sessionsAfterAdmin = (db.getDB().prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count;
    expect(sessionsAfterAdmin).toBe(sessionsBefore + 1);
  });

  it('园区服务推送要求管理员账号会话，并写入接收成员的真实私聊', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
    const admin = db.createAccount({
      username: 'park-admin',
      password: 'admin-password',
      name: '园区管理员',
      isAdmin: true,
    });
    const member = db.createAccount({
      username: 'park-member',
      password: 'member-password',
      name: '接收成员',
    });
    const pushBody = JSON.stringify({
      recipientAccountId: member.id,
      serviceId: 'repair',
      note: '请今天下班前补充现场照片',
    });

    const unauthenticated = await fetch(`${base}/enterprise/park-services/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: pushBody,
    });
    expect(unauthenticated.status).toBe(401);

    const adminLogin = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'park-admin', password: 'admin-password' }),
    });
    expect(adminLogin.status).toBe(200);
    const adminSession = await adminLogin.json() as { token: string };

    const pushed = await fetch(`${base}/enterprise/park-services/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminSession.token}`,
        'content-type': 'application/json',
      },
      body: pushBody,
    });
    expect(pushed.status).toBe(201);
    await expect(pushed.json()).resolves.toMatchObject({
      message: {
        senderAccountId: admin.id,
        recipientAccountId: member.id,
        content: expect.stringContaining('【宏创AI园区服务】客户报修'),
      },
      recipient: { id: member.id, name: '接收成员' },
    });

    const memberLogin = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'park-member', password: 'member-password' }),
    });
    expect(memberLogin.status).toBe(200);
    const memberSession = await memberLogin.json() as { token: string };
    const conversation = await fetch(`${base}/enterprise/messages/${admin.id}`, {
      headers: { authorization: `Bearer ${memberSession.token}` },
    });
    expect(conversation.status).toBe(200);
    await expect(conversation.json()).resolves.toMatchObject({
      messages: [
        expect.objectContaining({
          senderAccountId: admin.id,
          recipientAccountId: member.id,
          content: expect.stringContaining('请今天下班前补充现场照片'),
        }),
      ],
    });
  }, 20_000);

  it('A2A 收件箱经过成员鉴权返回待处理请求，并在回复后移出收件箱', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const db = await import('./db.js');
    const alice = db.createAccount({
      username: 'atoa-route-alice',
      password: 'alice-password',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'atoa-route-bob',
      password: 'bob-password',
      name: 'Bob',
    });
    const login = async (identifier: string, password: string): Promise<string> => {
      const response = await fetch(`${base}/enterprise/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { token: string }).token;
    };
    const aliceToken = await login('atoa-route-alice', 'alice-password');
    const bobToken = await login('atoa-route-bob', 'bob-password');

    const sent = await fetch(`${base}/enterprise/messages/${bob.id}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${aliceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: 'OTTO_ATOA_REQUEST {"v":1,"id":"route-1","question":"今天方便评审吗？"}',
      }),
    });
    expect(sent.status).toBe(201);
    const requestMessage = (await sent.json()) as { message: { id: string } };

    const unauthenticated = await fetch(`${base}/enterprise/atoa/inbox`);
    expect(unauthenticated.status).toBe(401);

    const inbox = await fetch(`${base}/enterprise/atoa/inbox`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(inbox.status).toBe(200);
    await expect(inbox.json()).resolves.toMatchObject({
      requests: [
        expect.objectContaining({
          id: requestMessage.message.id,
          peerAccountId: alice.id,
        }),
      ],
    });

    const duplicatePoll = await fetch(`${base}/enterprise/atoa/inbox`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(duplicatePoll.status).toBe(200);
    await expect(duplicatePoll.json()).resolves.toEqual({ requests: [] });

    const replied = await fetch(`${base}/enterprise/messages/${alice.id}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bobToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: `OTTO_ATOA_RESPONSE {"v":1,"requestId":"${requestMessage.message.id}","answer":"可以，15:00 开始。"}`,
      }),
    });
    expect(replied.status).toBe(201);

    const afterReply = await fetch(`${base}/enterprise/atoa/inbox`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(afterReply.status).toBe(200);
    await expect(afterReply.json()).resolves.toEqual({ requests: [] });
  }, 30_000);

  it('企业邀请注册保存姓名和密码，之后支持手机号加密码或验证码登录', async () => {
    const sent: Array<{ phone: string; code: string }> = [];
    const sender = {
      async sendVerificationCode(phone: string, code: string): Promise<boolean> {
        sent.push({ phone, code });
        return true;
      },
    };
    const { base } = await startIsolated(ADMIN_TOKEN, sender);
    const db = await import('./db.js');
    const defaultInvite = db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID).code;
    db.createAccount({
      username: 'sms01', password: 'sms-password-1', name: '短信用户', phone: '13800138000',
    });

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

    const registeredSession = await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(registeredSession.status).toBe(200);
    expect((await registeredSession.json()).account).toMatchObject({
      id: registered.account.id,
      organizationId: db.DEFAULT_ORGANIZATION_ID,
    });

    const organizationView = await fetch(`${base}/enterprise/organization/view`, {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(organizationView.status).toBe(200);
    expect(await organizationView.json()).toMatchObject({
      organization: { id: db.DEFAULT_ORGANIZATION_ID, name: '默认企业' },
      members: expect.arrayContaining([
        expect.objectContaining({
          id: registered.account.id,
          name: '王小明',
          department: null,
        }),
      ]),
    });

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

    const smsLoginRequest = await fetch(`${base}/enterprise/auth/sms/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13700137000' }),
    });
    expect(smsLoginRequest.status).toBe(200);
    const smsLoginChallenge = await smsLoginRequest.json();
    expect(smsLoginChallenge.challengeId).toMatch(/^sms_/);
    expect(sent).toHaveLength(2);

    const smsLoginVerify = await fetch(`${base}/enterprise/auth/sms/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        challengeId: smsLoginChallenge.challengeId,
        code: sent[1]?.code,
      }),
    });
    expect(smsLoginVerify.status).toBe(200);
    await expect(smsLoginVerify.json()).resolves.toMatchObject({
      account: { id: registered.account.id },
      token: expect.any(String),
    });
  });

  it('普通注册无需企业邀请码，并给每个账号创建互相隔离的个人空间', async () => {
    const sent: Array<{ phone: string; code: string }> = [];
    const { base } = await startIsolated(ADMIN_TOKEN, {
      async sendVerificationCode(phone: string, code: string): Promise<boolean> {
        sent.push({ phone, code });
        return true;
      },
    });

    const registerPersonal = async (phone: string, name: string) => {
      const request = await fetch(`${base}/enterprise/auth/register/sms/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      expect(request.status).toBe(200);
      const challenge = await request.json();
      expect(challenge).toMatchObject({
        challengeId: expect.stringMatching(/^smsreg_/),
        registrationMode: 'personal',
        organization: null,
      });
      const sentCode = sent.at(-1)?.code;
      const verify = await fetch(`${base}/enterprise/auth/register/sms/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code: sentCode,
          name,
          password: 'personal-password-1',
        }),
      });
      expect(verify.status).toBe(200);
      return verify.json();
    };

    const first = await registerPersonal('13500135000', '个人一号');
    const second = await registerPersonal('13600136000', '个人二号');
    expect(first.account).toMatchObject({
      accountType: 'personal',
      organizationName: '个人一号的个人空间',
    });
    expect(second.account.accountType).toBe('personal');
    expect(first.account.organizationId).not.toBe(second.account.organizationId);
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
    let succeeds = false;
    const sender = {
      async sendVerificationCode(): Promise<boolean> { return succeeds; },
    };
    const { base } = await startIsolated(ADMIN_TOKEN, sender);
    const db = await import('./db.js');
    const defaultInvite = db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID).code;

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

  it('管理员可删除本企业其他账号，删除后旧会话失效且目录不再返回', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'delete-admin',
      password: 'delete-admin-password',
      name: '删除管理员',
      isAdmin: true,
    });
    const db = await import('./db.js');
    const staff = db.createAccount({
      username: 'delete-staff',
      password: 'delete-staff-password',
      name: '待删除员工',
    });
    const staffSession = db.createAuthSession(staff.id);
    const loginResponse = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        identifier: 'delete-admin',
        password: 'delete-admin-password',
      }),
    });
    const adminSession = (await loginResponse.json()) as { token: string; account: { id: string } };

    const deleted = await fetch(`${base}/enterprise/accounts/${staff.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ deleted: true, id: staff.id });

    const list = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    expect(((await list.json()) as { accounts: Array<{ id: string }> }).accounts)
      .not.toContainEqual(expect.objectContaining({ id: staff.id }));
    expect((await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${staffSession.token}` },
    })).status).toBe(401);

    const selfDelete = await fetch(`${base}/enterprise/accounts/${adminSession.account.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    expect(selfDelete.status).toBe(409);
    await expect(selfDelete.json()).resolves.toEqual({ error: '不能删除当前登录账号' });
  });

  it('新增账号支持 disabled，并明确拒绝非法 status 而不是静默创建 active 账号', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'admin', password: 'admin-password', name: '管理员', isAdmin: true,
    });
    const db = await import('./db.js');
    const login = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'admin-password' }),
    });
    const token = (await login.json()).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const disabled = await fetch(`${base}/enterprise/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'disabled-user',
        password: 'disabled-password',
        name: '停用成员',
        status: 'disabled',
      }),
    });
    expect(disabled.status).toBe(201);
    expect((await disabled.json()).account).toMatchObject({
      username: 'disabled-user',
      status: 'disabled',
    });
    expect((await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'disabled-user', password: 'disabled-password' }),
    })).status).toBe(401);

    const invalid = await fetch(`${base}/enterprise/accounts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        username: 'invalid-status-user',
        password: 'invalid-password',
        name: '非法状态成员',
        status: 'pending',
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: '账号状态必须是 active 或 disabled' });
    expect(db.listAccounts().some((account) => account.username === 'invalid-status-user')).toBe(false);
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

  it('账号管理拒绝非法手机号和少于 8 位的新密码，不把输入错误暴露成 500', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'admin', password: 'admin-password', name: '管理员', isAdmin: true,
    });
    const db = await import('./db.js');
    const staff = db.createAccount({
      username: 'staff', password: 'staff-password', name: '员工', phone: '13800138000',
    });
    const login = await fetch(`${base}/enterprise/auth/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: 'admin-password' }),
    });
    const token = (await login.json()).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const invalidPhone = await fetch(`${base}/enterprise/accounts/${staff.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ phone: 'abc' }),
    });
    expect(invalidPhone.status).toBe(400);
    expect(await invalidPhone.json()).toEqual({ error: '手机号格式不正确' });

    const shortPassword = await fetch(`${base}/enterprise/accounts/${staff.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ password: 'x' }),
    });
    expect(shortPassword.status).toBe(400);
    expect(await shortPassword.json()).toEqual({ error: '登录密码至少需要 8 位' });

    expect(db.getAccount(staff.id)?.phone).toBe('+8613800138000');
    const oldPassword = await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'staff', password: 'staff-password' }),
    });
    expect(oldPassword.status).toBe(200);
  });

  it('企业必须保留一名可登录管理员，并在密码、状态或权限变化后永久撤销旧会话', async () => {
    const { base } = await seedAccount(ADMIN_TOKEN, {
      username: 'primary', password: 'primary-password', name: '主管理员', isAdmin: true,
    });
    const db = await import('./db.js');

    async function login(identifier: string, password: string, admin = false): Promise<string> {
      const response = await fetch(`${base}/enterprise/auth/${admin ? 'admin/' : ''}login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).token;
    }

    const primary = db.listAccounts()[0];
    const primaryToken = await login('primary', 'primary-password', true);
    const primaryHeaders = {
      authorization: `Bearer ${primaryToken}`,
      'content-type': 'application/json',
    };

    for (const patch of [{ isAdmin: false }, { status: 'disabled' }]) {
      const response = await fetch(`${base}/enterprise/accounts/${primary.id}`, {
        method: 'PATCH', headers: primaryHeaders, body: JSON.stringify(patch),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: '企业至少需要保留一名可登录管理员' });
    }
    expect(db.getAccount(primary.id)).toMatchObject({ isAdmin: true, status: 'active' });

    const backup = db.createAccount({
      username: 'backup', password: 'backup-password', name: '备用管理员', isAdmin: true,
    });
    const backupToken = await login('backup', 'backup-password', true);
    const staff = db.createAccount({
      username: 'staff', password: 'staff-password', name: '普通员工',
    });
    const staffToken = await login('staff', 'staff-password');

    const changedPassword = await fetch(`${base}/enterprise/accounts/${staff.id}`, {
      method: 'PATCH', headers: primaryHeaders, body: JSON.stringify({ password: 'new-staff-password' }),
    });
    expect(changedPassword.status).toBe(200);
    expect((await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${staffToken}` },
    })).status).toBe(401);
    expect((await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'staff', password: 'staff-password' }),
    })).status).toBe(401);
    expect((await fetch(`${base}/enterprise/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'staff', password: 'new-staff-password' }),
    })).status).toBe(200);

    const disabled = await fetch(`${base}/enterprise/accounts/${primary.id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${backupToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(disabled.status).toBe(200);
    expect((await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${primaryToken}` },
    })).status).toBe(401);

    const reenabled = await fetch(`${base}/enterprise/accounts/${primary.id}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${backupToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(reenabled.status).toBe(200);
    expect((await fetch(`${base}/enterprise/auth/me`, {
      headers: { authorization: `Bearer ${primaryToken}` },
    })).status).toBe(401);
    expect(db.getAccount(backup.id)).toMatchObject({ isAdmin: true, status: 'active' });
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

  it('园区报修自动投递管理员指定的维修人员，并真实调用短信与飞书通道完成表单闭环', async () => {
    const smsSend = vi.fn(async () => true);
    const feishuSend = vi.fn(async () => true);
    const { base } = await startIsolated(ADMIN_TOKEN, null, {
      repairSmsSender: { channel: 'sms', send: smsSend },
      repairFeishuSender: { channel: 'feishu', send: feishuSend },
    });
    const db = await import('./db.js');
    db.createAccount({
      username: 'repair.reporter', password: 'reporter-password', name: '报修员工',
      phone: '13800138000', feishuOpenId: 'ou_reporter', tags: ['普通成员'],
    });
    db.createAccount({
      username: 'repair.worker', password: 'worker-password', name: '维修张工',
      phone: '13900139000', feishuOpenId: 'ou_worker',
      tags: ['维修工作人员', 'IT', '报修'],
    });
    const login = async (identifier: string, password: string): Promise<string> => {
      const response = await fetch(`${base}/enterprise/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      return (await response.json()).token;
    };
    const reporterToken = await login('repair.reporter', 'reporter-password');
    const workerToken = await login('repair.worker', 'worker-password');
    const submitted = await fetch(`${base}/enterprise/tickets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reporterToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '某某会议室 · 水电报修', description: '灯坏了',
        targetTags: ['维修工作人员'], category: '水电', location: '某某会议室',
        urgency: '普通', contact: '报修员工', contactPhone: '13800138000',
      }),
    });
    expect(submitted.status).toBe(201);
    const ticket = (await submitted.json()).ticket;
    expect(ticket).toMatchObject({ recipientCount: 1, status: '待接单', location: '某某会议室' });
    expect(smsSend).toHaveBeenCalledWith('+8613900139000', expect.stringContaining('新报修'), expect.stringContaining('灯坏了'));
    expect(feishuSend).toHaveBeenCalledWith('ou_worker', expect.stringContaining('新报修'), expect.stringContaining('灯坏了'));

    const read = await fetch(`${base}/enterprise/tickets/${ticket.id}/read`, {
      method: 'POST', headers: { authorization: `Bearer ${workerToken}` },
    });
    expect((await read.json()).ticket.readAt).toBeTruthy();
    const accepted = await fetch(`${base}/enterprise/tickets/${ticket.id}/action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    expect((await accepted.json()).ticket.status).toBe('维修中');
    const replied = await fetch(`${base}/enterprise/tickets/${ticket.id}/action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'respond', responseType: '远程指导', responseText: '请先检查墙面开关' }),
    });
    expect((await replied.json()).ticket).toMatchObject({
      responseType: '远程指导', responseText: '请先检查墙面开关', status: '维修中',
    });
    expect(smsSend).toHaveBeenCalledWith('+8613800138000', expect.stringContaining('维修回复'), expect.stringContaining('检查墙面开关'));
    expect(feishuSend).toHaveBeenCalledWith('ou_reporter', expect.stringContaining('维修回复'), expect.stringContaining('检查墙面开关'));
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

  it('积分路由使用账号会话，且创建、充值、作废仅允许企业管理员', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const admin = db.createAccount({
      username: 'credit.admin',
      password: 'credit-admin-password',
      name: '积分管理员',
      isAdmin: true,
    });
    const member = db.createAccount({
      username: 'credit.member',
      password: 'credit-member-password',
      name: '积分成员',
    });
    const adminToken = await login(base, admin.username, 'credit-admin-password');
    const memberToken = await login(base, member.username, 'credit-member-password');
    const memberHeaders = {
      authorization: `Bearer ${memberToken}`,
      'content-type': 'application/json',
    };
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    };

    expect((await fetch(`${base}/enterprise/credits/balance`)).status).toBe(401);
    const memberBalance = await fetch(`${base}/enterprise/credits/balance`, {
      headers: memberHeaders,
    });
    expect(memberBalance.status).toBe(200);
    expect(await memberBalance.json()).toMatchObject({ balance: 0 });

    const memberCreate = await fetch(`${base}/enterprise/credits/redeem-codes`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({ creditAmount: 100, count: 1 }),
    });
    expect(memberCreate.status).toBe(403);
    const memberTopUp = await fetch(`${base}/enterprise/credits/topup`, {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify({ amount: 100 }),
    });
    expect(memberTopUp.status).toBe(403);
    const memberRevoke = await fetch(
      `${base}/enterprise/credits/redeem-codes/not-a-code/revoke`,
      { method: 'POST', headers: memberHeaders },
    );
    expect(memberRevoke.status).toBe(403);
    const memberCodes = await fetch(`${base}/enterprise/credits/redeem-codes`, {
      headers: memberHeaders,
    });
    expect(memberCodes.status).toBe(403);
    const memberTransactions = await fetch(`${base}/enterprise/credits/transactions`, {
      headers: memberHeaders,
    });
    expect(memberTransactions.status).toBe(403);

    const topUp = await fetch(`${base}/enterprise/credits/topup`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ amount: 100 }),
    });
    expect(topUp.status).toBe(200);
    expect(await topUp.json()).toEqual({ newBalance: 100 });

    const created = await fetch(`${base}/enterprise/credits/redeem-codes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ creditAmount: 25, count: 1 }),
    });
    expect(created.status).toBe(201);
    const codeId = (await created.json()).codes[0].id;
    const invalidStatus = await fetch(
      `${base}/enterprise/credits/redeem-codes?status=unknown`,
      { headers: adminHeaders },
    );
    expect(invalidStatus.status).toBe(400);
    const unlimitedTransactions = await fetch(
      `${base}/enterprise/credits/transactions?limit=-1`,
      { headers: adminHeaders },
    );
    expect(unlimitedTransactions.status).toBe(400);
    const revoked = await fetch(`${base}/enterprise/credits/redeem-codes/${codeId}/revoke`, {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true });
  });

  it('积分路由只将领域错误映射为 400，底层数据库异常统一收口为不泄露细节的 500', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const database = await import('./db.js');
    const admin = database.createAccount({
      username: 'credit.failure.admin',
      password: 'credit-failure-admin-password',
      name: '积分故障管理员',
      isAdmin: true,
    });
    const member = database.createAccount({
      username: 'credit.failure.member',
      password: 'credit-failure-member-password',
      name: '积分故障成员',
    });
    const adminToken = await login(base, admin.username, 'credit-failure-admin-password');
    const memberToken = await login(base, member.username, 'credit-failure-member-password');
    const adminHeaders = {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
    };
    const memberHeaders = {
      authorization: `Bearer ${memberToken}`,
      'content-type': 'application/json',
    };
    const invalidCount = await fetch(`${base}/enterprise/credits/redeem-codes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ creditAmount: 25, count: 101 }),
    });
    expect(invalidCount.status).toBe(400);
    expect(await invalidCount.json()).toEqual({
      error: '兑换码生成数量必须是 1 到 100 的整数',
    });
    const created = await fetch(`${base}/enterprise/credits/redeem-codes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ creditAmount: 25, count: 1 }),
    });
    expect(created.status).toBe(201);
    const code = (await created.json()).codes[0].code as string;

    database.getDB().exec(`
      CREATE TRIGGER fail_credit_redeem
      BEFORE UPDATE OF status ON redeem_codes
      BEGIN
        SELECT RAISE(ABORT, 'sensitive-redeem-storage-failure');
      END;
      CREATE TRIGGER fail_credit_create
      BEFORE INSERT ON redeem_codes
      BEGIN
        SELECT RAISE(ABORT, 'sensitive-create-storage-failure');
      END;
      CREATE TRIGGER fail_credit_topup
      BEFORE UPDATE OF credit_balance ON organizations
      BEGIN
        SELECT RAISE(ABORT, 'sensitive-topup-storage-failure');
      END;
    `);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const responses = await Promise.all([
        fetch(`${base}/enterprise/credits/redeem`, {
          method: 'POST',
          headers: memberHeaders,
          body: JSON.stringify({ code }),
        }),
        fetch(`${base}/enterprise/credits/redeem-codes`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ creditAmount: 50, count: 1 }),
        }),
        fetch(`${base}/enterprise/credits/topup`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ amount: 100 }),
        }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ error: '企业服务暂时不可用，请稍后重试' });
        expect(text).not.toMatch(/sensitive|sqlite|trigger|database/i);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('邀请码只允许在 7 天窗口内申请短信，注册账号固定加入邀请码所属企业', async () => {
    const sent: Array<{ phone: string; code: string }> = [];
    const { base } = await startIsolated(ADMIN_TOKEN, {
      async sendVerificationCode(phone, code) {
        sent.push({ phone, code });
        return true;
      },
    });
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const invite = db.issueOrganizationInvite(alpha.id, Date.now(), null, {
      defaultDepartment: '研发部',
      departmentId: 'dept_rd',
      positionId: 'pos_brand',
      positionTitle: '品牌运营',
      defaultRole: '成员',
      maxUses: 1,
    });

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
    const registered = (await register.json()).account as {
      organizationId: string;
      organizationName: string;
      name: string;
      department: string | null;
      role: string | null;
      positionId: string | null;
      positionTitle: string | null;
    };
    expect(registered.department).toBe('研发部');
    expect(registered.role).toBe('成员');
    expect(registered.positionId).toBe('pos_brand');
    expect(registered.positionTitle).toBe('品牌运营');
    const alphaAdmin = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.invite.admin',
      password: 'alpha-admin-password',
      name: 'Alpha 邀请管理员',
      isAdmin: true,
    });
    const adminToken = await login(base, alphaAdmin.username, 'alpha-admin-password');
    const accounts = await fetch(`${base}/enterprise/accounts`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(accounts.status).toBe(200);
    const accountRows = await accounts.json() as {
      accounts: Array<{
        phone: string | null;
        department: string | null;
        role: string | null;
        positionId: string | null;
        positionTitle: string | null;
      }>;
    };
    expect(accountRows.accounts).toContainEqual(expect.objectContaining({
      phone: '+8613800138000',
      department: '研发部',
      role: '成员',
      positionId: 'pos_brand',
      positionTitle: '品牌运营',
    }));
    expect(db.getOrganizationInvite(alpha.id)?.usedCount).toBe(1);
    const exhausted = await fetch(`${base}/enterprise/auth/register/sms/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13900139000', inviteCode: invite.code }),
    });
    expect(exhausted.status).toBe(403);
    expect(registered).toMatchObject({
      organizationId: alpha.id,
      organizationName: 'Alpha 科技',
      name: 'Alpha 新员工',
    });
  });

  it('企业管理员只能查看和修改本企业账号，并可在后台手动生成新的 7 天邀请码', async () => {
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
    const alphaAccountRows = (await alphaAccounts.json()) as {
      accounts: Array<{ id: string }>;
    };
    const betaAccountRows = (await betaAccounts.json()) as {
      accounts: Array<{ id: string }>;
    };
    expect(alphaAccountRows.accounts.map((account) => account.id).sort())
      .toEqual([alphaAdmin.id, alphaStaff.id].sort());
    expect(betaAccountRows.accounts.map((account) => account.id).sort())
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
      defaultDepartment: null,
      positionTitle: null,
      defaultRole: null,
      maxUses: null,
      usedCount: 0,
      validHours: 168,
      link: `https://join.otto.example/enterprise/join/${firstInvite.code}`,
    });

    const second = await fetch(`${base}/enterprise/organization/invite`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        defaultDepartment: '研发部',
        positionTitle: '品牌运营',
        defaultRole: '成员',
        maxUses: 3,
      }),
    });
    const secondInvite = (await second.json()).invite;
    expect(secondInvite.code).not.toBe(firstInvite.code);
    expect(secondInvite.defaultDepartment).toBe('研发部');
    expect(secondInvite.positionTitle).toBe('品牌运营');
    expect(secondInvite.defaultRole).toBe('成员');
    expect(secondInvite.maxUses).toBe(3);
    expect(secondInvite.usedCount).toBe(0);
    expect(db.resolveOrganizationInvite(firstInvite.code)).toBeNull();
    expect(db.resolveOrganizationInvite(secondInvite.code)?.id).toBe(alpha.id);

    const current = await fetch(`${base}/enterprise/organization/invite`, {
      headers: { authorization: `Bearer ${alphaToken}` },
    });
    const currentPayload = await current.json();
    expect(currentPayload.invite.defaultDepartment).toBe('研发部');
    expect(currentPayload.invite.positionTitle).toBe('品牌运营');
    expect(currentPayload.invite.defaultRole).toBe('成员');
    expect(currentPayload.invite.maxUses).toBe(3);
    expect(currentPayload).toMatchObject({
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
    const accounts = ((await accountsResponse.json()) as {
      accounts: Array<{ id: string; usage?: { totalTokens: number; requestCount: number } }>;
    }).accounts;
    expect(accounts.find((account) => account.id === alphaStaff.id)?.usage)
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
      department: '研发部',
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

    const autoKnowledgeBody = {
      sourceId: 'kb_auto_1',
      category: 'solution',
      content: '部署完成后先检查健康端点。',
      confidence: 0.9,
      department: '伪造部门',
      contributor: '伪造人员',
    };
    const firstCapture = await fetch(`${base}/enterprise/knowledge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(autoKnowledgeBody),
    });
    expect(firstCapture.status).toBe(200);
    expect(await firstCapture.json()).toEqual({ status: 'added', added: true });

    const duplicateCapture = await fetch(`${base}/enterprise/knowledge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alphaToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(autoKnowledgeBody),
    });
    expect(await duplicateCapture.json()).toEqual({ status: 'exists', added: false });

    const captured = db.getKnowledge('研发部', 'solution', alpha.id)
      .filter((item: { content: string }) => item.content === autoKnowledgeBody.content);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      department: '研发部',
      contributor: 'Alpha 员工',
      confidence: 0.9,
    });
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
      invite: { status: 'active', validHours: 168 },
    });

    const secondProvision = await fetch(`${base}/enterprise/organizations`, {
      method: 'POST',
      headers: { 'x-otto-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Delta 物流',
        slug: 'delta',
        admin: {
          username: 'delta.owner',
          password: 'delta-owner-password',
          name: 'Delta 管理员',
        },
      }),
    });
    expect(secondProvision.status).toBe(201);
    const organizations = await fetch(`${base}/enterprise/organizations`, {
      headers: { 'x-otto-admin-token': ADMIN_TOKEN },
    });
    expect(organizations.status).toBe(200);
    expect(((await organizations.json()) as {
      organizations: Array<{ slug: string }>;
    }).organizations.map((organization) => organization.slug)).toEqual(
      expect.arrayContaining(['gamma', 'delta']),
    );

    const ownerToken = await login(base, 'gamma.owner', 'gamma-owner-password');
    const denied = await fetch(`${base}/enterprise/organizations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '越权企业', slug: 'forbidden' }),
    });
    expect(denied.status).toBe(403);
  });

  it('平台工作台按所选企业隔离面板数据，并从企业清单排除个人空间', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha-panel' });
    const beta = db.createOrganization({ name: 'Beta 物流', slug: 'beta-panel' });
    const alphaAdmin = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.panel.owner',
      password: 'alpha-panel-password',
      name: 'Alpha 管理员',
      department: '研发部',
      isAdmin: true,
    });
    const betaAdmin = db.createAccount({
      organizationId: beta.id,
      username: 'beta.panel.owner',
      password: 'beta-panel-password',
      name: 'Beta 管理员',
      department: '运营部',
      isAdmin: true,
    });
    const betaMember = db.createAccount({
      organizationId: beta.id,
      username: 'beta.panel.member',
      password: 'beta-member-password',
      name: 'Beta 成员',
      department: '客户成功部',
    });
    const personal = db.createPersonalRegisteredAccount({
      phone: '13800138077',
      name: '个人用户',
      password: 'personal-password',
    });

    const organizations = await fetch(`${base}/enterprise/organizations`, {
      headers: { 'x-otto-admin-token': ADMIN_TOKEN },
    });
    expect(organizations.status).toBe(200);
    const listed = (await organizations.json()) as {
      organizations: Array<{ id: string; name: string }>;
    };
    expect(listed.organizations.map((organization) => organization.id)).toEqual(
      expect.arrayContaining([alpha.id, beta.id]),
    );
    expect(listed.organizations.map((organization) => organization.id)).not.toContain(
      personal.organizationId,
    );

    const overview = await fetch(
      `${base}/enterprise/platform/organizations/${encodeURIComponent(beta.id)}/overview`,
      { headers: { 'x-otto-admin-token': ADMIN_TOKEN } },
    );
    expect(overview.status).toBe(200);
    const panel = (await overview.json()) as {
      organization: { id: string; name: string };
      accounts: Array<{ id: string; organizationId: string; name: string }>;
      usage: { organizationId: string };
    };
    expect(panel.organization).toMatchObject({ id: beta.id, name: 'Beta 物流' });
    expect(panel.usage.organizationId).toBe(beta.id);
    expect(panel.accounts.map((account) => account.id)).toEqual(
      expect.arrayContaining([betaAdmin.id, betaMember.id]),
    );
    expect(panel.accounts.every((account) => account.organizationId === beta.id)).toBe(true);
    expect(panel.accounts.map((account) => account.id)).not.toContain(alphaAdmin.id);

    const alphaAdminToken = await login(
      base,
      'alpha.panel.owner',
      'alpha-panel-password',
    );
    const denied = await fetch(
      `${base}/enterprise/platform/organizations/${encodeURIComponent(beta.id)}/overview`,
      { headers: { authorization: `Bearer ${alphaAdminToken}` } },
    );
    expect(denied.status).toBe(403);

    const personalOverview = await fetch(
      `${base}/enterprise/platform/organizations/${encodeURIComponent(personal.organizationId)}/overview`,
      { headers: { 'x-otto-admin-token': ADMIN_TOKEN } },
    );
    expect(personalOverview.status).toBe(404);

    const missing = await fetch(
      `${base}/enterprise/platform/organizations/org_missing/overview`,
      { headers: { 'x-otto-admin-token': ADMIN_TOKEN } },
    );
    expect(missing.status).toBe(404);
  });

  it('平台账号删除严格限定所选企业，不能用另一企业的账号 id 越权', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    const alpha = db.createOrganization({ name: 'Alpha 删除边界', slug: 'alpha-delete' });
    const beta = db.createOrganization({ name: 'Beta 删除边界', slug: 'beta-delete' });
    const alphaAdmin = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.delete.owner',
      password: 'alpha-delete-password',
      name: 'Alpha 管理员',
      isAdmin: true,
    });
    db.createAccount({
      organizationId: beta.id,
      username: 'beta.delete.owner',
      password: 'beta-delete-password',
      name: 'Beta 管理员',
      isAdmin: true,
    });
    const betaMember = db.createAccount({
      organizationId: beta.id,
      username: 'beta.delete.member',
      password: 'beta-member-password',
      name: 'Beta 成员',
    });

    const crossTenant = await fetch(
      `${base}/enterprise/platform/organizations/${encodeURIComponent(beta.id)}/accounts/${encodeURIComponent(alphaAdmin.id)}`,
      {
        method: 'DELETE',
        headers: { 'x-otto-admin-token': ADMIN_TOKEN },
      },
    );
    expect(crossTenant.status).toBe(404);
    expect(db.getAccount(alphaAdmin.id, alpha.id)).not.toBeNull();

    const deleted = await fetch(
      `${base}/enterprise/platform/organizations/${encodeURIComponent(beta.id)}/accounts/${encodeURIComponent(betaMember.id)}`,
      {
        method: 'DELETE',
        headers: { 'x-otto-admin-token': ADMIN_TOKEN },
      },
    );
    expect(deleted.status).toBe(200);
    expect(db.getAccount(betaMember.id, beta.id)).toBeNull();
  });

  it('平台创建企业、首位管理员和邀请是原子事务，管理员冲突不会留下孤儿企业', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN, null);
    const db = await import('./db.js');
    db.createAccount({
      username: 'already-used-owner',
      password: 'existing-password',
      name: '已有管理员',
      isAdmin: true,
    });
    const before = db.listOrganizations();

    const provision = await fetch(`${base}/enterprise/organizations`, {
      method: 'POST',
      headers: { 'x-otto-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '不应残留的企业',
        slug: 'must-rollback',
        admin: {
          username: 'already-used-owner',
          password: 'new-owner-password',
          name: '冲突管理员',
        },
      }),
    });

    expect(provision.status).toBe(409);
    expect(db.listOrganizations()).toEqual(before);
    expect(db.listOrganizations().some((organization) => organization.slug === 'must-rollback')).toBe(false);
    expect((db.getDB().prepare(
      `SELECT COUNT(*) AS count FROM organization_invites
       WHERE organization_id NOT IN (SELECT id FROM organizations)`,
    ).get() as { count: number }).count).toBe(0);
  });
});
