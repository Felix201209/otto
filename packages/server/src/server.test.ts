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

  it('畸形 payload：content 传字符串 → error{bad_payload}，不落库', async () => {
    const s = server.store.createSession({ title: 'bad1' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: '不是数组', source: 'local' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'bad_payload',
    );
    expect(errFrame.type).toBe('error');
    // 零副作用：不落库、不广播 message_start。
    expect(server.store.getHistory(s.sessionId)).toHaveLength(0);
    expect(c.frames.filter((f) => f.type === 'message_start')).toHaveLength(0);
    c.close();
  });

  it('畸形 payload：content 传 null → error{bad_payload}，不落库', async () => {
    const s = server.store.createSession({ title: 'bad2' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: null, source: 'local' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'bad_payload',
    );
    expect(errFrame.type).toBe('error');
    expect(server.store.getHistory(s.sessionId)).toHaveLength(0);
    expect(c.frames.filter((f) => f.type === 'message_start')).toHaveLength(0);
    c.close();
  });

  it('畸形 payload：未知 type → error{bad_payload}', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'nope_type', payload: {} });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'bad_payload',
    );
    expect(errFrame.type).toBe('error');
    c.close();
  });

  it('delete_session：删会话 → 广播 sessions_list 权威快照（不含被删会话）', async () => {
    const keep = server.store.createSession({ title: 'keep' });
    const gone = server.store.createSession({ title: 'gone' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'delete_session', payload: { sessionId: gone.sessionId } });
    const list = await c.waitFor((f) => f.type === 'sessions_list');
    if (list.type === 'sessions_list') {
      const ids = list.payload.sessions.map((s) => s.sessionId);
      expect(ids).toContain(keep.sessionId);
      expect(ids).not.toContain(gone.sessionId);
    }
    // 会话确已从 store 移除
    expect(server.store.getSession(gone.sessionId)).toBeUndefined();
    c.close();
  });

  it('delete_session：不存在的会话 → error{no_session}，不广播 sessions_list', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'delete_session', payload: { sessionId: 'ghost' } });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'no_session',
    );
    expect(errFrame.type).toBe('error');
    expect(c.frames.filter((f) => f.type === 'sessions_list')).toHaveLength(0);
    c.close();
  });

  it('rename_session：改 title → 广播 session_upsert（新标题）', async () => {
    const s = server.store.createSession({ title: '旧标题' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'rename_session',
      payload: { sessionId: s.sessionId, title: '新标题' },
    });
    const upsert = await c.waitFor((f) => f.type === 'session_upsert');
    if (upsert.type === 'session_upsert') {
      expect(upsert.payload.session.sessionId).toBe(s.sessionId);
      expect(upsert.payload.session.title).toBe('新标题');
    }
    expect(server.store.getSession(s.sessionId)!.title).toBe('新标题');
    c.close();
  });

  it('rename_session：纯空白 title → error{bad_payload}（校验拦截）', async () => {
    const s = server.store.createSession({ title: '不变' });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'rename_session',
      payload: { sessionId: s.sessionId, title: '   ' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'bad_payload',
    );
    expect(errFrame.type).toBe('error');
    expect(server.store.getSession(s.sessionId)!.title).toBe('不变');
    c.close();
  });

  it('rename_session：不存在的会话 → error{no_session}', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'rename_session',
      payload: { sessionId: 'ghost', title: '任意' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'no_session',
    );
    expect(errFrame.type).toBe('error');
    c.close();
  });

  it('WS maxPayload 显式上限 10MB', () => {
    const wss = (
      server as unknown as { wss: { options: { maxPayload?: number } } }
    ).wss;
    expect(wss.options.maxPayload).toBe(10 * 1024 * 1024);
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

  // ── P0-1（断开/停机取消）与 P0-4（busy 不落库）────────────────────────────

  /** 挂起式 fake runtime：run 设 thinking 后一直挂到 cancel/dispose，模拟长跑轮次。 */
  function makeHangingRuntime(): {
    factory: RuntimeFactory;
    calls: { run: number; cancel: number; dispose: number };
  } {
    const calls = { run: 0, cancel: 0, dispose: 0 };
    let release: (() => void) | undefined;
    const factory: RuntimeFactory = async (store, sessionId) => ({
      async run() {
        calls.run++;
        store.setStatus(sessionId, 'thinking');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        store.setStatus(sessionId, 'idle');
      },
      cancel() {
        calls.cancel++;
        release?.();
        release = undefined;
      },
      setModel() {},
      async dispose() {
        calls.dispose++;
        release?.();
        release = undefined;
      },
    });
    return { factory, calls };
  }

  /** 轮询等到条件成立（或超时抛错）。 */
  async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('最后一个订阅连接断开 → cancel 当前轮；仍有其他连接订阅则不取消', async () => {
    const { factory, calls } = makeHangingRuntime();
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({ title: 'orphan' });

    const c1 = await connectWs(baseUrl);
    const c2 = await connectWs(baseUrl);
    await c1.waitFor((f) => f.type === 'welcome');
    await c2.waitFor((f) => f.type === 'welcome');
    c1.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    c2.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    await c1.waitFor((f) => f.type === 'history');
    await c2.waitFor((f) => f.type === 'history');

    c1.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'x' }], source: 'local' },
    });
    await waitUntil(() => calls.run === 1);

    // c1 断开：c2 仍订阅 → 不取消。
    c1.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.cancel).toBe(0);

    // c2 也断开：已无存活订阅连接 → 取消当前轮。
    c2.close();
    await waitUntil(() => calls.cancel === 1);
    expect(calls.cancel).toBe(1);
  });

  it('飞书绑定会话：桌面端全部断开也不取消（飞书侧还在等回复）', async () => {
    const { factory, calls } = makeHangingRuntime();
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({
      title: 'feishu-bound',
      source: 'feishu',
      feishuChatId: 'oc_test',
    });

    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    await c.waitFor((f) => f.type === 'history');
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'x' }], source: 'local' },
    });
    await waitUntil(() => calls.run === 1);

    c.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.cancel).toBe(0);
  });

  it('server.stop() → cancel + dispose 活跃 runtime', async () => {
    const { factory, calls } = makeHangingRuntime();
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({ title: 'stopme' });

    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: 'x' }], source: 'local' },
    });
    await waitUntil(() => calls.run === 1);

    await server.stop();
    // stop 先 cancel 再 dispose；socket close 兜底路径可能再补一次 cancel（幂等）。
    expect(calls.cancel).toBeGreaterThanOrEqual(1);
    expect(calls.dispose).toBe(1);
  });

  it('会话正忙（thinking）再来一条 → error{busy}，不落库不广播', async () => {
    const { factory, calls } = makeHangingRuntime();
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
    const s = server.store.createSession({ title: 'busy' });

    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    await c.waitFor((f) => f.type === 'history');

    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: '第一条' }], source: 'local' },
    });
    await c.waitFor(
      (f) => f.type === 'session_status' && f.payload.status === 'thinking',
    );

    c.send({
      type: 'send_user_message',
      payload: { sessionId: s.sessionId, content: [{ type: 'text', value: '第二条' }], source: 'local' },
    });
    const errFrame = await c.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'busy',
    );
    expect(errFrame.type).toBe('error');
    // 第二条没有落库：历史里只有第一条 user 消息；run 也只被驱动一次。
    expect(server.store.getHistory(s.sessionId)).toHaveLength(1);
    expect(calls.run).toBe(1);
    expect(c.frames.filter((f) => f.type === 'message_start')).toHaveLength(1);
    c.close();
  });
});
