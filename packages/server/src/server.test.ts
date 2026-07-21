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
import {
  OttoServer,
  resolveSessionRuntimeModel,
  type RuntimeFactory,
} from './server.js';
import { InMemorySessionStore } from './sessions.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';
import type { AuthenticatedEnterpriseAccount } from './productWorkspaceStore.js';
import type { SessionRuntime } from './sessions.js';
import type {
  ApiResponse,
  HealthInfo,
  ServerToClient,
  SessionSummary,
  OttoMessage,
} from './protocol.js';

let tmpHome: string;
const wsClientTokens = new Map<string, string>();

/** 起 server 监听随机端口（port:0），返回基础 URL。
 *  server.endpoint 返回构造端口（0），故从内部 http server 的 address() 取
 *  OS 实际分配的端口（测试侧反射读私有字段，不改源码）。 */
async function startServer(server: OttoServer): Promise<string> {
  await server.start();
  const http = (server as unknown as { http: { address(): { port: number } } })
    .http;
  const port = http.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  wsClientTokens.set(baseUrl, server.clientToken);
  return baseUrl;
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
  const clientToken = wsClientTokens.get(baseUrl);
  if (!clientToken) throw new Error(`测试未登记 WS client token: ${baseUrl}`);
  const wsUrl =
    baseUrl.replace('http', 'ws') +
    `/ws?clientToken=${encodeURIComponent(clientToken)}`;
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

describe('会话运行时模型边界', () => {
  it('内部测试企业会话继续使用成员自己的 BYOK，只有未上线的 otto:* 才回退', () => {
    const customModel = 'custom:openai-responses:gpt-5.6-sol@test';
    expect(resolveSessionRuntimeModel('enterprise', customModel)).toBe(customModel);
    expect(resolveSessionRuntimeModel('personal', customModel)).toBe(customModel);
    expect(resolveSessionRuntimeModel('enterprise', 'otto:managed')).toBeUndefined();
  });
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
  }, 30_000);

  const authenticatedAccount = (
    patch: Partial<AuthenticatedEnterpriseAccount> = {},
  ): AuthenticatedEnterpriseAccount => ({
    id: 'central-account-1',
    organizationId: 'central-org-1',
    organizationName: '北辰中心企业',
    name: '林一',
    isAdmin: false,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    role: 'company_owner',
    tags: ['CEO', '超级管理员'],
    ...patch,
  });

  afterEach(async () => {
    await server.stop();
  });

  it('内部测试阶段切到企业视图后仍返回成员自己的 BYOK 模型', async () => {
    const client = await connectWs(baseUrl);
    client.send({ type: 'get_product_workspace', payload: {} });
    let workspace = await client.waitFor((f) => f.type === 'product_workspace');
    if (workspace.type !== 'product_workspace') throw new Error('unreachable');
    expect(workspace.payload.context.edition).toBe('personal');

    client.send({
      type: 'save_custom_model',
      payload: {
        provider: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        modelId: 'private-model',
        displayName: '内部个人模型',
      },
    });
    await client.waitFor(
      (f) =>
        f.type === 'models_list' &&
        f.payload.models.some((model) => model.modelId === 'private-model'),
    );

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
      (f) =>
        f.type === 'models_list' &&
        f.payload.models.some((model) => model.modelId === 'private-model'),
    );
    if (models.type !== 'models_list') throw new Error('unreachable');
    expect(models.payload.models).toHaveLength(1);
    expect(models.payload.models[0]).toMatchObject({
      modelId: 'private-model',
      source: 'byok',
      enabled: true,
    });
    expect(models.payload.models[0].managed).not.toBe(true);
    expect(models.payload.current).toBe(models.payload.models[0].id);
    client.close();
  });

  it('企业视图下仍允许内部成员保存和删除个人 BYOK 模型', async () => {
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
    const saved = await client.waitFor(
      (f) =>
        f.type === 'models_list' &&
        f.payload.models.some((model) => model.modelId === 'private-model'),
    );
    if (saved.type !== 'models_list') throw new Error('unreachable');
    const savedId = saved.payload.models.find(
      (model) => model.modelId === 'private-model',
    )!.id;

    client.send({ type: 'delete_custom_model', payload: { id: savedId } });
    const deleted = await client.waitFor(
      (f) =>
        f.type === 'models_list' &&
        !f.payload.models.some((model) => model.id === savedId),
    );
    expect(deleted.type).toBe('models_list');
    client.close();
  });

  it('未绑定个人 API 时明确报错，不创建空白 assistant 或回退 mock', async () => {
    // 该用例验证真实内部测试运行态；describe 默认 mock 仅用于其余传输层用例。
    (server as unknown as { mock: boolean }).mock = false;
    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;
    product.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '企业工作台', agentProfileId: 'otto-enterprise-work' },
    });
    const created = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'otto-enterprise-work',
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
      (f) => f.type === 'error' && f.payload.code === 'model_not_configured',
    );
    if (error.type !== 'error') throw new Error('unreachable');
    expect(error.payload.message).toBe('请先在设置中绑定个人 API，再开始对话。');
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

  it('Agent profile 只传 id，并把固定 9 个工作 Agent 全部隔离到企业身份', async () => {
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '会议', agentProfileId: 'meeting' },
    });
    const personalMeetingDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(personalMeetingDenied.type).toBe('error');

    client.send({
      type: 'create_session',
      payload: { title: '做一份演示', agentProfileId: 'ppt' },
    });
    const personalPptDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(personalPptDenied.type).toBe('error');

    client.send({
      type: 'create_session',
      payload: { title: '企业工作台', agentProfileId: 'otto-enterprise-work' },
    });
    const personalDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(personalDenied.type).toBe('error');

    client.send({
      type: 'create_session',
      payload: { title: '企业自主开发', agentProfileId: 'self-development' },
    });
    const personalDevelopmentDenied = await client.waitFor(
      (f) => f.type === 'error'
        && f.payload.code === 'forbidden_agent_profile'
        && f.payload.message.includes('个人版'),
    );
    expect(personalDevelopmentDenied.type).toBe('error');

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
      payload: { title: '企业工作台', agentProfileId: 'otto-enterprise-work' },
    });
    const ceo = await client.waitFor(
      (f) => f.type === 'session_upsert' && f.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    if (ceo.type !== 'session_upsert') throw new Error('unreachable');
    expect(ceo.payload.session.agentProfileName).toBe('企业工作 Agent');

    client.send({
      type: 'create_session',
      payload: { title: '企业自主开发', agentProfileId: 'self-development' },
    });
    const enterpriseDevelopment = await client.waitFor(
      (f) => f.type === 'session_upsert'
        && f.payload.session.agentProfileId === 'self-development',
    );
    expect(enterpriseDevelopment.type).toBe('session_upsert');

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

  it('create_session 的基础 Agent 与个人、管理者、成员身份白名单一致', async () => {
    const product = (server as unknown as { productWorkspace: ProductWorkspaceStore }).productWorkspace;

    let client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '个人首卡', agentProfileId: 'otto-personal' },
    });
    const personal = await client.waitFor(
      (frame) => frame.type === 'session_upsert'
        && frame.payload.session.agentProfileId === 'otto-personal',
    );
    if (personal.type !== 'session_upsert') throw new Error('unreachable');
    expect(personal.payload.session).toMatchObject({
      agentProfileName: 'Otto',
      productEdition: 'personal',
    });
    client.send({
      type: 'create_session',
      payload: { title: '错误企业首卡', agentProfileId: 'otto-enterprise-work' },
    });
    const personalDenied = await client.waitFor(
      (frame) => frame.type === 'error'
        && frame.payload.code === 'forbidden_agent_profile',
    );
    expect(personalDenied.type).toBe('error');
    client.close();

    product.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const memberInvite = product.issueInvite({ kind: 'company' });
    client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '管理者首卡', agentProfileId: 'otto-enterprise-work' },
    });
    const ceo = await client.waitFor(
      (frame) => frame.type === 'session_upsert'
        && frame.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    if (ceo.type !== 'session_upsert') throw new Error('unreachable');
    expect(ceo.payload.session).toMatchObject({
      agentProfileName: '企业工作 Agent',
      productEdition: 'enterprise',
    });
    client.close();

    product.acceptInvite(memberInvite.link, {
      userId: 'member-agent-profile',
      displayName: '林一',
    });
    client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '成员首卡', agentProfileId: 'otto-enterprise-work' },
    });
    const work = await client.waitFor(
      (frame) => frame.type === 'session_upsert'
        && frame.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    if (work.type !== 'session_upsert') throw new Error('unreachable');
    expect(work.payload.session).toMatchObject({
      agentProfileName: '企业工作 Agent',
      productEdition: 'enterprise',
    });
    client.send({
      type: 'create_session',
      payload: { title: '错误管理者首卡', agentProfileId: 'otto-enterprise-ceo' },
    });
    const memberDenied = await client.waitFor(
      (frame) => frame.type === 'error'
        && frame.payload.code === 'forbidden_agent_profile'
        && frame.payload.message.includes('角色'),
    );
    expect(memberDenied.type).toBe('error');
    client.close();
  });

  it('中心认证成员不能通过 configure_enterprise 自升 CEO，admin/member 只能创建各自 profile', async () => {
    const client = await connectWs(baseUrl);
    server.setAuthenticatedEnterpriseAccount(authenticatedAccount());

    client.send({
      type: 'configure_enterprise',
      payload: { managerName: '伪造 CEO', companyName: '伪造企业' },
    });
    const escalationDenied = await client.waitFor(
      (frame) =>
        frame.type === 'error' &&
        frame.payload.code === 'workspace_failed' &&
        frame.payload.message.includes('中心认证身份'),
    );
    expect(escalationDenied.type).toBe('error');

    client.send({
      type: 'create_session',
      payload: { title: '成员工作台', agentProfileId: 'otto-enterprise-work' },
    });
    const memberSession = await client.waitFor(
      (frame) =>
        frame.type === 'session_upsert' &&
        frame.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    expect(memberSession.type).toBe('session_upsert');

    client.send({
      type: 'create_session',
      payload: { title: '成员通用文案', agentProfileId: 'copy' },
    });
    const commonProfile = await client.waitFor(
      (frame) =>
        frame.type === 'session_upsert' &&
        frame.payload.session.agentProfileId === 'copy',
    );
    expect(commonProfile.type).toBe('session_upsert');

    client.send({
      type: 'create_session',
      payload: { title: '伪造 CEO 工作台', agentProfileId: 'otto-enterprise-ceo' },
    });
    const memberDenied = await client.waitFor(
      (frame) =>
        frame.type === 'error' &&
        frame.payload.code === 'forbidden_agent_profile',
    );
    expect(memberDenied.type).toBe('error');

    server.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({ isAdmin: true, role: 'member', tags: [] }),
    );
    client.send({
      type: 'create_session',
      payload: { title: '管理员工作台', agentProfileId: 'otto-enterprise-work' },
    });
    const adminSession = await client.waitFor(
      (frame) =>
        frame.type === 'session_upsert' &&
        frame.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    expect(adminSession.type).toBe('session_upsert');

    client.close();
  });

  it('中心身份角色变化会取消旧 runtime，但统一企业工作会话仍可继续', async () => {
    const client = await connectWs(baseUrl);
    server.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({ isAdmin: true, role: 'member', tags: [] }),
    );
    client.send({
      type: 'create_session',
      payload: { title: '企业工作会话', agentProfileId: 'otto-enterprise-work' },
    });
    const created = await client.waitFor(
      (frame) =>
        frame.type === 'session_upsert' &&
        frame.payload.session.agentProfileId === 'otto-enterprise-work',
    );
    if (created.type !== 'session_upsert') throw new Error('unreachable');
    const sessionId = created.payload.session.sessionId;
    client.send({ type: 'subscribe', payload: { sessionId } });
    await client.waitFor(
      (frame) => frame.type === 'history' && frame.payload.sessionId === sessionId,
    );
    const cancel = vi.fn();
    server.store.attachRuntime(sessionId, {
      async run() {},
      cancel,
      setModel() {},
      resolveToolConfirmation() {},
      getConfig() {
        return undefined;
      },
      async dispose() {},
    });
    server.store.setStatus(sessionId, 'thinking');

    const previousHistoryCount = client.frames.filter(
      (frame) => frame.type === 'history' && frame.payload.sessionId === sessionId,
    ).length;
    server.setAuthenticatedEnterpriseAccount(authenticatedAccount());
    expect(cancel).toHaveBeenCalledTimes(1);

    // 身份切换期间会先隔离旧 runtime 的事件，再自动恢复仍获授权会话的订阅；
    // 桌面客户端无需依赖 activeSessionId 改变或手工重订阅。
    await client.waitFor(
      (frame) =>
        frame.type === 'history'
        && frame.payload.sessionId === sessionId
        && client.frames.filter(
          (seen) => seen.type === 'history' && seen.payload.sessionId === sessionId,
        ).length > previousHistoryCount,
    );
    client.send({
      type: 'send_user_message',
      payload: {
        sessionId,
        content: [{ type: 'text', value: '继续执行企业工作' }],
        source: 'local',
      },
    });
    const completed = await client.waitFor(
      (frame) => frame.type === 'chat_complete' && frame.payload.sessionId === sessionId,
    );
    expect(completed.type).toBe('chat_complete');
    expect(
      client.frames.some(
        (frame) => frame.type === 'error' && frame.payload.code === 'forbidden_agent_profile',
      ),
    ).toBe(false);
    client.close();
  });

  it('loopback 控制路由必须持有 control token，并校验 account/null 后同步快照', async () => {
    expect(Buffer.from(server.controlToken, 'base64url')).toHaveLength(32);
    const body = { account: authenticatedAccount() };
    const missing = await fetch(`${baseUrl}/internal/enterprise-identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/internal/enterprise-identity`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(wrong.status).toBe(401);

    const synced = await fetch(`${baseUrl}/internal/enterprise-identity`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(synced.status).toBe(200);
    const syncedBody = (await synced.json()) as ApiResponse<{
      context: { role: string };
    }>;
    expect(syncedBody.ok).toBe(true);
    expect(syncedBody.data?.context.role).toBe('member');

    const withDirectory = await fetch(
      `${baseUrl}/internal/enterprise-identity`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${server.controlToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          account: authenticatedAccount({
            organizationMembers: [
              {
                id: 'central-account-2',
                username: 'staff02',
                name: '周二',
                role: 'member',
                department: '销售部',
                positionId: 'position-sales',
                positionTitle: '销售经理',
                isAdmin: false,
                status: 'active',
              },
            ],
          }),
        }),
      },
    );
    expect(withDirectory.status).toBe(200);
    const withDirectoryBody = (await withDirectory.json()) as ApiResponse<{
      members: Array<{ userId: string; displayName: string }>;
    }>;
    expect(withDirectoryBody.data?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: 'central-account-2',
          displayName: '周二',
        }),
      ]),
    );

    const invalid = await fetch(`${baseUrl}/internal/enterprise-identity`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ account: { id: 'broken', isAdmin: false } }),
    });
    expect(invalid.status).toBe(400);

    for (const organizationMembers of [
      Array.from({ length: 201 }, (_, index) => ({
        id: `member-${index}`,
        username: `member-${index}`,
        name: `成员 ${index}`,
        role: null,
        department: null,
        positionId: null,
        positionTitle: null,
        isAdmin: false,
        status: 'active',
      })),
      [
        {
          id: 'member-broken',
          username: 'member-broken',
          name: '成员',
          role: null,
          department: null,
          positionId: null,
          positionTitle: null,
          isAdmin: 'false',
          status: 'active',
        },
      ],
      [
        {
          id: 'x'.repeat(129),
          username: 'too-long',
          name: '成员',
          role: null,
          department: null,
          positionId: null,
          positionTitle: null,
          isAdmin: false,
          status: 'active',
        },
      ],
    ]) {
      const rejected = await fetch(
        `${baseUrl}/internal/enterprise-identity`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${server.controlToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            account: authenticatedAccount({ organizationMembers }),
          }),
        },
      );
      expect(rejected.status).toBe(400);
    }

    const cleared = await fetch(`${baseUrl}/internal/enterprise-identity`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.controlToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ account: null }),
    });
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as ApiResponse<{
      context: { edition: string };
    }>;
    expect(clearedBody.data?.context.edition).toBe('personal');
  });

  it('中心会话绑定账号和组织；legacy/错租户会话不会被列出且所有 sessionId 操作统一拒绝', async () => {
    server.setAuthenticatedEnterpriseAccount(authenticatedAccount());
    const legacy = server.store.createSession({
      title: '旧版无租户会话',
      productEdition: 'enterprise',
    });
    const mismatched = server.store.createSession({
      title: '其它租户会话',
      productEdition: 'enterprise',
      enterpriseAccountId: 'other-account',
      enterpriseOrganizationId: 'other-org',
    });
    const client = await connectWs(baseUrl);
    client.send({
      type: 'create_session',
      payload: { title: '当前成员会话', agentProfileId: 'otto-enterprise-work' },
    });
    const created = await client.waitFor(
      (frame) =>
        frame.type === 'session_upsert' &&
        frame.payload.session.title === '当前成员会话',
    );
    if (created.type !== 'session_upsert') throw new Error('unreachable');
    expect(created.payload.session).toMatchObject({
      enterpriseAccountId: 'central-account-1',
      enterpriseOrganizationId: 'central-org-1',
    });

    client.send({ type: 'list_sessions', payload: {} });
    const listed = await client.waitFor((frame) => frame.type === 'sessions_list');
    if (listed.type !== 'sessions_list') throw new Error('unreachable');
    expect(listed.payload.sessions.map((session) => session.sessionId)).toEqual([
      created.payload.session.sessionId,
    ]);

    for (const frame of [
      {
        type: 'get_history',
        payload: { sessionId: legacy.sessionId },
      },
      {
        type: 'subscribe',
        payload: { sessionId: mismatched.sessionId },
      },
      {
        type: 'cancel',
        payload: { sessionId: legacy.sessionId },
      },
      {
        type: 'rename_session',
        payload: { sessionId: mismatched.sessionId, title: '越权改名' },
      },
    ]) {
      const previousErrors = client.frames.filter(
        (item) =>
          item.type === 'error' &&
          item.payload.code === 'forbidden_session',
      ).length;
      client.send(frame);
      await client.waitFor(
        (item) =>
          item.type === 'error' &&
          item.payload.code === 'forbidden_session' &&
          client.frames.filter(
            (seen) =>
              seen.type === 'error' &&
              seen.payload.code === 'forbidden_session',
          ).length > previousErrors,
      );
    }
    expect(server.store.getSession(mismatched.sessionId)?.title).toBe(
      '其它租户会话',
    );
    client.close();
  });

  it('续租同一身份不打断 runtime；身份安全指纹变化会 cancel、detach、dispose 并清队列', async () => {
    server.setAuthenticatedEnterpriseAccount(authenticatedAccount());
    const session = server.store.createSession({
      title: '旧身份上下文',
      productEdition: 'enterprise',
      enterpriseAccountId: 'central-account-1',
      enterpriseOrganizationId: 'central-org-1',
    });
    const runtime = {
      run: vi.fn(async () => undefined),
      cancel: vi.fn(),
      setModel: vi.fn(),
      resolveToolConfirmation: vi.fn(),
      getConfig: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
    };
    server.store.attachRuntime(session.sessionId, runtime);
    const queues = (
      server as unknown as {
        messageQueues: Map<string, unknown[]>;
      }
    ).messageQueues;
    queues.set(session.sessionId, [{}]);

    server.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        leaseExpiresAt: '2099-01-01T00:05:00.000Z',
      }),
    );
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(server.store.getRuntime(session.sessionId)).toBe(runtime);

    server.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        name: '林一（新身份资料）',
        leaseExpiresAt: '2099-01-01T00:05:00.000Z',
      }),
    );
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledOnce());
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(server.store.getRuntime(session.sessionId)).toBeUndefined();
    expect(server.store.getSession(session.sessionId)?.status).toBe('idle');
    expect(queues.size).toBe(0);
  });

  it('中心身份 lease 到期会主动销毁 runtime，且会话列表与会话操作立即 fail closed', async () => {
    server.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        leaseExpiresAt: new Date(Date.now() + 120).toISOString(),
      }),
    );
    const session = server.store.createSession({
      title: '即将过期',
      productEdition: 'enterprise',
      enterpriseAccountId: 'central-account-1',
      enterpriseOrganizationId: 'central-org-1',
    });
    const runtime = {
      run: vi.fn(async () => undefined),
      cancel: vi.fn(),
      setModel: vi.fn(),
      resolveToolConfirmation: vi.fn(),
      getConfig: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
    };
    server.store.attachRuntime(session.sessionId, runtime);
    const client = await connectWs(baseUrl);

    await vi.waitFor(
      () => expect(runtime.dispose).toHaveBeenCalledOnce(),
      { timeout: 2_000 },
    );
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(server.store.getRuntime(session.sessionId)).toBeUndefined();

    client.send({ type: 'list_sessions', payload: {} });
    const listed = await client.waitFor((frame) => frame.type === 'sessions_list');
    if (listed.type !== 'sessions_list') throw new Error('unreachable');
    expect(listed.payload.sessions).toEqual([]);

    client.send({
      type: 'get_history',
      payload: { sessionId: session.sessionId },
    });
    const denied = await client.waitFor(
      (frame) =>
        frame.type === 'error' &&
        frame.payload.code === 'forbidden_session' &&
        frame.payload.sessionId === session.sessionId,
    );
    expect(denied.type).toBe('error');
    client.close();
  });

  it('WS 升级必须使用独立 client token，并拒绝 Origin:null', async () => {
    expect(Buffer.from(server.clientToken, 'base64url')).toHaveLength(32);
    expect(server.clientToken).not.toBe(server.controlToken);
    const wsBase = baseUrl.replace('http', 'ws') + '/ws';
    const rejectedStatus = (
      url: string,
      options?: ConstructorParameters<typeof WebSocket>[1],
    ): Promise<number> =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url, options);
        socket.once('open', () => {
          socket.close();
          reject(new Error('WS 不应建立成功'));
        });
        socket.once('unexpected-response', (_request, response) => {
          resolve(response.statusCode ?? 0);
          socket.terminate();
        });
        socket.once('error', (error) => reject(error));
      });

    await expect(rejectedStatus(wsBase)).resolves.toBe(401);
    await expect(
      rejectedStatus(`${wsBase}?clientToken=wrong-token`),
    ).resolves.toBe(401);
    await expect(
      rejectedStatus(
        `${wsBase}?clientToken=${encodeURIComponent(server.clientToken)}`,
        { origin: 'null' },
      ),
    ).resolves.toBe(401);
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

  it('内置浏览器页只注入 WS clientToken，不回显 controlToken', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(encodeURIComponent(server.clientToken));
    expect(html).not.toContain(server.controlToken);
    expect(html).toContain('/ws?clientToken=');
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

  it('未订阅的新飞书会话也向桌面全局通知一次，且不泄漏会话消息流', async () => {
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');

    const session = server.store.createSession({
      source: 'feishu',
      title: '项目群',
      feishuChatId: 'oc_new_member',
    });
    const message = server.store.appendMessage(session.sessionId, {
      id: 'feishu-message-1',
      role: 'user',
      content: [{ type: 'text', value: '新成员发来消息' }],
      source: 'feishu',
    });
    server.store.publish(session.sessionId, {
      type: 'message_start',
      payload: { message },
    });

    const notification = await c.waitFor(
      (frame) => frame.type === 'external_inbound_notification',
    );
    expect(notification).toEqual({
      type: 'external_inbound_notification',
      payload: {
        messageId: 'feishu-message-1',
        sessionId: session.sessionId,
        source: 'feishu',
        sender: '项目群',
        preview: '新成员发来消息',
      },
    });
    expect(c.frames.filter((frame) => frame.type === 'external_inbound_notification')).toHaveLength(1);
    expect(c.frames.filter((frame) => frame.type === 'message_start')).toHaveLength(0);
    expect(c.frames).toContainEqual({
      type: 'session_upsert',
      payload: { session: server.store.getSession(session.sessionId) },
    });
    c.close();
  });

  it('当前企业身份不广播 legacy 或其他租户会话的入站通知', async () => {
    server.setAuthenticatedEnterpriseAccount({
      id: 'notification-account',
      organizationId: 'notification-org',
      organizationName: '当前企业',
      name: '当前成员',
      isAdmin: false,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      role: 'member',
      tags: [],
    });
    const c = await connectWs(baseUrl);
    await c.waitFor((f) => f.type === 'welcome');

    const forbiddenSessions = [
      server.store.createSession({
        source: 'feishu',
        title: '未绑定旧会话',
        feishuChatId: 'oc_legacy_forbidden',
      }),
      server.store.createSession({
        source: 'feishu',
        title: '其他租户会话',
        feishuChatId: 'oc_other_tenant',
        enterpriseAccountId: 'other-account',
        enterpriseOrganizationId: 'other-org',
      }),
    ];
    for (const [index, session] of forbiddenSessions.entries()) {
      const message = server.store.appendMessage(session.sessionId, {
        id: `forbidden-external-${index}`,
        role: 'user',
        content: [{ type: 'text', value: '不应泄漏的内容' }],
        source: 'feishu',
      });
      server.store.publish(session.sessionId, {
        type: 'message_start',
        payload: { message },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      c.frames.filter((frame) => frame.type === 'external_inbound_notification'),
    ).toHaveLength(0);
    expect(
      c.frames.filter(
        (frame) =>
          frame.type === 'session_upsert'
          && forbiddenSessions.some(
            (session) => session.sessionId === frame.payload.session.sessionId,
          ),
      ),
    ).toHaveLength(0);
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
    c.send({ type: 'list_sessions', payload: {} });
    await c.waitFor((f) => f.type === 'sessions_list');
    expect(c.frames.some((f) => f.type === 'session_created')).toBe(false);
    c.close();
  });

  it('create_session 携带 clientRequestId 时仅向创建连接发送 session_created', async () => {
    const creator = await connectWs(baseUrl);
    const observer = await connectWs(baseUrl);
    await creator.waitFor((f) => f.type === 'welcome');
    await observer.waitFor((f) => f.type === 'welcome');

    creator.send({
      type: 'create_session',
      payload: { title: '精确选中', clientRequestId: 'create-request-1' },
    });

    const creatorUpsert = await creator.waitFor((f) => f.type === 'session_upsert');
    const observerUpsert = await observer.waitFor((f) => f.type === 'session_upsert');
    const created = await creator.waitFor((f) => f.type === 'session_created');
    if (
      creatorUpsert.type !== 'session_upsert' ||
      observerUpsert.type !== 'session_upsert' ||
      created.type !== 'session_created'
    ) {
      throw new Error('unreachable');
    }
    expect(observerUpsert.payload.session).toEqual(creatorUpsert.payload.session);
    expect(created.payload).toEqual({
      session: creatorUpsert.payload.session,
      clientRequestId: 'create-request-1',
    });

    observer.send({ type: 'list_sessions', payload: {} });
    await observer.waitFor((f) => f.type === 'sessions_list');
    expect(observer.frames.some((f) => f.type === 'session_created')).toBe(false);
    creator.close();
    observer.close();
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

  it('A2A tool-free runtime 不注入企业组织与职位上下文', async () => {
    let capturedWorkspaceContext: string | undefined;
    const runCompleted = vi.fn();
    const factory: RuntimeFactory = async (store, sessionId, _model, workspaceContext) => {
      capturedWorkspaceContext = workspaceContext;
      return {
        async run() {
          store.setStatus(sessionId, 'idle');
          runCompleted();
        },
        cancel() {},
        setModel() {},
        getConfig() { return undefined; },
        async dispose() {},
      };
    };
    const productWorkspaceStore = new ProductWorkspaceStore({
      rootDir: path.join(tmpHome, 'workspace-a2a-context'),
    });
    productWorkspaceStore.configureManager({
      managerName: '陈晨',
      companyName: '不应进入 A2A 提示的企业',
    });
    const store = new InMemorySessionStore();
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store,
      productWorkspaceStore,
    });
    const captureKnowledge = vi.spyOn(
      server as unknown as { captureKnowledgeAsync(sessionId: string): void },
      'captureKnowledgeAsync',
    );
    baseUrl = await startServer(server);
    const client = await connectWs(baseUrl);
    await client.waitFor((frame) => frame.type === 'welcome');
    client.send({
      type: 'create_session',
      payload: {
        title: 'A2A',
        agentProfileId: 'otto-enterprise-a2a',
        clientRequestId: 'a2a-test-request',
      },
    });
    const created = await client.waitFor(
      (frame) => frame.type === 'session_created'
        && frame.payload.clientRequestId === 'a2a-test-request',
    );
    if (created.type !== 'session_created') throw new Error('unreachable');
    const sessionId = created.payload.session.sessionId;
    expect(
      client.frames.some(
        (frame) => frame.type === 'session_upsert'
          && frame.payload.session.sessionId === sessionId,
      ),
    ).toBe(false);
    client.send({ type: 'list_sessions', payload: {} });
    const listed = await client.waitFor((frame) => frame.type === 'sessions_list');
    if (listed.type !== 'sessions_list') throw new Error('unreachable');
    expect(listed.payload.sessions.some((item) => item.sessionId === sessionId)).toBe(false);
    client.send({ type: 'subscribe', payload: { sessionId } });
    await client.waitFor(
      (frame) => frame.type === 'history' && frame.payload.sessionId === sessionId,
    );
    client.send({
      type: 'send_user_message',
      payload: {
        sessionId,
        content: [{ type: 'text', value: '只回答这个问题' }],
        source: 'local',
      },
    });
    await vi.waitFor(() => expect(capturedWorkspaceContext).toBe(''));
    await vi.waitFor(() => expect(runCompleted).toHaveBeenCalledOnce());
    expect(captureKnowledge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.getSession(sessionId)).toBeUndefined());
    client.close();
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

  it('ensureRuntime 创建期间身份指纹变化，创建完成后再次授权并销毁旧上下文', async () => {
    let releaseFactory!: () => void;
    const factoryStarted = vi.fn();
    const runtime: SessionRuntime = {
      run: vi.fn(async () => undefined),
      cancel: vi.fn(),
      setModel: vi.fn(),
      resolveToolConfirmation: vi.fn(),
      getConfig: vi.fn(() => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const factory: RuntimeFactory = async () => {
      factoryStarted();
      await new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      return runtime;
    };
    server = new OttoServer({
      port: 0,
      mock: false,
      runtimeFactory: factory,
      store: new InMemorySessionStore(),
      productWorkspaceStore: new ProductWorkspaceStore({
        rootDir: path.join(tmpHome, 'workspace-runtime-lease'),
      }),
    });
    server.setAuthenticatedEnterpriseAccount({
      id: 'account-a',
      organizationId: 'org-a',
      organizationName: '组织 A',
      name: '成员 A（身份资料已变化）',
      isAdmin: false,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    baseUrl = await startServer(server);
    const session = server.store.createSession({
      title: '租约竞态',
      productEdition: 'enterprise',
      enterpriseAccountId: 'account-a',
      enterpriseOrganizationId: 'org-a',
    });
    const client = await connectWs(baseUrl);
    client.send({
      type: 'send_user_message',
      payload: {
        sessionId: session.sessionId,
        content: [{ type: 'text', value: '开始' }],
        source: 'local',
      },
    });
    await vi.waitFor(() => expect(factoryStarted).toHaveBeenCalledOnce());

    server.setAuthenticatedEnterpriseAccount({
      id: 'account-a',
      organizationId: 'org-a',
      organizationName: '组织 A',
      name: '成员 A',
      isAdmin: false,
      leaseExpiresAt: '2099-01-01T00:05:00.000Z',
    });
    releaseFactory();
    await vi.waitFor(() =>
      expect(runtime.dispose).toHaveBeenCalledOnce(),
    );
    expect(runtime.cancel).toHaveBeenCalledOnce();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(server.store.getRuntime(session.sessionId)).toBeUndefined();
    client.close();
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

  // ── P0-1（断开/停机取消）与 busy 消息排队 ────────────────────────────────

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

  it('会话正忙（thinking）再来一条 → 入队等待，不立即落库或重复运行', async () => {
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
    const queuedFrame = await c.waitFor(
      (f) => f.type === 'message_queued',
    );
    expect(queuedFrame).toMatchObject({
      type: 'message_queued',
      payload: { sessionId: s.sessionId, queuePosition: 1 },
    });
    // 第二条只进入内存队列，当前轮结束前不落库、不重复驱动 runtime。
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

  it('偏好落盘失败时仍确认已经真实切换的 runtime 与会话模型', async () => {
    const client = await connectWs(baseUrl);
    await client.waitFor((frame) => frame.type === 'welcome');
    const { oldId, targetId } = await modelIds(client);
    const session = store.createSession({ title: '偏好落盘失败', model: oldId });
    const setModel = vi.fn(async () => undefined);
    store.attachRuntime(session.sessionId, fakeRuntime(setModel));

    // saveCustomModels 固定先写 custom-models.json.tmp；同名目录让落盘稳定失败，
    // 模拟磁盘/权限故障，又不依赖当前进程是否以高权限运行。
    fs.mkdirSync(path.join(tmpHome, '.otto-user', 'custom-models.json.tmp'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    client.send({
      type: 'set_model',
      payload: { sessionId: session.sessionId, model: targetId },
    });
    const confirmed = await client.waitFor(
      (frame) =>
        frame.type === 'models_list' && frame.payload.current === targetId,
    );

    expect(confirmed).toMatchObject({
      type: 'models_list',
      payload: { current: targetId },
    });
    expect(setModel).toHaveBeenCalledWith(targetId);
    expect(store.getSession(session.sessionId)?.model).toBe(targetId);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[model-switch] preference persistence failed'),
    );
    expect(
      client.frames.some(
        (frame) =>
          frame.type === 'error' && frame.payload.code === 'model_switch_failed',
      ),
    ).toBe(false);
    warn.mockRestore();
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

describe('OttoServer 搜索 API 配置接口', () => {
  let server: OttoServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new OttoServer({
      port: 0,
      mock: true,
      store: new InMemorySessionStore(),
    });
    baseUrl = await startServer(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('保存火山方舟配置后只返回 hasApiKey，不回传密钥原文', async () => {
    const client = await connectWs(baseUrl);
    client.send({
      type: 'save_search_config',
      payload: {
        provider: 'volcengine',
        apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
        model: 'doubao-seed-2-0-lite-260215',
        apiKey: 'ark-secret',
      },
    });
    const saved = await client.waitFor((f) => f.type === 'search_config');
    if (saved.type !== 'search_config') throw new Error('unreachable');
    expect(saved.payload).toEqual({
      provider: 'volcengine',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      model: 'doubao-seed-2-0-lite-260215',
      hasApiKey: true,
    });
    expect(JSON.stringify(saved)).not.toContain('ark-secret');

    client.send({ type: 'get_search_config', payload: {} });
    const fetched = await client.waitFor(
      (f) => f.type === 'search_config' && f !== saved,
    );
    expect(JSON.stringify(fetched)).not.toContain('ark-secret');
    client.close();
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
