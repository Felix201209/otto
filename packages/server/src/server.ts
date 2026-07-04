/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server：本地 HTTP + WS app server 骨架。
 *
 * 唯一会话源：所有客户端（desktop renderer / 未来 TUI 只读 / 飞书网关）都经
 * 这里读写同一份 SessionStore，并通过 WS 收到同一会话的实时广播。
 *
 * 本文件立「服务外壳 + 路由 + WS 收发分发 + registerFeishu 接缝」。
 * core 驱动（跑一轮对话）由 Issue #1 实装：把 SessionRuntime 接上后，
 * handleSendUserMessage 调 runtime.run() 即可，无需改本文件的分发结构。
 *
 * 参照：packages/core/src/auth/login/authServer.ts（OAuth 回调小 server 模式）。
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HTTP_ROUTES,
  PROTOCOL_VERSION,
  isClientToServer,
  validateClientPayload,
  type ApiResponse,
  type ClientToServer,
  type HealthInfo,
  type MessageContent,
  type ModelInfo,
  type ServerToClient,
} from './protocol.js';
import {
  InMemorySessionStore,
  type SessionRuntime,
  type SessionStore,
  type Unsubscribe,
} from './sessions.js';
import { registerFeishu, type FeishuRegistration } from './feishu/register.js';
import { createCoreConfig } from './coreConfig.js';
import { createCoreSessionRuntime } from './runtime.js';
import {
  listModelInfos,
  loadCustomModels,
  loadPreferredModel,
  saveCustomModel,
} from './customModels.js';
import type { CustomModelConfig } from 'otto-core';

/** server 版本（实装时可从 package.json 注入）。 */
const SERVER_VERSION = '0.1.0';

/** WS 单帧上限（10MB）：防超大帧打爆内存（图片引用 base64 也远小于此）。 */
const WS_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 会话运行时工厂：为某会话建并初始化一个 SessionRuntime。
 * 默认实现 = 包 otto-core（createCoreSessionRuntime）。可注入替换（测试 / mock）。
 */
export type RuntimeFactory = (
  store: SessionStore,
  sessionId: string,
  model: string | undefined,
) => Promise<SessionRuntime>;

/** 默认运行时工厂：构造 headless core Config 并包进 CoreSessionRuntime。 */
const defaultRuntimeFactory: RuntimeFactory = async (store, sessionId, model) => {
  const config = createCoreConfig({ sessionId, model });
  return createCoreSessionRuntime(store, sessionId, config);
};

export interface OttoServerOptions {
  host?: string;
  port?: number;
  /** 是否启用飞书网关（缺省读 env / credentials 探测）。 */
  enableFeishu?: boolean;
  store?: SessionStore;
  /**
   * 会话运行时工厂。缺省 = 包 otto-core 的真实运行时。
   * 注入自定义工厂用于测试或 mock 模式。
   */
  runtimeFactory?: RuntimeFactory;
  /**
   * 强制 mock 模式：不接 core，send_user_message 走占位回声。
   * 缺省 false；但若未配置任何模型（无 BYO-key 且无 env auth），会自动降级 mock，
   * 让无 key 的全新机器也能端到端验证收发链路。可被 env OTTO_SERVER_MOCK=1 置真。
   */
  mock?: boolean;
}

/**
 * 单个 WS 连接的会话上下文：持有该连接对各会话的订阅取消句柄，
 * 断开时统一清理。
 */
interface ClientConn {
  socket: WebSocket;
  subscriptions: Map<string, Unsubscribe>;
}

/**
 * OttoServer：可被 bin（start/stop/status）或 Electron 主进程内嵌拉起。
 */
export class OttoServer {
  readonly store: SessionStore;
  private readonly host: string;
  private readonly port: number;
  private readonly enableFeishu: boolean;
  private readonly startedAt = Date.now();
  private readonly runtimeFactory: RuntimeFactory;
  private readonly mock: boolean;
  /** 同一会话首次 send 时懒构建 runtime，用此 map 去重并发初始化。 */
  private readonly runtimeInit = new Map<string, Promise<SessionRuntime | undefined>>();

  private http?: HttpServer;
  private wss?: WebSocketServer;
  private feishu?: FeishuRegistration;
  private readonly conns = new Set<ClientConn>();

  constructor(opts: OttoServerOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port =
      opts.port ?? Number(process.env.OTTO_SERVER_PORT ?? DEFAULT_PORT);
    this.enableFeishu =
      opts.enableFeishu ?? process.env.OTTO_FEISHU_ENABLED === '1';
    this.store = opts.store ?? new InMemorySessionStore();
    this.runtimeFactory = opts.runtimeFactory ?? defaultRuntimeFactory;
    // mock 决策：显式 opts.mock 优先，否则看 env；都没有则按「是否配了模型」自动判定。
    this.mock = opts.mock ?? process.env.OTTO_SERVER_MOCK === '1';
  }

  /** 是否应走 mock（无 core）：显式 mock，或机器上没有任何 BYO-key 模型。 */
  private shouldMock(): boolean {
    if (this.mock) return true;
    // 无任何自定义模型（且无 env auth）时降级 mock，让无 key 机器也能验证收发链路。
    try {
      // 与 coreConfig 的 enabled 过滤口径一致：全部 enabled:false 也视为「无可用模型」走 mock，
      // 避免真实 runtime 以 model=undefined 初始化（code review HIGH）。
      return loadCustomModels().filter((m) => m.enabled !== false).length === 0;
    } catch {
      return true;
    }
  }

  /** 启动 HTTP + WS，并按需注册飞书网关。 */
  async start(): Promise<void> {
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.http,
      path: HTTP_ROUTES.ws,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: (info: { req: IncomingMessage }) =>
        this.isLocalRequestAllowed(info.req),
    });
    this.wss.on('connection', (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, this.host, () => resolve());
    });

    if (this.enableFeishu) {
      // ── registerFeishu 接缝（Issue #3）──
      // 飞书网关迁入 server：gateway.onMessage → store.getOrCreateFeishuSession +
      // appendMessage(source:'feishu') + publish；app→飞书回推走 registration.pushToFeishu。
      this.feishu = await registerFeishu({
        store: this.store,
        broadcast: (sessionId, frame) => this.store.publish(sessionId, frame),
      });
    }
  }

  /** 停止服务（取消并释放所有活跃 runtime，再关 WS、HTTP、飞书）。 */
  async stop(): Promise<void> {
    await this.feishu?.stop().catch(() => undefined);
    // 停机不留孤儿轮次：cancel + dispose 所有已 attach 的 runtime，
    // 否则 server 关了 agent 还在后台烧 token / 跑工具（maxTurns=-1 不限回合）。
    await Promise.all(
      this.store.listSessions().map(async (s) => {
        const runtime = this.store.getRuntime(s.sessionId);
        if (!runtime) return;
        runtime.cancel();
        await runtime.dispose().catch(() => undefined);
      }),
    );
    for (const c of this.conns) c.socket.close();
    this.conns.clear();
    await new Promise<void>((resolve) =>
      this.wss ? this.wss.close(() => resolve()) : resolve(),
    );
    await new Promise<void>((resolve) =>
      this.http ? this.http.close(() => resolve()) : resolve(),
    );
  }

  /** 运行期状态（status 命令 / /health 复用）。 */
  health(): HealthInfo {
    return {
      status: 'ok',
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      sessionCount: this.store.listSessions().length,
      feishu: {
        enabled: this.enableFeishu,
        connected: this.feishu?.isConnected() ?? false,
      },
    };
  }

  get endpoint(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  /** 可用模型列表（BYO-key 自定义模型）。/models 与 get_models 共用。 */
  private modelInfos(): ModelInfo[] {
    try {
      return listModelInfos();
    } catch {
      return [];
    }
  }

  /**
   * 当前生效模型 id（与 createCoreConfig 的兜底次序一致）：
   *   preferredModel（makeActive 写入，且仍在 enabled 列表里）→ 否则首个 enabled 模型。
   * 供 get_models 回包填 current，让 renderer 模型药丸/菜单勾号反映真实生效模型，
   * 而非长期回退到硬编码名。无任何模型时返回 undefined。
   */
  private currentModel(): string | undefined {
    const enabled = this.modelInfos().filter((m) => m.enabled);
    if (enabled.length === 0) return undefined;
    let preferred: string | undefined;
    try {
      preferred = loadPreferredModel();
    } catch {
      preferred = undefined;
    }
    if (preferred && enabled.some((m) => m.id === preferred)) {
      return preferred;
    }
    return enabled[0].id;
  }

  /**
   * setup 落盘（save_custom_model 帧）：
   *   校验 → 复用 customModels.saveCustomModel 原子写盘（CLI 同格式）
   *   → 成功广播最新 models_list（含 current）；失败回 error(code:'save_failed')。
   *
   * 广播用 broadcastAll：多窗口（及未来只读 TUI 视图）同步刷新模型列表。
   * makeActive：server 端真正实现——写盘时把该模型设为「当前生效模型」
   * （customModels 的 preferredModel 单一事实源），createCoreConfig 优先用它，
   * 广播 models_list 时带 current，让 renderer 模型药丸/菜单勾号反映真实生效模型。
   */
  private handleSaveCustomModel(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'save_custom_model' }>,
  ): void {
    const p = msg.payload;
    // 服务端二次校验 baseUrl 格式（客户端校验不可信；防止 file:// 等非 http(s) scheme
    // 被写入用户配置 ~/.otto-user/custom-models.json，code review HIGH）。
    if (!/^https?:\/\//i.test((p.baseUrl ?? '').trim())) {
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'save_failed',
          message: '保存失败：baseUrl 必须是 http(s):// 开头的绝对地址',
        },
      });
      return;
    }
    // 批量：modelIds 非空 → 同 provider/baseUrl/key 下一次加入多个模型（共享 key），
    // 每条 displayName 取其 modelId；否则退回单个 modelId（保留用户填的 displayName）。
    const batchIds =
      Array.isArray(p.modelIds) && p.modelIds.length > 0
        ? p.modelIds.map((s) => s.trim()).filter(Boolean)
        : null;
    const ids = batchIds ?? [p.modelId];
    const buildModel = (mid: string): CustomModelConfig =>
      ({
        // 批量时用 modelId 作显示名；单个时保留用户填的 displayName。
        displayName: batchIds ? mid : (p.displayName ?? '').trim() || p.modelId,
        provider: p.provider as CustomModelConfig['provider'],
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        modelId: mid,
        ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
        enabled: p.enabled !== false,
      }) as CustomModelConfig;

    try {
      // 写盘（内部再次校验，非法即抛）。makeActive 缺省视为 true（向导默认即用新模型）。
      // 批量时只把列表第一个设为当前生效模型。
      const makeActive = p.makeActive !== false;
      let firstId: string | undefined;
      for (let i = 0; i < ids.length; i++) {
        const savedId = saveCustomModel(buildModel(ids[i]), makeActive && i === 0);
        if (i === 0) firstId = savedId;
      }
      // 写成功 → 广播最新模型列表（modelInfos 每次实时 loadCustomModels）。
      // makeActive 时带 current=首个模型，让 renderer 立刻把药丸切到它。
      this.broadcastAll({
        type: 'models_list',
        payload: {
          models: this.modelInfos(),
          ...(makeActive && firstId ? { current: firstId } : {}),
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: { code: 'save_failed', message: `保存自定义模型失败：${message}` },
      });
    }
  }

  /**
   * 切换会话模型（set_model 帧）：
   *   校验目标模型「存在且 enabled」→ 更新会话摘要 + 即时切已存在的 runtime
   *   → 回发一帧 models_list（带 current），让 renderer 的模型药丸反映真实生效模型。
   * 非法模型（不存在 / 被禁用）→ 回 error(code:'unknown_model')，不污染会话摘要与 runtime。
   */
  private handleSetModel(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'set_model' }>,
  ): void {
    const { sessionId, model } = msg.payload;
    const known = this.modelInfos().find((m) => m.id === model && m.enabled);
    if (!known) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'unknown_model', `未知或未启用的模型：${model}`),
      );
    }
    // 既更新会话摘要（让懒构建的 runtime 用对模型），也即时切换已存在的 runtime。
    this.store.patchSessionModel(sessionId, model);
    this.store.getRuntime(sessionId)?.setModel(model);
    // 回发带 current 的 models_list，让 renderer 模型药丸/菜单勾号反映真实生效模型。
    this.send(conn.socket, {
      type: 'models_list',
      payload: { models: this.modelInfos(), current: model },
    });
  }

  /**
   * 删除会话（delete_session 帧，不可逆）：
   *   校验会话存在 → 取消该会话正在跑的轮次（止损，别让删掉的会话继续烧 token）
   *   → store.deleteSession（内部 dispose runtime + 清 feishuIndex + 从表移除）
   *   → 广播最新 sessions_list（权威快照：多窗口据此同步移除该会话行）。
   * 会话不存在 → 回 error(code:'no_session')，不广播。
   */
  private async handleDeleteSession(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'delete_session' }>,
  ): Promise<void> {
    const { sessionId } = msg.payload;
    if (!this.store.getSession(sessionId)) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    // 先取消当前轮：deleteSession 只 dispose，不 cancel；正在跑的轮次要显式止损。
    this.store.getRuntime(sessionId)?.cancel();
    await this.store.deleteSession(sessionId);
    // 广播权威快照，让所有客户端把这条会话从列表里剔除（sessions_list 现在是快照语义）。
    this.broadcastAll({
      type: 'sessions_list',
      payload: { sessions: this.store.listSessions() },
    });
  }

  /**
   * 重命名会话（rename_session 帧）：
   *   校验会话存在 → store.renameSession（trim + 截断兜底，改 title + publish
   *   session_upsert 给订阅者）→ 再 broadcastAll 一帧 session_upsert，让未订阅该
   *   会话的其它窗口的列表也即时更新标题。
   * 会话不存在 / 兜底后为空 → 回 error(code:'no_session')。
   */
  private handleRenameSession(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'rename_session' }>,
  ): void {
    const { sessionId, title } = msg.payload;
    const updated = this.store.renameSession(sessionId, title);
    if (!updated) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    // renameSession 已 publish 给该会话订阅者；再全局广播一帧，覆盖未订阅它的窗口列表。
    this.broadcastAll({
      type: 'session_upsert',
      payload: { session: updated },
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // HTTP REST
  // ──────────────────────────────────────────────────────────────────────

  /**
   * 本地 app server 防滥用闸门：仅放行本机/Electron 自身的连接，拒绝任意网页
   * 经 DNS-rebinding 或 localhost WebSocket 无鉴权驱动本 server（越权跑工具/读历史）。
   * - Origin：浏览器对 ws 握手与跨源 http 必带 Origin 且无法伪造。放行 无 Origin（Node 客户端
   *   如 TUI）、`null`/`file://`（Electron file:// 渲染层）、localhost/127.0.0.1（本地 dev/工具）；
   *   其余 http(s):// 网页来源一律拒。
   * - Host：要求主机名是 localhost/127.0.0.1/[::1]，挡 DNS-rebinding。
   */
  private isLocalRequestAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !origin.startsWith('file://')) {
      try {
        const h = new URL(origin).hostname;
        if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return false;
      } catch {
        return false;
      }
    }
    const hostHeader = req.headers.host;
    if (hostHeader) {
      const h = hostHeader.startsWith('[')
        ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
        : hostHeader.split(':')[0];
      if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') return false;
    }
    return true;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!this.isLocalRequestAllowed(req)) {
      return sendJson(res, 403, err('forbidden'));
    }
    const url = new URL(req.url ?? '/', `http://${this.host}:${this.port}`);
    const path = url.pathname;

    if (path === HTTP_ROUTES.health) {
      return sendJson(res, 200, ok(this.health()));
    }
    if (path === HTTP_ROUTES.sessions && req.method === 'GET') {
      return sendJson(res, 200, ok(this.store.listSessions()));
    }
    if (path === HTTP_ROUTES.sessions && req.method === 'POST') {
      const summary = this.store.createSession();
      this.broadcastAll({ type: 'session_upsert', payload: { session: summary } });
      return sendJson(res, 201, ok(summary));
    }
    const histMatch = path.match(/^\/sessions\/([^/]+)\/history$/);
    if (histMatch && req.method === 'GET') {
      const limit = url.searchParams.has('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
      return sendJson(res, 200, ok(this.store.getHistory(histMatch[1], limit)));
    }
    if (path === HTTP_ROUTES.models && req.method === 'GET') {
      return sendJson(res, 200, ok(this.modelInfos()));
    }

    sendJson(res, 404, err('not_found'));
  }

  // ──────────────────────────────────────────────────────────────────────
  // WS 连接 + 帧分发
  // ──────────────────────────────────────────────────────────────────────

  private handleConnection(socket: WebSocket): void {
    const conn: ClientConn = { socket, subscriptions: new Map() };
    this.conns.add(conn);

    this.send(socket, {
      type: 'welcome',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
      },
    });

    socket.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(socket, errorFrame(undefined, 'bad_json', '无法解析的帧'));
      }
      if (!isClientToServer(msg)) {
        return this.send(
          socket,
          errorFrame(undefined, 'bad_frame', '未知帧形态'),
        );
      }
      // 第二道闸：按 type 校验 payload 形状（含未知 type）。
      // 畸形 payload 在此拒绝、零副作用，不会先落库再炸（脏数据）。
      const invalid = validateClientPayload(msg);
      if (invalid) {
        return this.send(socket, errorFrame(undefined, 'bad_payload', invalid));
      }
      this.dispatch(conn, msg).catch((e) => {
        this.send(
          socket,
          errorFrame(undefined, 'internal', String(e instanceof Error ? e.message : e)),
        );
      });
    });

    socket.on('close', () => {
      const subscribedIds = [...conn.subscriptions.keys()];
      for (const unsub of conn.subscriptions.values()) unsub();
      conn.subscriptions.clear();
      this.conns.delete(conn);
      // 断开即止损：该连接订阅过的会话若已无其他存活连接在看，取消其正在跑的轮次
      // （否则关窗后 agent 继续烧 token；maxTurns=-1 不限回合）。
      for (const sessionId of subscribedIds) {
        this.cancelIfOrphaned(sessionId);
      }
    });
  }

  /**
   * 若会话已无任何存活 WS 连接订阅、且未绑定飞书，则取消其 runtime 当前轮。
   * 飞书驱动的会话（feishuChatId 非空）不因桌面端断开而取消——飞书侧还在等回复。
   */
  private cancelIfOrphaned(sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session || session.feishuChatId) return;
    for (const c of this.conns) {
      if (c.subscriptions.has(sessionId)) return;
    }
    this.store.getRuntime(sessionId)?.cancel();
  }

  /** 把一帧 ClientToServer 分发到对应处理。 */
  private async dispatch(conn: ClientConn, msg: ClientToServer): Promise<void> {
    switch (msg.type) {
      case 'hello':
        // 握手已由 welcome 回应；此处可校验 protocolVersion（TODO 版本协商）。
        return;
      case 'list_sessions':
        return this.send(conn.socket, {
          type: 'sessions_list',
          payload: { sessions: this.store.listSessions() },
        });
      case 'get_history':
        return this.send(conn.socket, {
          type: 'history',
          payload: {
            sessionId: msg.payload.sessionId,
            messages: this.store.getHistory(
              msg.payload.sessionId,
              msg.payload.limit,
              msg.payload.before,
            ),
          },
        });
      case 'subscribe':
        return this.subscribeConn(conn, msg.payload.sessionId);
      case 'unsubscribe': {
        const unsub = conn.subscriptions.get(msg.payload.sessionId);
        unsub?.();
        conn.subscriptions.delete(msg.payload.sessionId);
        return;
      }
      case 'create_session': {
        const summary = this.store.createSession({
          title: msg.payload.title,
          model: msg.payload.model,
        });
        this.broadcastAll({
          type: 'session_upsert',
          payload: { session: summary },
        });
        return;
      }
      case 'send_user_message':
        return this.handleSendUserMessage(conn, msg);
      case 'set_model':
        return this.handleSetModel(conn, msg);
      case 'cancel': {
        this.store.getRuntime(msg.payload.sessionId)?.cancel();
        return;
      }
      case 'tool_confirmation_response':
        // 当前 runtime 走 executeToolCall（YOLO，不上抛确认），无待确认队列可路由。
        // 带确认的工具调度（CoreToolScheduler.handleConfirmationResponse）是后续增强，
        // 届时在此把 outcome 路由进 runtime 的 scheduler。
        // TODO(tool-confirm): runtime 暴露 confirmTool(callId, outcome) 后接线。
        return;
      case 'get_models':
        return this.send(conn.socket, {
          type: 'models_list',
          payload: { models: this.modelInfos(), current: this.currentModel() },
        });
      case 'save_custom_model':
        return this.handleSaveCustomModel(conn, msg);
      case 'delete_session':
        return this.handleDeleteSession(conn, msg);
      case 'rename_session':
        return this.handleRenameSession(conn, msg);
      default: {
        // 穷尽检查：新增 ClientToServer 分支时编译会在这里提示。
        const _exhaustive: never = msg;
        void _exhaustive;
        return;
      }
    }
  }

  /**
   * 用户消息入口（app→server）：落库 user 消息 + 广播，然后驱动一轮回复。
   * - mock 模式（无 core / 无 BYO-key）：回占位回声，验证收发链路。
   * - 实装模式：懒构建会话 runtime（包 otto-core），runtime.run 跑一整轮，
   *   流式/工具事件由 runtime 内部 publish 广播给所有订阅者。
   */
  private async handleSendUserMessage(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'send_user_message' }>,
  ): Promise<void> {
    const { sessionId, content, source, clientMessageId } = msg.payload;
    const session = this.store.getSession(sessionId);
    if (!session) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }

    // 会话正忙（thinking/streaming）：直接回 busy 错误帧，不落库不广播。
    // 否则消息落了库、runtime.run 又拒绝这一轮，留下一条永远没有回复的消息。
    if (session.status === 'thinking' || session.status === 'streaming') {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'busy', '该会话正在生成回复，请稍候或先取消。'),
      );
    }

    // 透传 clientMessageId 作为消息 id：让 message_start 回声的 id 与 renderer
    // 乐观渲染的临时 id 一致，store 按 id 覆盖去重，避免用户气泡重复显示两条。
    const userMsg = this.store.appendMessage(sessionId, {
      role: 'user',
      content,
      source,
      ...(clientMessageId ? { id: clientMessageId } : {}),
    });
    this.store.publish(sessionId, {
      type: 'message_start',
      payload: { message: userMsg },
    });

    // app→飞书 回推：用户在 app 里对一个飞书会话手敲的这句话，回推飞书侧。
    // 只推用户输入这一句；AI 回复仍由 streamBridge 自动回推，勿在此重复。
    if (
      source === 'local' &&
      session.source === 'feishu' &&
      session.feishuChatId
    ) {
      void this.pushUserMessageToFeishu(
        sessionId,
        session.feishuChatId,
        userMsg.id,
        content,
      );
    }

    // mock 模式（无 core / 无 key）：占位回声，验证收发链路。
    if (this.shouldMock()) {
      await this.mockEcho(sessionId);
      return;
    }

    // 实装路径：首次 send 时懒构建并 attach runtime（包 otto-core）。
    const runtime = await this.ensureRuntime(sessionId);
    if (!runtime) {
      // 初始化失败（如鉴权未配）：已在 ensureRuntime 内发过 error 帧，这里收口。
      this.store.setStatus(sessionId, 'idle');
      return;
    }
    // core 驱动一轮，流式事件由 runtime 内部 publish 广播。
    await runtime.run(content, source);
  }

  /**
   * app→飞书 回推：把 app 内对飞书会话的用户发言推回飞书，并广播 feishu_push_result
   * 帧（ok/error），让 renderer 对账同步状态（成功/失败均反馈，不再静默）。
   *
   * 失败不抛、不阻断主对话流：仅把失败经 feishu_push_result(ok:false) 上报。
   */
  private async pushUserMessageToFeishu(
    sessionId: string,
    feishuChatId: string,
    messageId: string,
    content: MessageContent,
  ): Promise<void> {
    const text = plainTextOf(content);
    if (!text) return;
    if (!this.feishu) {
      this.store.publish(sessionId, {
        type: 'feishu_push_result',
        payload: {
          sessionId,
          feishuChatId,
          messageId,
          ok: false,
          error: '飞书网关未启用，无法回推。',
        },
      });
      return;
    }
    try {
      await this.feishu.pushToFeishu(feishuChatId, text);
      this.store.publish(sessionId, {
        type: 'feishu_push_result',
        payload: { sessionId, feishuChatId, messageId, ok: true },
      });
    } catch (e) {
      this.store.publish(sessionId, {
        type: 'feishu_push_result',
        payload: {
          sessionId,
          feishuChatId,
          messageId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  /**
   * 懒构建会话 runtime（去重并发初始化）。
   * 已 attach 直接返回；否则经 runtimeFactory 建并 attach。
   * 初始化失败时发 error 帧并返回 undefined（不抛，避免拖垮 WS 分发）。
   */
  private async ensureRuntime(
    sessionId: string,
  ): Promise<SessionRuntime | undefined> {
    const existing = this.store.getRuntime(sessionId);
    if (existing) return existing;

    const inFlight = this.runtimeInit.get(sessionId);
    if (inFlight) return inFlight;

    const summary = this.store.getSession(sessionId);
    const model = summary?.model;
    const task = (async (): Promise<SessionRuntime | undefined> => {
      try {
        const runtime = await this.runtimeFactory(this.store, sessionId, model);
        this.store.attachRuntime(sessionId, runtime);
        return runtime;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.store.publish(sessionId, {
          type: 'error',
          payload: {
            sessionId,
            code: 'runtime_init_failed',
            message: `会话运行时初始化失败：${message}`,
          },
        });
        this.store.setStatus(sessionId, 'error');
        return undefined;
      } finally {
        this.runtimeInit.delete(sessionId);
      }
    })();
    this.runtimeInit.set(sessionId, task);
    return task;
  }

  /** mock：core 未接时回一条占位流式回复，验证收发链路。实装后删。 */
  private async mockEcho(sessionId: string): Promise<void> {
    this.store.setStatus(sessionId, 'streaming');
    const assistant = this.store.appendMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    this.store.publish(sessionId, {
      type: 'message_start',
      payload: { message: assistant },
    });
    const text =
      '（mock）otto-server 已就绪，core 驱动尚未接入（Issue #1）。收发链路 OK。';
    this.store.publish(sessionId, {
      type: 'chat_chunk',
      payload: { sessionId, messageId: assistant.id, delta: text },
    });
    this.store.patchMessage(sessionId, assistant.id, {
      content: [{ type: 'text', value: text }],
      isStreaming: false,
    });
    this.store.publish(sessionId, {
      type: 'chat_complete',
      payload: { sessionId, messageId: assistant.id },
    });
    this.store.setStatus(sessionId, 'idle');
  }

  private subscribeConn(conn: ClientConn, sessionId: string): void {
    if (conn.subscriptions.has(sessionId)) return;
    if (!this.store.getSession(sessionId)) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    const unsub = this.store.subscribe(sessionId, (frame) =>
      this.send(conn.socket, frame),
    );
    conn.subscriptions.set(sessionId, unsub);
    // 订阅即回灌历史，便于 UI 恢复。
    this.send(conn.socket, {
      type: 'history',
      payload: { sessionId, messages: this.store.getHistory(sessionId) },
    });
  }

  /** 广播给所有连接（与会话订阅无关的全局帧，如 session_upsert）。 */
  private broadcastAll(frame: ServerToClient): void {
    for (const c of this.conns) this.send(c.socket, frame);
  }

  private send(socket: WebSocket, frame: ServerToClient): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }
}

// ── helpers ──

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data, error: null };
}
function err(message: string): ApiResponse<null> {
  return { ok: false, data: null, error: message };
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}
function errorFrame(
  sessionId: string | undefined,
  code: string,
  message: string,
): ServerToClient {
  return { type: 'error', payload: { sessionId, code, message } };
}
/**
 * 从富消息内容里取纯文本（用于 app→飞书 回推）。
 * 只回推用户实际敲的文字片段；文件/图片等引用片段不回推（飞书侧仅需文字）。
 */
function plainTextOf(content: MessageContent): string {
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.value : ''))
    .join('\n')
    .trim();
}
