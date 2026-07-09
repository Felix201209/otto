/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书凭证配置端点（GET/POST/DELETE /feishu/config）端到端测（离线）。
 *
 * 与 feishuEndpoints.test.ts 同一套隔离：HOME 指到临时目录（凭证文件真实
 * 落在 tmp，绝不碰用户真机 ~/.otto-user），gateway 注入 fake 不连真飞书。
 * adapter 侧不注入 credentials —— 让它走真实 loadCredentials 读盘，从而
 * 验证「POST 保存 → 守护用新凭证拉起」的完整闭环。
 *
 * 验证契约：
 *   1. 未配置时 GET → configured:false；
 *   2. POST 校验失败（缺 appId / 坏 domain）→ 400 + 人话原因；
 *   3. POST 合法凭证 → 保存 + 守护自动拉起（/health 连接态如实）；
 *      任何响应体里都不出现 appSecret 明文；
 *   4. 同 App ID 二次 POST 可省略 secret（沿用盘上已有）；换 App ID 必须重填；
 *   5. DELETE → 停守护 + 凭证清除，GET 回到 configured:false。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OttoServer } from '../server.js';
import { InMemorySessionStore } from '../sessions.js';
import type { FeishuGatewayLike } from './feishuAdapter.js';
import type { ApiResponse, FeishuConfigPublic, HealthInfo } from '../protocol.js';

/** 最小 fake gateway：connect 成功即同步 fire onReady。 */
function makeFakeGateway(): { gw: FeishuGatewayLike; connectCalls: () => number } {
  let onReady: (() => void) | null = null;
  let connects = 0;
  const gw: FeishuGatewayLike = {
    onMessage: null,
    get onReady() {
      return onReady;
    },
    set onReady(fn) {
      onReady = fn;
    },
    onDisconnect: null,
    async connect() {
      connects += 1;
      onReady?.();
    },
    async disconnect() {
      /* fake */
    },
    async sendStreamingCardWithFooter() {
      return {
        messageId: 'om_x',
        pushContent: async () => true,
        finalize: async () => true,
      };
    },
    async sendMarkdown() {
      return 'om_md';
    },
  };
  return { gw, connectCalls: () => connects };
}

async function startServer(server: OttoServer): Promise<string> {
  await server.start();
  const http = (server as unknown as { http: { address(): { port: number } } })
    .http;
  return `http://127.0.0.1:${http.address().port}`;
}

async function configRequest(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; raw: string; body: ApiResponse<FeishuConfigPublic> }> {
  const res = await fetch(`${baseUrl}/feishu/config`, {
    method,
    ...(body !== undefined
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const raw = await res.text();
  return {
    status: res.status,
    raw,
    body: JSON.parse(raw) as ApiResponse<FeishuConfigPublic>,
  };
}

async function getHealth(baseUrl: string): Promise<HealthInfo> {
  const res = await fetch(`${baseUrl}/health`);
  return ((await res.json()) as ApiResponse<HealthInfo>).data!;
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-feishu-cfg-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('飞书凭证配置端点', () => {
  let server: OttoServer;
  let baseUrl: string;
  let fake: ReturnType<typeof makeFakeGateway>;

  beforeEach(async () => {
    fake = makeFakeGateway();
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      enableFeishu: false,
      // 只注入 fake gateway；credentials 不注入 → adapter 真实读盘（tmp HOME）。
      feishuDeps: { gatewayFactory: () => fake.gw },
    });
    baseUrl = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('未配置时 GET → configured:false', async () => {
    const { status, body } = await configRequest(baseUrl, 'GET');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ configured: false });
  });

  it('POST 校验失败：缺 appId / 坏 domain → 400 + 人话原因', async () => {
    const noAppId = await configRequest(baseUrl, 'POST', {
      appSecret: 's',
      domain: 'feishu',
    });
    expect(noAppId.status).toBe(400);
    expect(noAppId.body.ok).toBe(false);
    expect(noAppId.body.error).toContain('App ID');

    const badDomain = await configRequest(baseUrl, 'POST', {
      appId: 'cli_x',
      appSecret: 's',
      domain: 'wechat',
    });
    expect(badDomain.status).toBe(400);
    expect(badDomain.body.ok).toBe(false);
    expect(badDomain.body.error).toContain('domain');
  });

  it('POST 合法凭证 → 保存 + 守护拉起；响应永不含 secret 明文', async () => {
    const { status, raw, body } = await configRequest(baseUrl, 'POST', {
      appId: 'cli_new',
      appSecret: 'super-secret-value',
      domain: 'feishu',
      ownerOpenId: 'ou_felix',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data?.configured).toBe(true);
    expect(body.data?.appId).toBe('cli_new');
    expect(body.data?.ownerOpenId).toBe('ou_felix');
    // 脱敏硬约束：secret 明文不出现在响应任何角落。
    expect(raw).not.toContain('super-secret-value');

    // 守护已用新凭证拉起（fake gateway 建连成功）。
    expect(fake.connectCalls()).toBe(1);
    const health = await getHealth(baseUrl);
    expect(health.feishu.enabled).toBe(true);
    expect(health.feishu.connected).toBe(true);

    // GET 回显脱敏视图。
    const got = await configRequest(baseUrl, 'GET');
    expect(got.body.data?.configured).toBe(true);
    expect(got.body.data?.appId).toBe('cli_new');
    expect(got.raw).not.toContain('super-secret-value');
  });

  it('同 App ID 可省略 secret 只改授权人；换 App ID 必须重填 secret', async () => {
    await configRequest(baseUrl, 'POST', {
      appId: 'cli_a',
      appSecret: 'sec-a',
      domain: 'feishu',
    });

    // 同 app 省略 secret：沿用盘上已有，ownerOpenId 更新成功。
    const sameApp = await configRequest(baseUrl, 'POST', {
      appId: 'cli_a',
      domain: 'feishu',
      ownerOpenId: 'ou_added_later',
    });
    expect(sameApp.status).toBe(200);
    expect(sameApp.body.ok).toBe(true);
    expect(sameApp.body.data?.ownerOpenId).toBe('ou_added_later');

    // 换 app 省略 secret：诚实拒绝。
    const newApp = await configRequest(baseUrl, 'POST', {
      appId: 'cli_b',
      domain: 'feishu',
    });
    expect(newApp.status).toBe(400);
    expect(newApp.body.ok).toBe(false);
    expect(newApp.body.error).toContain('App Secret');
  });

  it('DELETE → 停守护 + 清凭证；GET 回到 configured:false', async () => {
    await configRequest(baseUrl, 'POST', {
      appId: 'cli_del',
      appSecret: 'sec',
      domain: 'lark',
    });
    expect((await getHealth(baseUrl)).feishu.enabled).toBe(true);

    const cleared = await configRequest(baseUrl, 'DELETE');
    expect(cleared.status).toBe(200);
    expect(cleared.body.ok).toBe(true);
    expect(cleared.body.data?.configured).toBe(false);

    expect((await getHealth(baseUrl)).feishu.enabled).toBe(false);
    const got = await configRequest(baseUrl, 'GET');
    expect(got.body.data).toEqual({ configured: false });
  });
});
