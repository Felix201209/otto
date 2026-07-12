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
import { ProductWorkspaceStore } from './productWorkspaceStore.js';
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
  vi.stubEnv('OTTO_USER_DIR', path.join(tmpHome, 'user'));
});

describe('OttoServer WS（v1.7 产品工作区）', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(async () => {
    const productWorkspaceStore = new ProductWorkspaceStore({
      rootDir: path.join(tmpHome, 'workspace'),
    });
    vi.stubEnv('OTTO_SCHEDULE_FILE', path.join(tmpHome, 'schedules.json'));
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
      productWorkspaceStore,
    });
    baseUrl = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('默认个人版；建档后切企业版并只返回 Otto 托管模型', async () => {
    vi.stubEnv('OTTO_SERVER_URL', '');
    const client = await connectWs(baseUrl);
    client.send({ type: 'get_product_workspace', payload: {} });
    let workspace = await client.waitFor((f) => f.type === 'product_workspace');
    if (workspace.type !== 'product_workspace') throw new Error('unreachable');
    expect(workspace.payload.context.edition).toBe('personal');

    client.send({
      type: 'configure_enterprise',
      payload: { managerName: '陈晨', companyName: '北辰科技', industry: '企业软件' },
    });
    workspace = await client.waitFor(
      (f) => f.type === 'product_workspace' && f.payload.context.edition === 'enterprise',
    );
    if (workspace.type !== 'product_workspace') throw new Error('unreachable');
    expect(workspace.payload.context.role).toBe('company_owner');

    client.send({ type: 'get_models', payload: {} });
    const models = await client.waitFor(
      (f) => f.type === 'models_list' && f.payload.models.some((model) => model.source === 'otto'),
    );
    if (models.type !== 'models_list') throw new Error('unreachable');
    expect(models.payload.models.length).toBeGreaterThanOrEqual(5);
    expect(models.payload.models.every((model) => model.source === 'otto' && model.managed)).toBe(true);
    expect(models.payload.models.every((model) => model.enabled === false)).toBe(true);
    expect(models.payload.current).toBeUndefined();

    vi.stubEnv('OTTO_SERVER_URL', 'https://enterprise.otto.example');
    client.send({ type: 'get_models', payload: {} });
    const configured = await client.waitFor(
      (f) => f.type === 'models_list' && f.payload.models.every((model) => model.enabled === true),
    );
    if (configured.type !== 'models_list') throw new Error('unreachable');
    expect(configured.payload.current).toBe('otto:deepseek');
    client.close();
  });

  it('企业版在协议层拒绝保存和删除个人 BYOK 模型', async () => {
    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;
    product.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const client = await connectWs(baseUrl);
    client.send({
      type: 'save_custom_model',
      payload: {
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        modelId: 'private-model',
      },
    });
    const saveError = await client.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'forbidden_by_edition',
    );
    expect(saveError.type).toBe('error');

    client.send({ type: 'delete_custom_model', payload: { id: 'custom:any' } });
    const deleteError = await client.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'forbidden_by_edition',
    );
    expect(deleteError.type).toBe('error');
    client.close();
  });

  it('企业模型服务未配置时发送立即报可读错误，不创建空白 assistant 或回退 mock', async () => {
    vi.stubEnv('OTTO_SERVER_URL', '');
    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;
    product.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: 'CEO 工作台', agentProfileId: 'otto-enterprise-ceo' },
    });
    const created = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'otto-enterprise-ceo',
    );
    if (created.type !== 'session_upsert') throw new Error('unreachable');
    const sessionId = created.payload.session.sessionId;
    client.send({ type: 'subscribe', payload: { sessionId } });
    await client.waitFor(
      (f) => f.type === 'history' && f.payload.sessionId === sessionId,
    );

    client.send({
      type: 'send_user_message',
      payload: {
        sessionId,
        content: [{ type: 'text', value: '你能做什么' }],
        source: 'local',
      },
    });
    const error = await client.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'managed_model_service_unavailable',
    );
    if (error.type !== 'error') throw new Error('unreachable');
    expect(error.payload.message).toBe('企业模型服务尚未配置，请联系企业管理员。');
    expect(
      client.frames.some(
        (frame) => frame.type === 'message_start' && frame.payload.message.role === 'assistant',
      ),
    ).toBe(false);
    expect(
      client.frames.some(
        (frame) => frame.type === 'chat_chunk' && frame.payload.delta.includes('mock'),
      ),
    ).toBe(false);
    client.close();
  });

  it('用户和 Otto 共用同一份日程仓库，创建后可按日期读取', async () => {
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_schedule',
      payload: {
        title: '竞品调研复盘',
        startAt: '2026-07-12T09:30:00+08:00',
        reason: '报告完成后复盘',
      },
    });
    const created = await client.waitFor(
      (f) => f.type === 'schedules_list' && f.payload.schedules.length === 1,
    );
    if (created.type !== 'schedules_list') throw new Error('unreachable');
    expect(created.payload.schedules[0]).toMatchObject({
      title: '竞品调研复盘',
      source: 'user',
    });

    client.send({
      type: 'get_schedules',
      payload: { date: '2026-07-12', timezone: 'Asia/Shanghai' },
    });
    const day = await client.waitFor(
      (f) => f.type === 'schedules_list' && f.payload.date === '2026-07-12',
    );
    if (day.type !== 'schedules_list') throw new Error('unreachable');
    expect(day.payload.schedules).toHaveLength(1);
    client.close();
  });

  it('CEO 可输入另一企业签发的总分公司链接并刷新组织树', async () => {
    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;
    const child = product.configureManager({ managerName: '子公司 CEO', companyName: '星海科技' });
    const parent = new ProductWorkspaceStore({ rootDir: path.join(tmpHome, 'parent-workspace') });
    const parentState = parent.configureManager({ managerName: '总公司 CEO', companyName: '北辰集团' });
    const invite = parent.issueInvite({
      kind: 'company_link',
      direction: 'parent_invites_child',
      targetCompanyId: child.context.companyId,
    });

    const client = await connectWs(baseUrl);
    client.send({ type: 'accept_company_link', payload: { link: invite.link } });
    const updated = await client.waitFor(
      (frame) => frame.type === 'product_workspace'
        && frame.payload.managerWorkspace?.organization.rootCompanyId === parentState.context.companyId,
    );
    if (updated.type !== 'product_workspace') throw new Error('unreachable');
    expect(updated.payload.context).toMatchObject({ role: 'company_owner', companyId: child.context.companyId });
    expect(updated.payload.managerWorkspace?.organization.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: child.context.companyId, parentCompanyId: parentState.context.companyId }),
    ]));
    client.close();
  });

  it('自动 Skill 候选可读取并仅在明确确认后写入用户 Skill 目录', async () => {
    const userDir = path.join(tmpHome, 'user');
    const pendingPath = path.join(userDir, 'memory', 'worklog', 'pending_skills.json');
    const savedPath = path.join(userDir, 'skills', 'auto-report', 'SKILL.md');
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify([{
      id: 'candidate-1',
      name: 'auto-report',
      description: '重复报告流程',
      triggerPatterns: ['整理数据'],
      detectedPattern: '整理数据 → 生成报告',
      occurrenceCount: 3,
      sampleEntries: [],
      skillContent: '---\nname: auto-report\ndescription: 重复报告流程\n---\n',
      reason: '过去三天重复执行',
      filePath: savedPath,
    }]), 'utf8');

    const client = await connectWs(baseUrl);
    client.send({ type: 'get_pending_auto_skills', payload: {} });
    const listed = await client.waitFor(
      (frame) => frame.type === 'pending_auto_skills' && frame.payload.candidates.length === 1,
    );
    if (listed.type !== 'pending_auto_skills') throw new Error('unreachable');
    expect(listed.payload.candidates[0]).toMatchObject({ id: 'candidate-1', occurrenceCount: 3 });
    expect(listed.payload.candidates[0]).not.toHaveProperty('skillContent');
    expect(fs.existsSync(savedPath)).toBe(false);

    client.send({ type: 'confirm_pending_auto_skill', payload: { candidateId: 'candidate-1' } });
    const confirmed = await client.waitFor(
      (frame) => frame.type === 'pending_auto_skills'
        && frame.payload.lastAction?.kind === 'confirmed',
    );
    if (confirmed.type !== 'pending_auto_skills') throw new Error('unreachable');
    expect(confirmed.payload.candidates).toHaveLength(0);
    expect(fs.readFileSync(savedPath, 'utf8')).toContain('name: auto-report');
    client.close();
  });

  it('Agent profile 只传 id，并按个人/CEO/部门身份隔离', async () => {
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '发起会议', agentProfileId: 'meeting-initiator' },
    });
    const created = await client.waitFor((f) => f.type === 'session_upsert');
    if (created.type !== 'session_upsert') throw new Error('unreachable');
    expect(created.payload.session).toMatchObject({
      agentProfileId: 'meeting-initiator',
      agentProfileName: '会议发起 Agent',
      productEdition: 'personal',
    });

    client.send({
      type: 'create_session',
      payload: { title: '做一份演示', agentProfileId: 'ppt' },
    });
    const personalExpert = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'ppt',
    );
    if (personalExpert.type !== 'session_upsert') throw new Error('unreachable');
    expect(personalExpert.payload.session).toMatchObject({
      agentProfileName: 'PPT 创作专家',
      productEdition: 'personal',
    });

    client.send({
      type: 'create_session',
      payload: { title: 'CEO 工作台', agentProfileId: 'otto-enterprise-ceo' },
    });
    const personalDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(personalDenied.type).toBe('error');

    client.send({
      type: 'create_session',
      payload: { title: '战略', agentProfileId: 'ceo-strategy' },
    });
    const denied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(denied.type).toBe('error');

    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;
    product.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    client.send({
      type: 'create_session',
      payload: { title: 'CEO 工作台', agentProfileId: 'otto-enterprise-ceo' },
    });
    const ceo = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'otto-enterprise-ceo',
    );
    if (ceo.type !== 'session_upsert') throw new Error('unreachable');
    expect(ceo.payload.session.agentProfileName).toBe('CEO Agent');

    client.send({
      type: 'create_session',
      payload: { title: '写品牌文案', agentProfileId: 'copy' },
    });
    const enterpriseExpert = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'copy',
    );
    if (enterpriseExpert.type !== 'session_upsert') throw new Error('unreachable');
    expect(enterpriseExpert.payload.session).toMatchObject({
      agentProfileName: '品牌营销文案',
      productEdition: 'enterprise',
    });

    client.send({
      type: 'create_session',
      payload: { title: '个人 Otto', agentProfileId: 'otto-personal' },
    });
    const enterpriseDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('企业版'),
    );
    expect(enterpriseDenied.type).toBe('error');
    client.close();
  });
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

  it('subscribe 后单发一帧当前 session_status（切回恢复「正在生成」UI）', async () => {
    const s = server.store.createSession({ title: 'st' });
    // 模拟切回时会话还在生成中（setStatus 的广播此刻无人订阅，会被错过——
    // 订阅时的单发补帧就是给这种客户端的）。
    server.store.setStatus(s.sessionId, 'thinking');
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');
    c.send({ type: 'subscribe', payload: { sessionId: s.sessionId } });
    const status = await c.waitFor((f) => f.type === 'session_status');
    if (status.type === 'session_status') {
      expect(status.payload.sessionId).toBe(s.sessionId);
      expect(status.payload.status).toBe('thinking');
    }
    // 顺序契约：先回灌 history，再补 session_status。
    const types = c.frames.map((f) => f.type);
    expect(types.indexOf('history')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('history')).toBeLessThan(
      types.indexOf('session_status'),
    );
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
      getConfig() { return undefined; },
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
      getConfig() { return undefined; },
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

describe('OttoServer set_model 真实生效语义', () => {
  let server: OttoServer;
  let baseUrl: string;
  let store: InMemorySessionStore;

  beforeEach(async () => {
    const dir = path.join(tmpHome, '.otto-user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'custom-models.json'),
      JSON.stringify({
        models: [
          {
            displayName: '旧 GLM',
            provider: 'openai',
            baseUrl: 'https://example.com/v1',
            apiKey: 'sk-old',
            modelId: 'glm-old',
            enabled: true,
          },
          {
            displayName: 'GPT-5.6 sol',
            provider: 'openai-responses',
            baseUrl: 'https://chatgpt.com/backend-api/codex',
            apiKey: '${CODEX_OAUTH}',
            modelId: 'gpt-5.6-sol',
            enabled: true,
          },
        ],
      }),
      'utf8',
    );
    store = new InMemorySessionStore();
    server = new OttoServer({ port: 0, mock: true, store });
    baseUrl = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  async function modelIds(client: WsClient): Promise<{ oldId: string; targetId: string }> {
    client.send({ type: 'get_models', payload: {} });
    const frame = await client.waitFor((item) => item.type === 'models_list');
    if (frame.type !== 'models_list') throw new Error('unreachable');
    const oldId = frame.payload.models.find((item) => item.displayName === '旧 GLM')?.id;
    const targetId = frame.payload.models.find(
      (item) => item.displayName === 'GPT-5.6 sol',
    )?.id;
    if (!oldId || !targetId) throw new Error('测试模型未加载');
    return { oldId, targetId };
  }

  function fakeRuntime(setModel: SessionRuntime['setModel']): SessionRuntime {
    return {
      async run() {},
      cancel() {},
      setModel,
      resolveToolConfirmation() {},
      getConfig() {
        return undefined;
      },
      async dispose() {},
    };
  }

  it('等待 live runtime 切换成功后，才更新会话模型并回报 current', async () => {
    const client = await connectWs(baseUrl);
    await client.waitFor((frame) => frame.type === 'welcome');
    const { oldId, targetId } = await modelIds(client);
    const session = store.createSession({ title: '切换模型', model: oldId });
    let release!: () => void;
    const setModel = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    store.attachRuntime(session.sessionId, fakeRuntime(setModel));

    client.send({
      type: 'set_model',
      payload: { sessionId: session.sessionId, model: targetId },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(setModel).toHaveBeenCalledWith(targetId);
    expect(store.getSession(session.sessionId)?.model).toBe(oldId);
    expect(
      client.frames.some(
        (frame) =>
          frame.type === 'models_list' && frame.payload.current === targetId,
      ),
    ).toBe(false);

    release();
    await client.waitFor(
      (frame) =>
        frame.type === 'models_list' && frame.payload.current === targetId,
    );
    expect(store.getSession(session.sessionId)?.model).toBe(targetId);
    client.close();
  });

  it('live runtime 切换失败时保留旧模型，并返回明确错误', async () => {
    const client = await connectWs(baseUrl);
    await client.waitFor((frame) => frame.type === 'welcome');
    const { oldId, targetId } = await modelIds(client);
    const session = store.createSession({ title: '切换失败', model: oldId });
    store.attachRuntime(
      session.sessionId,
      fakeRuntime(async () => {
        throw new Error('OAuth 鉴权失败');
      }),
    );

    client.send({
      type: 'set_model',
      payload: { sessionId: session.sessionId, model: targetId },
    });
    const error = await client.waitFor(
      (frame) => frame.type === 'error' && frame.payload.code === 'model_switch_failed',
    );

    expect(error.type).toBe('error');
    expect(store.getSession(session.sessionId)?.model).toBe(oldId);
    expect(
      client.frames.some(
        (frame) =>
          frame.type === 'models_list' && frame.payload.current === targetId,
      ),
    ).toBe(false);
    client.close();
  });
});

describe('OttoServer set_setting 实时提示词刷新', () => {
  it('切换工作方式时调用客户端的完整提示词重建', async () => {
    const store = new InMemorySessionStore();
    const server = new OttoServer({ port: 0, mock: true, store });
    const session = store.createSession({ title: '提示词刷新' });
    const refreshSystemPrompt = vi.fn(async () => undefined);
    const setAgentStyle = vi.fn();
    const config = {
      setAgentStyle,
      getOttoClient: () => ({
        updateSystemPromptWithMcpPrompts: refreshSystemPrompt,
      }),
    };
    store.attachRuntime(session.sessionId, {
      async run() {},
      cancel() {},
      async setModel() {},
      resolveToolConfirmation() {},
      getConfig: () => config as never,
      async dispose() {},
    });

    const previousCwd = process.cwd();
    process.chdir(tmpHome);
    try {
      await (
        server as unknown as {
          handleSetSetting: (
            conn: never,
            msg: { type: 'set_setting'; payload: { key: 'agentStyle'; value: string } },
          ) => Promise<void>;
        }
      ).handleSetSetting(undefined as never, {
        type: 'set_setting',
        payload: { key: 'agentStyle', value: 'antigravity' },
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(setAgentStyle).toHaveBeenCalledWith('antigravity');
    expect(refreshSystemPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('OttoServer 斜杠命令帧（P3）', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new OttoServer({ port: 0, mock: true, store: new InMemorySessionStore() });
    baseUrl = await startServer(server);
  });
  afterEach(async () => {
    await server.stop();
  });

  /** 建一个会话并返回 id（HTTP POST，最省事的真实路径）。 */
  async function createSession(): Promise<string> {
    const created = (await (
      await fetch(`${baseUrl}/sessions`, { method: 'POST' })
    ).json()) as ApiResponse<SessionSummary>;
    return created.data!.sessionId;
  }

  it('list_slash_commands → slash_commands_list（含 kb/about 等）', async () => {
    const client = await connectWs(baseUrl);
    client.send({ type: 'list_slash_commands', payload: {} });
    const frame = await client.waitFor((f) => f.type === 'slash_commands_list');
    if (frame.type !== 'slash_commands_list') throw new Error('unreachable');
    const names = frame.payload.commands.map((c) => c.name);
    expect(names).toContain('kb');
    expect(names).toContain('about');
    expect(names).toContain('memory');
    client.close();
  });

  it('run_slash_command 会话不存在 → error(no_session)', async () => {
    const client = await connectWs(baseUrl);
    client.send({
      type: 'run_slash_command',
      payload: { sessionId: 'nope', name: 'about' },
    });
    const frame = await client.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'no_session',
    );
    expect(frame.type).toBe('error');
    client.close();
  });

  it('run_slash_command /about → slash_command_result ok:true', async () => {
    const sessionId = await createSession();
    const client = await connectWs(baseUrl);
    client.send({
      type: 'run_slash_command',
      payload: { sessionId, name: 'about' },
    });
    const frame = await client.waitFor((f) => f.type === 'slash_command_result');
    if (frame.type !== 'slash_command_result') throw new Error('unreachable');
    expect(frame.payload.ok).toBe(true);
    expect(frame.payload.name).toBe('about');
    expect(frame.payload.markdown).toContain('关于 Otto');
    client.close();
  });

  it('run_slash_command 未知命令 → slash_command_result ok:false（不吞不假成功）', async () => {
    const sessionId = await createSession();
    const client = await connectWs(baseUrl);
    client.send({
      type: 'run_slash_command',
      payload: { sessionId, name: 'frobnicate', args: 'x' },
    });
    const frame = await client.waitFor((f) => f.type === 'slash_command_result');
    if (frame.type !== 'slash_command_result') throw new Error('unreachable');
    expect(frame.payload.ok).toBe(false);
    expect(frame.payload.markdown).toContain('未知命令');
    client.close();
  });

  it('run_slash_command submit_prompt 形态（/init）在会话正忙时 → ok:false 拒绝，无矛盾双帧', async () => {
    // /init 依赖 cwd 是否存在 OTTO.md 决定 message/submit_prompt 分叉；
    // mock 到干净临时目录，确保走 submit_prompt 路径（不受仓库现状影响）。
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-init-busy-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);
    try {
      const sessionId = await createSession();
      server.store.setStatus(sessionId, 'thinking');
      const client = await connectWs(baseUrl);
      client.send({
        type: 'run_slash_command',
        payload: { sessionId, name: 'init' },
      });
      const frame = await client.waitFor(
        (f) => f.type === 'slash_command_result',
      );
      if (frame.type !== 'slash_command_result') throw new Error('unreachable');
      expect(frame.payload.ok).toBe(false);
      expect(frame.payload.markdown).toContain('未提交');
      // 修复回归点：曾是「ok:true 回执 + error{busy}」矛盾双帧。
      // 现应既无 busy 错误帧、也没有真的提交（无 message_start）。
      expect(client.frames.filter((f) => f.type === 'error')).toHaveLength(0);
      expect(
        client.frames.filter((f) => f.type === 'message_start'),
      ).toHaveLength(0);
      client.close();
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  it('run_slash_command 畸形 payload（缺 name）→ bad_payload，零副作用', async () => {
    const sessionId = await createSession();
    const client = await connectWs(baseUrl);
    client.send({
      type: 'run_slash_command',
      payload: { sessionId },
    });
    const frame = await client.waitFor(
      (f) => f.type === 'error' && f.payload.code === 'bad_payload',
    );
    expect(frame.type).toBe('error');
    client.close();
  });
});
