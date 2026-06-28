/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OttoServer 端到端测：起真 HTTP+WS（port:0），用 ws 客户端往返各帧。
 *
 * 注入自定义 store + runtimeFactory + mock，天然可测，不接 core。
 * 覆盖：HTTP /health /sessions /history /404；WS welcome 握手；
 * list/create/subscribe(history 回灌)/get_history/unsubscribe 往返；
 * send_user_message 在 mock 下的 echo 序列；坏帧 bad_json/bad_frame/no_session；
 * 注入 fake runtimeFactory 验证懒构建去重 + 工厂抛错 publish runtime_init_failed。
 *
 * 用 HOME 隔离到临时目录，避免 shouldMock 读到真实机器的 BYO-key 模型导致路径分叉。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { OttoServer, type RuntimeFactory } from './server.js';
import { InMemorySessionStore } from './sessions.js';
import type { SessionRuntime } from './sessions.js';
import type {
  ApiResponse,
  HealthInfo,
  ServerToClient,
  SessionSummary,
  OttoMessage,
} from './protocol.js';

let tmpHome: string;

/** 起 server 监听随机端口（port:0），返回基础 URL。
 *  server.endpoint 返回构造端口（0），故从内部 http server 的 address() 取
 *  OS 实际分配的端口（测试侧反射读私有字段，不改源码）。 */
async function startServer(server: OttoServer): Promise<string> {
  await server.start();
  const http = (server as unknown as { http: { address(): { port: number } } })
    .http;
  const port = http.address().port;
  return `http://127.0.0.1:${port}`;
}

/** 连 WS 并收集帧；resolve 后返回操作句柄。 */
interface WsClient {
  ws: WebSocket;
  frames: ServerToClient[];
  send(frame: unknown): void;
  /** 等到收到满足谓词的帧（或超时）。 */
  waitFor(pred: (f: ServerToClient) => boolean, timeoutMs?: number): Promise<ServerToClient>;
  close(): void;
}

async function connectWs(baseUrl: string): Promise<WsClient> {
  const wsUrl = baseUrl.replace('http', 'ws') + '/ws';
  const ws = new WebSocket(wsUrl);
  const frames: ServerToClient[] = [];
  const waiters: Array<{ pred: (f: ServerToClient) => boolean; resolve: (f: ServerToClient) => void }> = [];

  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as ServerToClient;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return {
    ws,
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    waitFor: (pred, timeoutMs = 2000) => {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise<ServerToClient>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('waitFor 超时：未收到匹配帧')),
          timeoutMs,
        );
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
    close: () => ws.close(),
  };
}

async function getJson<T>(url: string): Promise<{ status: number; body: ApiResponse<T> }> {
  const res = await fetch(url);
  const body = (await res.json()) as ApiResponse<T>;
  return { status: res.status, body };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-server-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('OttoServer HTTP', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new OttoServer({ port: 0, mock: true, store: new InMemorySessionStore() });
    baseUrl = await startServer(server);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('GET /health 返回 HealthInfo 信封', async () => {
    const { status, body } = await getJson<HealthInfo>(`${baseUrl}/health`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data!.status).toBe('ok');
    expect(body.data!.protocolVersion).toBe('1');
    expect(body.data!.sessionCount).toBe(0);
  });

  it('POST /sessions 201 + 返回 summary', async () => {
    const res = await fetch(`${baseUrl}/sessions`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ApiResponse<SessionSummary>;
    expect(body.ok).toBe(true);
    expect(body.data!.sessionId).toBeDefined();
    // /health 的 sessionCount 随之增加
    const { body: health } = await getJson<HealthInfo>(`${baseUrl}/health`);
    expect(health.data!.sessionCount).toBe(1);
  });

  it('GET /sessions 列表', async () => {
    await fetch(`${baseUrl}/sessions`, { method: 'POST' });
    const { body } = await getJson<SessionSummary[]>(`${baseUrl}/sessions`);
    expect(body.data).toHaveLength(1);
  });

  it('GET /sessions/:id/history', async () => {
    const created = (await (
      await fetch(`${baseUrl}/sessions`, { method: 'POST' })
    ).json()) as ApiResponse<SessionSummary>;
    const { body } = await getJson<OttoMessage[]>(
      `${baseUrl}/sessions/${created.data!.sessionId}/history`,
    );
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it('未知路由 → 404', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiResponse<null>;
    expect(body.ok).toBe(false);
  });
});

describe('OttoServer WS（mock 模式）', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new OttoServer({ port: 0, mock: true, store: new InMemorySessionStore() });
    baseUrl = await startServer(server);
  });
  afterEach(async () => {
    await server.stop();
  });

  it('连上即收 welcome', async () => {
    const c = await connectWs(baseUrl);
    const welcome = await c.waitFor((f) => f.type === 'welcome');
    expect(welcome.type).toBe('welcome');
    c.close();
  });

  it('create_session → 广播 session_upsert', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'create_session', payload: { title: 'T1' } });
    const upsert = await c.waitFor((f) => f.type === 'session_upsert');
    expect(upsert.type).toBe('session_upsert');
    if (upsert.type === 'session_upsert') {
      expect(upsert.payload.session.title).toBe('T1');
    }
    c.close();
  });

  it('list_sessions 往返', async () => {
    server.store.createSession({ title: 'pre' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'list_sessions', payload: {} });
    const list = await c.waitFor((f) => f.type === 'sessions_list');
    if (list.type === 'sessions_list') {
      expect(list.payload.sessions).toHaveLength(1);
    }
    c.close();
  });

  it('subscribe 回灌 history', async () => {
    const s = server.store.createSession({ title: 's' });
    server.store.appendMessage(s.sessionId, {
      role: 'user',
      content: [{ type: 'text', value: 'old' }],
      source: 'local',
    });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    const hist = await c.waitFor((f) => f.type === 'history');
    if (hist.type === 'history') {
      expect(hist.payload.messages).toHaveLength(1);
      expect(hist.payload.messages[0].content[0]).toEqual({
        type: 'text',
        value: 'old',
      });
    }
    c.close();
  });

  it('get_history 往返', async () => {
    const s = server.store.createSession({ title: 'g' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'get_history', payload: { sessionId: s.sessionId } });
    const hist = await c.waitFor((f) => f.type === 'history');
    if (hist.type === 'history') {
      expect(hist.payload.sessionId).toBe(s.sessionId);
    }
    c.close();
  });

  it('send_user_message 走 mockEcho：user→assistant→chunk→complete→status 序列', async () => {
    const s = server.store.createSession({ title: 'echo' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    await c.waitFor((f) => f.type === 'history');

    c.send({
      type: 'send_user_message',
      payload: {
        sessionId: s.sessionId,
        content: [{ type: 'text', value: 'hi' }],
        source: 'local',
      },
    });

    await c.waitFor((f) => f.type === 'chat_complete');
    const types = c.frames.map((f) => f.type);
    // 应包含 user message_start、assistant message_start、chat_chunk、chat_complete、session_status
    expect(types).toContain('message_start');
    expect(types).toContain('chat_chunk');
    expect(types).toContain('chat_complete');
    expect(types).toContain('session_status');
    // 两条 message_start（user + assistant）
    expect(types.filter((t) => t === 'message_start').length).toBeGreaterThanOrEqual(2);
    c.close();
  });

  it('坏帧：非法 JSON → error{bad_json}', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.ws.send('{ not json');
    const errFrame = await c.waitFor((f) => f.type === 'error');
    if (errFrame.type === 'error') {
      expect(errFrame.payload.code).toBe('bad_json');
    }
    c.close();
  });

  it('坏帧：过不了守卫 → error{bad_frame}', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.ws.send(JSON.stringify({ nope: 1 }));
    const errFrame = await c.waitFor((f) => f.type === 'error');
    if (errFrame.type === 'error') {
      expect(errFrame.payload.code).toBe('bad_frame');
    }
    c.close();
  });

  it('对不存在 session send_user_message → error{no_session}', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'send_user_message',
      payload: {
        sessionId: 'ghost',
        content: [{ type: 'text', value: 'x' }],
        source: 'local',
      },
    });
    const errFrame = await c.waitFor((f) => f.type === 'error');
    if (errFrame.type === 'error') {
      expect(errFrame.payload.code).toBe('no_session');
    }
    c.close();
  });
});

describe('OttoServer runtimeFactory（非 mock 路径）', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(() => {
    // shouldMock() = mock || loadCustomModels().length===0。要走 runtimeFactory，
    // 必须让机器「看起来配了 BYO-key 模型」，否则空 HOME 会降级到 mockEcho。
    const dir = path.join(tmpHome, '.otto-user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'custom-models.json'),
      JSON.stringify({
        models: [
          {
            displayName: 'Test',
            provider: 'openai',
            baseUrl: 'https://example.com/v1',
            apiKey: 'sk-x',
            modelId: 'gpt-test',
          },
        ],
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('ensureRuntime 懒构建去重：并发两条 send 只建一次 runtime', async () => {
    let factoryCalls = 0;
    let runCalls = 0;
    const factory: RuntimeFactory = async (store, sessionId) => {
      factoryCalls++;
      // 模拟较慢的初始化，制造并发窗口
      await new Promise((r) => setTimeout(r, 30));
      const runtime: SessionRuntime = {
        async run() {
          runCalls++;
          store.setStatus(sessionId, 'idle');
        },
        cancel() {},
        setModel() {},
        async dispose() {},
      };
      return runtime;
    };
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({ title: 'r' });

    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    // 并发两条 send（不 await 之间）
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'a' }], source: 'local' },
    });
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'b' }], source: 'local' },
    });
    // 给足时间让两条都跑完
    await new Promise((r) => setTimeout(r, 200));
    expect(factoryCalls).toBe(1); // 懒构建去重：只建一次
    expect(runCalls).toBe(2); // 两条都跑了 run
    c.close();
  });

  it('工厂抛错 → publish runtime_init_failed + status error', async () => {
    const factory: RuntimeFactory = async () => {
      throw new Error('鉴权未配');
    };
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({ title: 'fail' });

    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    await c.waitFor((f) => f.type === 'history');
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'x' }], source: 'local' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'runtime_init_failed',
    );
    expect(errFrame.type).toBe('error');
    c.close();
  });
});
