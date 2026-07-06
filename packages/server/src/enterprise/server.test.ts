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
async function startIsolated(adminToken?: string): Promise<{ base: string; server: Server }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  vi.resetModules();
  const mod: ServerModule = await import('./server.js');
  const { server } = mod.createEnterpriseServer({ host: '127.0.0.1', adminToken });
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
