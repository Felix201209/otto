/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书运行期启停端点（POST /feishu/start | /feishu/stop）端到端测（离线）。
 *
 * 起真 HTTP server（port:0）+ 注入 fake gateway / 凭证（OttoServerOptions.feishuDeps），
 * 不读真凭证、不连真飞书。验证契约：
 *   1. 无凭证 → start 诚实失败（ok:false + 原因），/health enabled 保持 false；
 *   2. 运行期 start（server 启动时未启用）→ 注册并连上，/health 如实反映；
 *   3. start 幂等：重复调用不重复建连；
 *   4. stop → 守护停止（running=false），/health enabled=false；重复 stop 幂等；
 *      从未启动过的 server 调 stop → 诚实报「未在运行」；
 *   5. stop 后再 start → 守护恢复（重新建连成功）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OttoServer } from '../server.js';
import { InMemorySessionStore, type SessionRuntime } from '../sessions.js';
import type { FeishuGatewayLike } from './feishuAdapter.js';
import type { FeishuMessage } from './vendor/gateway.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import type { ApiResponse, FeishuHealthStatus, HealthInfo } from '../protocol.js';

const CREDS: FeishuCredentials = {
  appId: 'cli_app',
  appSecret: 'secret',
  domain: 'feishu',
  ownerOpenId: 'ou_owner',
  allowlist: [],
};

/** 最小 fake gateway：connect 成功即同步 fire onReady；计数 connect/disconnect。 */
function makeFakeGateway(): {
  gw: FeishuGatewayLike;
  connectCalls: () => number;
  fireMessage: (msg: FeishuMessage) => Promise<string | null>;
  finalized: string[];
} {
  let onReady: (() => void) | null = null;
  let onMessage: ((msg: FeishuMessage) => Promise<string | null>) | null = null;
  let connects = 0;
  const finalized: string[] = [];
  const gw: FeishuGatewayLike = {
    get onMessage() {
      return onMessage;
    },
    set onMessage(fn) {
      onMessage = fn;
    },
    get onReady() {
      return onReady;
    },
    set onReady(fn) {
      onReady = fn;
    },
    onDisconnect: null,
    async connect() {
      connects += 1;
      onReady?.(); // 对齐真 gateway：onReady 在 resolve 前触发
    },
    async disconnect() {
      /* fake */
    },
    async sendStreamingCardWithFooter() {
      return {
        messageId: 'om_x',
        pushContent: async () => true,
        finalize: async (text) => {
          finalized.push(text);
          return true;
        },
      };
    },
    async sendMarkdown() {
      return 'om_md';
    },
  };
  return {
    gw,
    connectCalls: () => connects,
    fireMessage: (msg) => {
      if (!onMessage) throw new Error('onMessage 未接');
      return onMessage(msg);
    },
    finalized,
  };
}

/** 起 server 监听随机端口，返回基础 URL（同 server.test.ts 的反射取端口法）。 */
async function startServer(server: OttoServer): Promise<string> {
  await server.start();
  const http = (server as unknown as { http: { address(): { port: number } } })
    .http;
  return `http://127.0.0.1:${http.address().port}`;
}

async function post(
  url: string,
): Promise<{ status: number; body: ApiResponse<FeishuHealthStatus | null> }> {
  const res = await fetch(url, { method: 'POST' });
  return {
    status: res.status,
    body: (await res.json()) as ApiResponse<FeishuHealthStatus | null>,
  };
}

async function getHealth(
  baseUrl: string,
): Promise<HealthInfo> {
  const res = await fetch(`${baseUrl}/health`);
  const body = (await res.json()) as ApiResponse<HealthInfo>;
  return body.data!;
}

let tmpHome: string;

beforeEach(() => {
  // HOME 隔离：杜绝读到真机凭证 / BYO-key 模型（shouldMock 路径分叉）。
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-feishu-ep-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('飞书运行期启停端点', () => {
  let server: OttoServer;
  let baseUrl: string;

  afterEach(async () => {
    await server.stop();
  });

  it('无凭证 → start 诚实失败（ok:false），enabled 保持 false', async () => {
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      enableFeishu: false,
      feishuDeps: { credentials: null }, // 显式注入「无凭证」
    });
    baseUrl = await startServer(server);

    const { status, body } = await post(`${baseUrl}/feishu/start`);
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('凭证');
    // 不谎报启用：/health enabled 仍为 false。
    const health = await getHealth(baseUrl);
    expect(health.feishu.enabled).toBe(false);
  });

  it('运行期 start → 注册并连上；重复 start 幂等（不重复建连）', async () => {
    const fake = makeFakeGateway();
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      enableFeishu: false, // server 启动时未启用 —— 运行期才拉起
      feishuDeps: { credentials: CREDS, gatewayFactory: () => fake.gw },
    });
    baseUrl = await startServer(server);
    expect((await getHealth(baseUrl)).feishu.enabled).toBe(false);

    const first = await post(`${baseUrl}/feishu/start`);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.data?.running).toBe(true);
    expect(first.body.data?.connected).toBe(true);
    expect(fake.connectCalls()).toBe(1);

    // /health 如实反映。
    const health = await getHealth(baseUrl);
    expect(health.feishu.enabled).toBe(true);
    expect(health.feishu.connected).toBe(true);

    // 幂等：再 start 不重复建连。
    const second = await post(`${baseUrl}/feishu/start`);
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(second.body.data?.connected).toBe(true);
    expect(fake.connectCalls()).toBe(1);
  });

  it('飞书首条消息 → server 懒建真实 runtime，不回 mock', async () => {
    const fake = makeFakeGateway();
    let factoryCalls = 0;
    let runCalls = 0;
    server = new OttoServer({
      port: 0,
      mock: false,
      store: new InMemorySessionStore(),
      enableFeishu: true,
      runtimeFactory: async (store, sessionId): Promise<SessionRuntime> => {
        factoryCalls += 1;
        return {
          async run() {
            runCalls += 1;
            const assistant = store.appendMessage(sessionId, {
              role: 'assistant',
              content: [{ type: 'text', value: '' }],
              source: 'local',
              isStreaming: true,
            });
            store.publish(sessionId, {
              type: 'message_start',
              payload: { message: assistant },
            });
            store.publish(sessionId, {
              type: 'chat_chunk',
              payload: {
                sessionId,
                messageId: assistant.id,
                delta: 'server 真实回复',
              },
            });
            store.publish(sessionId, {
              type: 'chat_complete',
              payload: {
                sessionId,
                messageId: assistant.id,
                text: 'server 真实回复',
              },
            });
          },
          cancel() {},
          setModel() {},
          getConfig() {
            return undefined;
          },
          async dispose() {},
        };
      },
      feishuDeps: { credentials: CREDS, gatewayFactory: () => fake.gw },
    });
    baseUrl = await startServer(server);
    await new Promise((r) => setTimeout(r, 20));

    await fake.fireMessage({
      text: '第一条真实飞书消息',
      messageId: 'om_first_real',
      chatId: 'oc_first_real',
      chatType: 'p2p',
      senderOpenId: 'ou_owner',
      mentions: [],
      messageType: 'text',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCalls).toBe(1);
    expect(runCalls).toBe(1);
    expect(fake.finalized).toContain('server 真实回复');
    expect(fake.finalized.join('\n')).not.toContain('mock');
  });

  it('stop → 守护停止且 /health enabled=false；重复 stop 幂等；stop 后 start 恢复', async () => {
    const fake = makeFakeGateway();
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      enableFeishu: true, // 启动即启用（凭证注入）
      feishuDeps: { credentials: CREDS, gatewayFactory: () => fake.gw },
    });
    baseUrl = await startServer(server);
    // start() 里的建连是异步发起的，等一拍让它落定。
    await new Promise((r) => setTimeout(r, 20));
    expect((await getHealth(baseUrl)).feishu.connected).toBe(true);
    expect(fake.connectCalls()).toBe(1);

    // 停止：有意停止，之后不自动重连。
    const stopped = await post(`${baseUrl}/feishu/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.ok).toBe(true);
    expect(stopped.body.data?.running).toBe(false);
    expect(stopped.body.data?.connected).toBe(false);
    const health = await getHealth(baseUrl);
    expect(health.feishu.enabled).toBe(false);
    expect(health.feishu.connected).toBe(false);

    // 重复 stop：幂等成功（不是报错）。
    const stoppedAgain = await post(`${baseUrl}/feishu/stop`);
    expect(stoppedAgain.status).toBe(200);
    expect(stoppedAgain.body.ok).toBe(true);

    // 再 start：守护恢复，重新建连。
    const restarted = await post(`${baseUrl}/feishu/start`);
    expect(restarted.status).toBe(200);
    expect(restarted.body.ok).toBe(true);
    expect(restarted.body.data?.connected).toBe(true);
    expect(fake.connectCalls()).toBe(2);
    expect((await getHealth(baseUrl)).feishu.enabled).toBe(true);
  });

  it('从未启动过飞书的 server 调 stop → 诚实报「未在运行」', async () => {
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      enableFeishu: false,
      feishuDeps: { credentials: null },
    });
    baseUrl = await startServer(server);

    const { status, body } = await post(`${baseUrl}/feishu/stop`);
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('未在运行');
  });
});
