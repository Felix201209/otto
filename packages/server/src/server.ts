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
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
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
  type FeishuConfigPublic,
  type FeishuConfigSaveRequest,
  type FeishuHealthStatus,
  type HealthInfo,
  type MessageContent,
  type MessageSource,
  type ModelInfo,
  type ServerToClient,
  type SettingsSnapshot,
  type McpServerInfo,
  type StatsSnapshot,
  type DoctorReportInfo,
  type TodoItemInfo,
  type MemoryFileInfo,
  type SkillSummary,
  type ToolSummary,
  type WorkflowSummary,
  type WorkflowAgentSummary,
  type ExtensionSummary,
  type AutoSkillCandidateInfo,
} from './protocol.js';
import { ProductWorkspaceStore } from './productWorkspaceStore.js';
import { resolveAgentProfile } from './agentProfiles.js';
import {
  InMemorySessionStore,
  type SessionRuntime,
  type SessionStore,
  type Unsubscribe,
} from './sessions.js';
import {
  registerFeishu,
  type FeishuRegisterDeps,
  type FeishuRegistration,
} from './feishu/register.js';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  type FeishuCredentials,
} from './feishu/vendor/credentials.js';
import { createCoreConfig, resolveDefaultCwd } from './coreConfig.js';
import { createCoreSessionRuntime } from './runtime.js';
import { executeSlashCommand, listSlashCommands } from './commands/index.js';
import {
  deleteCustomModel,
  listModelInfos,
  loadCustomModels,
  loadPreferredModel,
  replaceCustomModel,
  saveCustomModel,
} from './customModels.js';
import {
  loadUserSettingsSubset,
  patchUserSettings,
  loadMcpServers,
  saveMcpServers,
} from './userSettings.js';
import {
  ProjectSettingsManager,
  DoctorService,
  uiTelemetryService,
  todoStore,
  tokenLimit,
  getCoreSystemPrompt,
  MCPServerConfig,
  getAllMCPServerStatuses,
  MCPServerStatus,
  MemoryTool,
  OTTO_CONFIG_DIR,
  DEFAULT_CONTEXT_FILENAME,
  SkillsCompatAdapter,
  WorkflowRegistry,
  createLocalSchedule,
  updateLocalSchedule,
  deleteLocalSchedule,
  listLocalSchedules,
  subscribeLocalSchedules,
  listPendingSkillCandidates,
  confirmPendingSkill,
  rejectPendingSkill,
  startAutoSkillScanner,
  stopAutoSkillScanner,
  type WorkflowAgentRecord,
  type SkillCandidate,
  type Config as CoreConfig,
  LocalKnowledgeStore,
  type KnowledgeEntry,
  KnowledgeCapture,
  type SimpleMessage,
  getKnowledgeDir,
  getSessionManager,
  getAutoMemoryEngine,
} from 'otto-core';
import type { CustomModelConfig } from 'otto-core';

/** server 版本（实装时可从 package.json 注入）。 */
const SERVER_VERSION = '0.1.0';

/** WS 单帧上限（10MB）：防超大帧打爆内存（图片引用 base64 也远小于此）。 */
const WS_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

/** 自动压缩最小消息数：会话消息超过此阈值 + 处于 idle 状态时触发自动压缩。 */
const AUTO_COMPRESS_MIN_MESSAGES = 30;

/** 后台维护周期（ms）：记忆合并/压缩 + 上下文自动压缩。 */
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

function publicAutoSkillCandidate(
  candidate: SkillCandidate,
): AutoSkillCandidateInfo {
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    detectedPattern: candidate.detectedPattern,
    occurrenceCount: candidate.occurrenceCount,
    reason: candidate.reason,
  };
}

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
const defaultRuntimeFactory: RuntimeFactory = async (
  store,
  sessionId,
  model,
) => {
  const summary = store.getSession(sessionId);
  const profile = resolveAgentProfile(summary?.agentProfileId);
  const config = createCoreConfig({
    sessionId,
    // 内部测试阶段一律 BYOK。旧企业会话可能持有 otto:*，交给 coreConfig
    // 回退到 preferred/首个个人模型，不能再进入尚未上线的中转站路径。
    model: model?.startsWith('otto:') ? undefined : model,
    feishuMode: Boolean(summary?.feishuChatId),
    ...(profile ? { userRules: profile.systemPrompt } : {}),
    ...(summary?.productEdition !== 'enterprise'
      ? {
          excludeTools: [
            'multi_channel',
            'memory_manager',
            'feishu_project_collab',
            'delegate_to_agent',
            'check_delegate_status',
            'task',
            'workflow',
          ],
        }
      : {}),
  });
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
  /**
   * 飞书注入（测试用）：凭证与 gateway 工厂透传给 registerFeishu → adapter，
   * 让 /feishu/start、/feishu/stop 端点行为可离线单测（不读真凭证、不连真飞书）。
   */
  feishuDeps?: Pick<FeishuRegisterDeps, 'credentials' | 'gatewayFactory'>;
  /**
   * 飞书凭证存取（/feishu/config 端点用）。缺省 = 真实读写
   * ~/.otto-user/feishu-credentials.json。测试必须注入内存实现——
   * 绝不允许测试碰用户真实凭证文件。
   */
  credentialsStore?: FeishuCredentialsStore;
  /** v1.7 个人/企业模式权威存储；测试可注入临时目录实例。 */
  productWorkspaceStore?: ProductWorkspaceStore;
}

/** 飞书凭证存取接口（可注入；默认实现走 feishu/vendor/credentials.ts）。 */
export interface FeishuCredentialsStore {
  load(): Promise<FeishuCredentials | null>;
  save(creds: FeishuCredentials): Promise<void>;
  clear(): Promise<void>;
}

const defaultCredentialsStore: FeishuCredentialsStore = {
  load: loadCredentials,
  save: saveCredentials,
  clear: clearCredentials,
};

/**
 * 单个 WS 连接的会话上下文：持有该连接对各会话的订阅取消句柄，
 * 断开时统一清理。
 */
interface ClientConn {
  socket: WebSocket;
  subscriptions: Map<string, Unsubscribe>;
}

/** 排队消息（PR 2：busy 时入队等待 drain） */
interface QueuedMessage {
  content: MessageContent;
  source: MessageSource;
  clientMessageId?: string;
  queueAction: 'merge' | 'next_turn';
}

/**
 * OttoServer：可被 bin（start/stop/status）或 Electron 主进程内嵌拉起。
 */
export class OttoServer {
  readonly store: SessionStore;
  private readonly host: string;
  private readonly port: number;
  /** 飞书网关是否启用。非 readonly：/feishu/start、/feishu/stop 运行期可翻转。 */
  private enableFeishu: boolean;
  private readonly startedAt = Date.now();
  private readonly runtimeFactory: RuntimeFactory;
  private readonly mock: boolean;
  /** 同一会话首次 send 时懒构建 runtime，用此 map 去重并发初始化。 */
  private readonly runtimeInit = new Map<
    string,
    Promise<SessionRuntime | undefined>
  >();
  private globalAuthorizationMode: 'manual' | 'auto';
  private readonly sessionAuthorizationModes = new Map<
    string,
    'manual' | 'auto'
  >();

  private http?: HttpServer;
  private wss?: WebSocketServer;
  private feishu?: FeishuRegistration;
  /** 飞书测试注入（见 OttoServerOptions.feishuDeps）。 */
  private readonly feishuDeps?: OttoServerOptions['feishuDeps'];
  /** 飞书凭证存取（/feishu/config 端点用）。 */
  private readonly credentialsStore: FeishuCredentialsStore;
  /** 运行期飞书启停的单飞锁：并发 POST 复用同一次操作，防重复 register。 */
  private feishuOpLock: Promise<unknown> = Promise.resolve();
  private readonly conns = new Set<ClientConn>();
  /** WorkflowRegistry 变化订阅的取消函数（P2 workflow 面板实时广播）。 */
  private workflowUnsub?: () => void;
  /** Agent 通过 local_schedule 改动后，实时推送桌面日历。 */
  private scheduleUnsub?: () => void;
  /** 进程级自动 Skill 扫描器由当前 server 实例启动时，停机时负责释放。 */
  private autoSkillScannerStarted = false;
  private readonly productWorkspace: ProductWorkspaceStore;

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
    this.feishuDeps = opts.feishuDeps;
    this.credentialsStore = opts.credentialsStore ?? defaultCredentialsStore;
    this.productWorkspace =
      opts.productWorkspaceStore ?? new ProductWorkspaceStore();
    this.globalAuthorizationMode =
      loadUserSettingsSubset().authorizationMode ?? 'manual';
  }

  /** mock 只允许测试显式开启；真实用户没有个人 API 时必须明确报错。 */
  private shouldMock(): boolean {
    return this.mock;
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

    // 内置 skill 预置 + 技能上下文初始化（幂等，best-effort）：内嵌 server 一起来就把随包的
    // 8 个办公 skill 装进 ~/.otto-user/skills/ 并注入系统提示词——agent 开箱即用、不再因
    // "没装 skill" 退回内置工具。放在 start() 而非 per-session runtime.initialize()，
    // 确保 app 一启动就就位，不必等用户发第一条消息。失败不影响对话。
    try {
      const { initializeSkillsContext } = await import('otto-core');
      await initializeSkillsContext(process.cwd());
    } catch {
      // skills 系统可选。
    }

    // 初始化 session 管理器（自动路由 / 分割 / 话题推断）
    try {
      const sessionMgr = getSessionManager();
      await sessionMgr.initialize();
      console.log('[Server] OttoSessionManager initialized');
    } catch (e) {
      console.warn('[Server] OttoSessionManager init failed (non-fatal):', e);
    }

    // 启动后台自动维护（每 10 分钟运行一次）
    //   - 记忆自动合并/压缩/清理 (AutoMemoryEngine)
    //   - 上下文自动压缩 (idle 会话的 LLM 上下文摘要)
    const maintenanceTimer = setInterval(() => {
      // 记忆引擎维护
      try {
        const engine = getAutoMemoryEngine();
        engine
          .runMaintenanceCycle()
          .catch((e: unknown) =>
            console.warn('[Server] AutoMemory maintenance failed:', e),
          );
      } catch {
        // engine 未初始化则跳过
      }
      // 上下文自动压缩
      this.runAutoCompressionCycle().catch((e: unknown) =>
        console.warn('[Server] Auto compression cycle failed:', e),
      );
    }, MAINTENANCE_INTERVAL_MS);

    // 确保 stop() 时清理定时器
    const origStop = this.stop.bind(this);
    this.stop = async () => {
      clearInterval(maintenanceTimer);
      await origStop();
    };

    // 自动 Skill 只分析本地工作日志并暂存“待确认候选”，不会直接写 SKILL.md。
    // 延迟首扫 15 秒，避免与桌面首屏初始化争抢磁盘；定时器 unref，不阻塞进程退出。
    try {
      const scannerConfig = createCoreConfig({
        sessionId: 'auto-skill-scanner',
      });
      this.autoSkillScannerStarted = startAutoSkillScanner(
        scannerConfig,
        () => this.productWorkspace.snapshot().context.userId,
        {
          onCandidatesStaged: (candidates) => {
            this.broadcastAll({
              type: 'pending_auto_skills',
              payload: { candidates: candidates.map(publicAutoSkillCandidate) },
            });
          },
        },
      );
    } catch (error) {
      console.warn(
        `[AutoSkill] Scanner startup skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (this.enableFeishu) {
      // ── registerFeishu 接缝（Issue #3）──
      // 飞书网关迁入 server：gateway.onMessage → store.getOrCreateFeishuSession +
      // appendMessage(source:'feishu') + publish；app→飞书回推走 registration.pushToFeishu。
      this.feishu = await registerFeishu({
        store: this.store,
        broadcast: (sessionId, frame) => this.store.publish(sessionId, frame),
        ensureRuntime: (sessionId) => this.ensureRuntime(sessionId),
        mock: this.mock,
        ...this.feishuDeps,
      });
    }

    // WorkflowRegistry 是进程级单例（与会话无关），订阅其变化并广播给所有连接，
    // 让「Workflow 面板」实时看到进度（agent 开始/结束/token 更新），无需轮询。
    this.workflowUnsub = WorkflowRegistry.subscribe(() => {
      this.broadcastAll({
        type: 'workflows_list',
        payload: { workflows: this.workflowSummaries() },
      });
    });
    this.scheduleUnsub = subscribeLocalSchedules((schedules) => {
      this.broadcastAll({
        type: 'schedules_list',
        payload: { schedules },
      });
    });
  }

  /** 停止服务（取消并释放所有活跃 runtime，再关 WS、HTTP、飞书）。 */
  async stop(): Promise<void> {
    if (this.autoSkillScannerStarted) {
      stopAutoSkillScanner();
      this.autoSkillScannerStarted = false;
    }
    this.workflowUnsub?.();
    this.workflowUnsub = undefined;
    this.scheduleUnsub?.();
    this.scheduleUnsub = undefined;
    // 落盘存储：停机前把挂起的去抖写盘立即落地（被动保存不丢最后一轮）。
    const flush = (this.store as { flush?: () => void }).flush;
    if (typeof flush === 'function') {
      try {
        flush.call(this.store);
      } catch {
        // 落盘失败不阻断停机
      }
    }
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
        status: this.feishu?.getStatus(),
      },
    };
  }

  get endpoint(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  /** 构建斜杠命令宿主（窄接口，注入给命令注册表使用）。 */
  private buildCommandHost(): import('./commands/types.js').CommandHost {
    return {
      store: this.store,
      serverVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: () => Date.now() - this.startedAt,
      cwd: () => resolveDefaultCwd(),
      getConfig: (sid) =>
        this.store.getRuntime(sid)?.getConfig?.() as CoreConfig | undefined,
      currentModel: () => this.currentModel(),
      modelInfos: () => this.modelInfos(),
      mcpServerInfos: () => this.mcpServerInfos(),
      extensionSummaries: () => discoverExtensionSummaries(resolveDefaultCwd()),
    };
  }

  /** 内部测试阶段所有身份都只列成员自己的 BYOK 模型。 */
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
      if (p.replaceId) {
        firstId = replaceCustomModel(
          p.replaceId,
          buildModel(p.modelId),
          makeActive,
        );
      } else {
        for (let i = 0; i < ids.length; i++) {
          const savedId = saveCustomModel(
            buildModel(ids[i]),
            makeActive && i === 0,
          );
          if (i === 0) firstId = savedId;
        }
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
        payload: {
          code: 'save_failed',
          message: `保存自定义模型失败：${message}`,
        },
      });
    }
  }

  /**
   * 切换会话模型（set_model 帧）：
   *   校验目标模型「存在且 enabled」→ 更新会话摘要 + 即时切已存在的 runtime
   *   → 回发一帧 models_list（带 current），让 renderer 的模型药丸反映真实生效模型。
   * 非法模型（不存在 / 被禁用）→ 回 error(code:'unknown_model')，不污染会话摘要与 runtime。
   */
  private async handleSetModel(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'set_model' }>,
  ): Promise<void> {
    const { sessionId, model } = msg.payload;
    const known = this.modelInfos().find((m) => m.id === model && m.enabled);
    if (!known) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'unknown_model', `未知或未启用的模型：${model}`),
      );
    }
    if (!this.store.getSession(sessionId)) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    // live runtime 必须先完成真实切换，成功后才能更新摘要和 UI；否则会出现
    // 「界面显示 GPT、实际请求仍走 GLM」的假成功状态。
    try {
      await this.store.getRuntime(sessionId)?.setModel(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.send(
        conn.socket,
        errorFrame(
          sessionId,
          'model_switch_failed',
          `模型切换失败：${message}`,
        ),
      );
    }
    this.store.patchSessionModel(sessionId, model);
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
  // GUI 设置面板 handler（P0：统一设置 / MCP 管理 / context 用量 / 用量统计 / 依赖体检 / Todo）
  // ──────────────────────────────────────────────────────────────────────

  /**
   * 遍历所有存活会话的 runtime，取出其 CoreConfig（若已懒构建）。
   * 用于把 agentStyle/healthyUse/preferredLanguage 等全局设置即时应用到
   * 已经在跑的会话——不影响尚未构建 runtime 的会话（它们下次构建时
   * 会读最新的落盘配置，自然生效）。
   */
  private liveConfigs(): CoreConfig[] {
    const configs: CoreConfig[] = [];
    for (const s of this.store.listSessions()) {
      const runtime = this.store.getRuntime(s.sessionId);
      const cfg = runtime?.getConfig?.() as CoreConfig | undefined;
      if (cfg) configs.push(cfg);
    }
    return configs;
  }

  /** 全局偏好设置快照：agentStyle 读项目级 .otto/settings.json；其余读 ~/.otto-user/settings.json。 */
  private settingsSnapshot(): SettingsSnapshot {
    const userSubset = loadUserSettingsSubset();
    const projectMgr = new ProjectSettingsManager(resolveDefaultCwd());
    projectMgr.load();
    return {
      agentStyle: projectMgr.getAgentStyle(),
      healthyUse: userSubset.healthyUse ?? true,
      preferredLanguage: userSubset.preferredLanguage,
    };
  }

  /**
   * 修改一项全局偏好设置：持久化 + 即时应用到所有存活会话 + 广播最新快照。
   */
  private async handleSetSetting(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'set_setting' }>,
  ): Promise<void> {
    const { key, value } = msg.payload;
    try {
      if (key === 'agentStyle') {
        if (typeof value !== 'string') {
          throw new Error('agentStyle 的值必须是字符串');
        }
        const projectMgr = new ProjectSettingsManager(resolveDefaultCwd());
        projectMgr.load();
        projectMgr.setAgentStyle(
          value as Parameters<ProjectSettingsManager['setAgentStyle']>[0],
        );
        for (const cfg of this.liveConfigs()) {
          try {
            cfg.setAgentStyle(
              value as Parameters<CoreConfig['setAgentStyle']>[0],
            );
            const client = cfg.getOttoClient();
            await client?.updateSystemPromptWithMcpPrompts();
          } catch {
            // 单个会话刷新失败不影响整体设置生效（下次新会话会读到最新落盘值）。
          }
        }
      } else if (key === 'healthyUse') {
        if (typeof value !== 'boolean') {
          throw new Error('healthyUse 的值必须是布尔');
        }
        patchUserSettings({ healthyUse: value });
        for (const cfg of this.liveConfigs()) {
          try {
            cfg.setHealthyUseEnabled(value);
          } catch {
            // 忽略单个会话失败。
          }
        }
      } else if (key === 'preferredLanguage') {
        if (typeof value !== 'string') {
          throw new Error('preferredLanguage 的值必须是字符串');
        }
        patchUserSettings({ preferredLanguage: value });
        for (const cfg of this.liveConfigs()) {
          try {
            cfg.setPreferredLanguage(value);
          } catch {
            // 忽略单个会话失败。
          }
        }
      }
      this.broadcastAll({ type: 'settings', payload: this.settingsSnapshot() });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'set_setting_failed',
          message: `保存设置失败：${message}`,
        },
      });
    }
  }

  /**
   * MCP 服务器摘要：配置来自 ~/.otto-user/settings.json 的 mcpServers；
   * 连接状态来自 core 的进程级 getAllMCPServerStatuses。
   */
  private mcpServerInfos(): McpServerInfo[] {
    const servers = loadMcpServers();
    const statuses = getAllMCPServerStatuses();
    return Object.entries(servers).map(([name, cfg]) => {
      const raw = statuses.get(name);
      const status: McpServerInfo['status'] =
        raw === MCPServerStatus.CONNECTED
          ? 'connected'
          : raw === MCPServerStatus.CONNECTING
            ? 'connecting'
            : 'disconnected';
      return {
        name,
        status,
        command: cfg.command,
        url: cfg.url,
        httpUrl: cfg.httpUrl,
        description: cfg.description,
      };
    });
  }

  /** 添加/更新一个 MCP 服务器：写盘 + 即时应用到所有存活会话的 Config。 */
  private handleMcpAdd(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'mcp_add' }>,
  ): void {
    const p = msg.payload;
    try {
      const servers = loadMcpServers();
      const cfg = new MCPServerConfig(
        p.command,
        p.args,
        p.env,
        p.cwd,
        p.url,
        p.httpUrl,
        p.headers,
        undefined,
        p.timeout,
        p.trust,
        p.description,
      );
      servers[p.name] = cfg;
      saveMcpServers(servers);
      for (const liveCfg of this.liveConfigs()) {
        try {
          liveCfg.addMcpServer(p.name, cfg);
          void liveCfg
            .getToolRegistry()
            .then((registry) => registry.discoverToolsForServer(p.name))
            .catch(() => undefined);
        } catch {
          // 忽略单个会话应用失败。
        }
      }
      this.broadcastAll({
        type: 'mcp_servers',
        payload: { servers: this.mcpServerInfos() },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'mcp_add_failed',
          message: `添加 MCP 服务器失败：${message}`,
        },
      });
    }
  }

  /** 移除一个 MCP 服务器：写盘 + 即时从所有存活会话的 Config 移除。 */
  private handleMcpRemove(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'mcp_remove' }>,
  ): void {
    const { name } = msg.payload;
    try {
      const servers = loadMcpServers();
      delete servers[name];
      saveMcpServers(servers);
      for (const cfg of this.liveConfigs()) {
        try {
          cfg.removeMcpServer(name);
        } catch {
          // 忽略单个会话失败。
        }
      }
      this.broadcastAll({
        type: 'mcp_servers',
        payload: { servers: this.mcpServerInfos() },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'mcp_remove_failed',
          message: `移除 MCP 服务器失败：${message}`,
        },
      });
    }
  }

  /** 某会话当前 context 用量分解（对齐 CLI /context 的口径）。 */
  private handleGetContextBreakdown(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'get_context_breakdown' }>,
  ): void {
    const { sessionId } = msg.payload;
    const session = this.store.getSession(sessionId);
    if (!session) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    const runtime = this.store.getRuntime(sessionId);
    const cfg = runtime?.getConfig?.() as CoreConfig | undefined;
    const modelId =
      cfg?.getModel?.() ?? session.model ?? this.currentModel() ?? 'auto';
    const maxTokens = tokenLimit(modelId, cfg);
    const memoryFilesTokens = cfg?.getMemoryTokenCount?.() ?? 0;
    let systemPromptTokens = 0;
    try {
      const agentStyle = cfg?.getAgentStyle?.() ?? 'default';
      const fullPrompt = getCoreSystemPrompt(
        cfg?.getUserMemory?.() ?? '',
        false,
        undefined,
        agentStyle,
        undefined,
        cfg?.getPreferredLanguage?.(),
      );
      const totalSystemTokens = Math.ceil(fullPrompt.length / 4);
      systemPromptTokens =
        memoryFilesTokens > 0 && totalSystemTokens > memoryFilesTokens
          ? totalSystemTokens - memoryFilesTokens
          : totalSystemTokens;
    } catch {
      systemPromptTokens = 0;
    }
    const modelMetrics = uiTelemetryService.getMetrics().models[modelId];
    const systemToolsTokens = modelMetrics?.tokens.tool ?? 0;
    const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();
    const messagesTokens =
      actualPromptTokens > 0
        ? Math.max(
            0,
            actualPromptTokens -
              systemPromptTokens -
              memoryFilesTokens -
              systemToolsTokens,
          )
        : 0;
    const totalInputTokens =
      actualPromptTokens > 0
        ? actualPromptTokens
        : systemPromptTokens + memoryFilesTokens + systemToolsTokens;
    const freeSpaceTokens = Math.max(0, maxTokens - totalInputTokens);
    const displayName =
      this.modelInfos().find((m) => m.id === modelId)?.displayName ?? modelId;
    this.send(conn.socket, {
      type: 'context_breakdown',
      payload: {
        sessionId,
        modelDisplayName: displayName,
        maxTokens,
        systemPromptTokens,
        systemToolsTokens,
        memoryFilesTokens,
        messagesTokens,
        totalInputTokens,
        freeSpaceTokens,
      },
    });
  }

  /** 用量统计快照（对齐 CLI /stats，进程级全部会话聚合）。 */
  private statsSnapshot(): StatsSnapshot {
    const metrics = uiTelemetryService.getMetrics();
    const models: StatsSnapshot['models'] = {};
    for (const [name, m] of Object.entries(metrics.models)) {
      models[name] = {
        requests: m.api.totalRequests,
        inputTokens: m.tokens.prompt,
        outputTokens: m.tokens.candidates,
        totalTokens: m.tokens.total,
      };
    }
    const byName: StatsSnapshot['tools']['byName'] = {};
    for (const [name, t] of Object.entries(metrics.tools.byName)) {
      byName[name] = { count: t.count, success: t.success, fail: t.fail };
    }
    // 合并 session 管理器统计
    let sessionStats = { total: 0, active: 0, idle: 0, archived: 0, frozen: 0 };
    try {
      const sessionMgr = getSessionManager();
      sessionStats = sessionMgr.getStats();
    } catch {
      /* 非关键 */
    }

    return {
      models,
      tools: {
        totalCalls: metrics.tools.totalCalls,
        totalSuccess: metrics.tools.totalSuccess,
        totalFail: metrics.tools.totalFail,
        byName,
      },
      sessions: sessionStats,
    };
  }

  /** 触发一次外部依赖体检（异步，跑完再回帧，避免 UI 长时间无反馈）。 */
  private async handleRunDoctor(conn: ClientConn): Promise<void> {
    try {
      const report = await new DoctorService().check();
      const payload: DoctorReportInfo = {
        platform: report.platform,
        checks: report.checks.map((c) => ({
          name: c.name,
          category: c.category,
          present: c.present,
          version: c.version,
          installHint: c.installHint,
        })),
        presentCount: report.presentCount,
        missingCount: report.missingCount,
        affectedCapabilities: report.affectedCapabilities,
      };
      this.send(conn.socket, { type: 'doctor_report', payload });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: { code: 'doctor_failed', message: `依赖体检失败：${message}` },
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // GUI 设置面板 handler（P1：记忆文件 / 技能库 / 工具清单 / 压缩上下文 / 导出会话）
  // ──────────────────────────────────────────────────────────────────────

  /** 拉取层级记忆文件（项目 OTTO.md + 全局 ~/.otto-user/memory/OTTO.md）内容。 */
  private async handleGetMemory(conn: ClientConn): Promise<void> {
    try {
      const cwd = resolveDefaultCwd();
      const projectPath = path.join(cwd, 'OTTO.md');
      const globalPath = path.join(
        homedir(),
        OTTO_CONFIG_DIR,
        'memory',
        DEFAULT_CONTEXT_FILENAME,
      );
      const files: MemoryFileInfo[] = await Promise.all(
        [
          { scope: 'project' as const, filePath: projectPath },
          { scope: 'global' as const, filePath: globalPath },
        ].map(async ({ scope, filePath }) => {
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            return { scope, path: filePath, exists: true, content };
          } catch {
            return { scope, path: filePath, exists: false, content: '' };
          }
        }),
      );
      this.send(conn.socket, { type: 'memory_snapshot', payload: { files } });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'get_memory_failed',
          message: `读取记忆文件失败：${message}`,
        },
      });
    }
  }

  /** 追加一条记忆事实：写入项目级 OTTO.md（对齐 save_memory 工具的落点），成功后回推最新快照。 */
  private async handleAddMemory(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'add_memory' }>,
  ): Promise<void> {
    const { fact } = msg.payload;
    try {
      const memoryFilePath = path.join(resolveDefaultCwd(), 'OTTO.md');
      await MemoryTool.performAddMemoryEntry(fact, memoryFilePath, {
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        mkdir: fs.mkdir,
      });
      await this.handleGetMemory(conn);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'add_memory_failed',
          message: `保存记忆失败：${message}`,
        },
      });
    }
  }

  /** 拉取已装技能列表（对齐 CLI /skill list，进程级、与会话无关）。 */
  private async handleGetSkills(conn: ClientConn): Promise<void> {
    try {
      const adapter = new SkillsCompatAdapter(resolveDefaultCwd());
      const skills = await adapter.listSkills();
      const payload: SkillSummary[] = skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        marketplaceId: s.marketplaceId,
        pluginId: s.pluginId,
        enabled: s.enabled,
      }));
      this.send(conn.socket, {
        type: 'skills_list',
        payload: { skills: payload },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'get_skills_failed',
          message: `读取技能库失败：${message}`,
        },
      });
    }
  }

  /** 拉取某会话当前可用工具清单（内置 + MCP，对齐 CLI /tools）。 */
  private async handleGetTools(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'get_tools' }>,
  ): Promise<void> {
    const { sessionId } = msg.payload;
    const runtime = this.store.getRuntime(sessionId);
    const cfg = runtime?.getConfig?.() as CoreConfig | undefined;
    if (!cfg) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话尚未初始化，暂无工具信息'),
      );
    }
    try {
      const registry = await cfg.getToolRegistry();
      const tools: ToolSummary[] = registry.getAllTools().map((tool) => ({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description,
        serverName: (tool as { serverName?: string }).serverName,
      }));
      this.send(conn.socket, {
        type: 'tools_list',
        payload: { sessionId, tools },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          sessionId,
          code: 'get_tools_failed',
          message: `读取工具清单失败：${message}`,
        },
      });
    }
  }

  /** 手动压缩某会话的上下文（对齐 CLI /compress）。 */
  private async handleCompressContext(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'compress_context' }>,
  ): Promise<void> {
    const { sessionId } = msg.payload;
    const runtime = this.store.getRuntime(sessionId);
    const cfg = runtime?.getConfig?.() as CoreConfig | undefined;
    const client = cfg?.getOttoClient?.();
    if (!client) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话尚未初始化，无法压缩'),
      );
    }
    try {
      if (client.isCompressionInProgress()) {
        return this.send(conn.socket, {
          type: 'compress_result',
          payload: {
            sessionId,
            compressed: false,
            message: '已有压缩任务在进行中，请稍候。',
          },
        });
      }
      const info = await client.tryCompressChat(
        `${sessionId}-compress-${Date.now()}`,
        new AbortController().signal,
        true,
      );
      if (info) {
        this.send(conn.socket, {
          type: 'compress_result',
          payload: {
            sessionId,
            compressed: true,
            originalTokenCount: info.originalTokenCount,
            newTokenCount: info.newTokenCount,
            message: `已压缩：${info.originalTokenCount.toLocaleString()} → ${info.newTokenCount.toLocaleString()} tokens`,
          },
        });
      } else {
        this.send(conn.socket, {
          type: 'compress_result',
          payload: {
            sessionId,
            compressed: false,
            message: '当前上下文较小，无需压缩。',
          },
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          sessionId,
          code: 'compress_failed',
          message: `压缩失败：${message}`,
        },
      });
    }
  }

  /**
   * 自动上下文压缩 — 后台定时扫描 idle 会话，对消息数超阈值的会话
   * 触发 LLM 摘要压缩。每轮最多压缩 3 个会话，避免并发 LLM 调用过多。
   *
   * 设计原则：
   *   - 只压 idle 会话（不影响用户正在活跃对话的）
   *   - 消息数 ≥ AUTO_COMPRESS_MIN_MESSAGES 才触发
   *   - 每个会话在一次周期内最多压一次（isCompressionInProgress 防重入）
   *   - 静默失败：压缩异常不影响其他会话和主对话流
   */
  private async runAutoCompressionCycle(): Promise<void> {
    const sessions = this.store.listSessions();
    const candidates = sessions.filter(
      (s) =>
        s.status === 'idle' && s.messageCount >= AUTO_COMPRESS_MIN_MESSAGES,
    );

    if (candidates.length === 0) return;

    // 按消息数降序，优先压缩最臃肿的会话
    candidates.sort((a, b) => b.messageCount - a.messageCount);

    const MAX_PER_CYCLE = 3;
    let compressed = 0;
    let skipped = 0;

    for (const session of candidates.slice(0, MAX_PER_CYCLE)) {
      try {
        const runtime = this.store.getRuntime(session.sessionId);
        if (!runtime) {
          skipped++;
          continue; // 尚无 runtime（从未发起过对话），无需压缩
        }

        const cfg = runtime.getConfig?.() as CoreConfig | undefined;
        const client = cfg?.getOttoClient?.();
        if (!client) {
          skipped++;
          continue;
        }

        if (client.isCompressionInProgress()) {
          skipped++;
          continue; // 已有压缩任务
        }

        const info = await client.tryCompressChat(
          `${session.sessionId}-auto-${Date.now()}`,
          new AbortController().signal,
          true,
        );

        if (info) {
          compressed++;
          this.store.publish(session.sessionId, {
            type: 'compress_result',
            payload: {
              sessionId: session.sessionId,
              compressed: true,
              originalTokenCount: info.originalTokenCount,
              newTokenCount: info.newTokenCount,
              message: `[自动] 已压缩：${info.originalTokenCount.toLocaleString()} → ${info.newTokenCount.toLocaleString()} tokens`,
            },
          });
          console.log(
            `[Server] Auto-compressed session ${session.sessionId}: ` +
              `${info.originalTokenCount} → ${info.newTokenCount} tokens`,
          );
        }
      } catch (e) {
        console.warn(
          `[Server] Auto-compress session ${session.sessionId} failed:`,
          e instanceof Error ? e.message : e,
        );
      }
    }

    if (compressed > 0 || skipped > 0) {
      console.log(
        `[Server] Auto-compression cycle: ${compressed} compressed, ${skipped} skipped ` +
          `(out of ${candidates.length} candidates)`,
      );
    }
  }

  /** 导出某会话为 Markdown 文本（对齐 CLI /export），落盘由 desktop 侧完成。 */
  private handleExportConversation(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'export_conversation' }>,
  ): void {
    const { sessionId } = msg.payload;
    const session = this.store.getSession(sessionId);
    if (!session) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    const messages = this.store.getHistory(sessionId);
    const lines: string[] = [`# ${session.title || '未命名对话'}`, ''];
    for (const m of messages) {
      const speaker = m.role === 'user' ? '用户' : 'Otto';
      const text = m.content
        .map((p) => (p.type === 'text' ? p.value : ''))
        .join('')
        .trim();
      if (!text) continue;
      lines.push(`## ${speaker}`, '', text, '');
    }
    const safeTitle = (session.title || 'conversation').replace(
      /[\\/:*?"<>|]/g,
      '_',
    );
    this.send(conn.socket, {
      type: 'export_result',
      payload: {
        sessionId,
        suggestedFileName: `${safeTitle}.md`,
        markdown: lines.join('\n'),
      },
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // GUI 设置面板 handler（P2：Workflow 面板 / 扩展列表 / IDE 伴生状态）
  // ──────────────────────────────────────────────────────────────────────

  /** WorkflowRegistry（进程级单例）→ 协议 WorkflowSummary[]。 */
  private workflowSummaries(): WorkflowSummary[] {
    return WorkflowRegistry.getAll().map((wf) => ({
      id: wf.id,
      slug: wf.slug,
      description: wf.description,
      status: wf.status,
      startTime: wf.startTime,
      endTime: wf.endTime,
      totalTokenUsage: wf.totalTokenUsage,
      phases: wf.phases.map((p) => ({
        index: p.index,
        name: p.name,
        description: p.description,
        agents: p.agents.map(toWorkflowAgentSummary),
      })),
      agents: wf.agents.map(toWorkflowAgentSummary),
    }));
  }

  /** 拉取 workflow 记录。 */
  private handleGetWorkflows(conn: ClientConn): void {
    this.send(conn.socket, {
      type: 'workflows_list',
      payload: { workflows: this.workflowSummaries() },
    });
  }

  /** 拉取已安装扩展列表（项目级 + 全局 ~/.otto-user/extensions，去重）。 */
  private async handleGetExtensions(conn: ClientConn): Promise<void> {
    try {
      const extensions = await discoverExtensionSummaries(resolveDefaultCwd());
      this.send(conn.socket, {
        type: 'extensions_list',
        payload: { extensions },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.send(conn.socket, {
        type: 'error',
        payload: {
          code: 'get_extensions_failed',
          message: `读取扩展列表失败：${message}`,
        },
      });
    }
  }

  /**
   * IDE 伴生连接状态。desktop 是独立 Electron 应用，不像 CLI 那样跑在 VS Code
   * 终端内、天然带 OTTO_CODE_IDE_SERVER_PORT；因此恒回 not_applicable + 说明，
   * 诚实告知而非谎报「未连接」（那会让用户误以为该去连接，其实这条能力不适用桌面端）。
   */
  private handleGetIdeStatus(conn: ClientConn): void {
    this.send(conn.socket, {
      type: 'ide_status',
      payload: {
        status: 'not_applicable',
        details:
          'IDE 伴生状态仅适用于终端内的 CLI（VS Code 集成终端），桌面端不适用。',
      },
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
      this.broadcastAll({
        type: 'session_upsert',
        payload: { session: summary },
      });
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
    // 飞书运行期启停（desktop 一键开关走这里）。async handler：完成后再答复。
    if (path === HTTP_ROUTES.feishuStart && req.method === 'POST') {
      void this.runtimeFeishuStart()
        .then((r) => sendJson(res, r.ok ? 200 : 409, r))
        .catch((e) =>
          sendJson(res, 500, err(e instanceof Error ? e.message : String(e))),
        );
      return;
    }
    if (path === HTTP_ROUTES.feishuStop && req.method === 'POST') {
      void this.runtimeFeishuStop()
        .then((r) => sendJson(res, r.ok ? 200 : 409, r))
        .catch((e) =>
          sendJson(res, 500, err(e instanceof Error ? e.message : String(e))),
        );
      return;
    }
    // 飞书凭证配置（desktop「飞书接入」面板走这里；appSecret 只进不出）。
    if (path === HTTP_ROUTES.feishuConfig && req.method === 'GET') {
      void this.feishuConfigView()
        .then((view) => sendJson(res, 200, ok(view)))
        .catch((e) =>
          sendJson(res, 500, err(e instanceof Error ? e.message : String(e))),
        );
      return;
    }
    if (path === HTTP_ROUTES.feishuConfig && req.method === 'POST') {
      void readJsonBody(req)
        .then((body) => this.runtimeFeishuSaveConfig(body))
        .then((r) => sendJson(res, r.ok ? 200 : 400, r))
        .catch((e) =>
          sendJson(res, 400, err(e instanceof Error ? e.message : String(e))),
        );
      return;
    }
    if (path === HTTP_ROUTES.feishuConfig && req.method === 'DELETE') {
      void this.runtimeFeishuClearConfig()
        .then((r) => sendJson(res, 200, r))
        .catch((e) =>
          sendJson(res, 500, err(e instanceof Error ? e.message : String(e))),
        );
      return;
    }

    sendJson(res, 404, err('not_found'));
  }

  // ──────────────────────────────────────────────────────────────────────
  // 飞书运行期启停（POST /feishu/start | /feishu/stop）
  // ──────────────────────────────────────────────────────────────────────

  /** 运行期启动/恢复飞书守护。幂等；经单飞锁串行化，并发请求不会重复注册。 */
  private runtimeFeishuStart(): Promise<
    ApiResponse<FeishuHealthStatus | null>
  > {
    const run = this.feishuOpLock.then(async () => {
      if (!this.feishu) {
        this.feishu = await registerFeishu({
          store: this.store,
          broadcast: (sessionId, frame) => this.store.publish(sessionId, frame),
          ensureRuntime: (sessionId) => this.ensureRuntime(sessionId),
          mock: this.mock,
          ...this.feishuDeps,
        });
      } else {
        await this.feishu.start();
      }
      const status = this.feishu.getStatus();
      if (!status.configured) {
        this.enableFeishu = false;
        return {
          ok: false,
          data: status,
          error:
            '未发现可用的飞书凭证（~/.otto-user/feishu-credentials.json），网关未启动。' +
            '请先配置飞书凭证，再重试。',
        } satisfies ApiResponse<FeishuHealthStatus | null>;
      }
      this.enableFeishu = true;
      return ok<FeishuHealthStatus | null>(status);
    });
    this.feishuOpLock = run.catch(() => undefined);
    return run;
  }

  /** 运行期停止飞书守护；取消重连，直到再次 start。 */
  private runtimeFeishuStop(): Promise<ApiResponse<FeishuHealthStatus | null>> {
    const run = this.feishuOpLock.then(async () => {
      if (!this.feishu) {
        return {
          ok: false,
          data: null,
          error: '飞书网关未在运行，无需停止。',
        } satisfies ApiResponse<FeishuHealthStatus | null>;
      }
      await this.feishu.stop();
      this.enableFeishu = false;
      return ok<FeishuHealthStatus | null>(this.feishu.getStatus());
    });
    this.feishuOpLock = run.catch(() => undefined);
    return run;
  }

  /** 凭证的脱敏视图：appSecret 永不出现在响应里。 */
  private async feishuConfigView(): Promise<FeishuConfigPublic> {
    let creds: FeishuCredentials | null;
    try {
      creds = await this.credentialsStore.load();
    } catch {
      return { configured: false, corrupted: true };
    }
    if (!creds) return { configured: false };
    return {
      configured: true,
      appId: creds.appId,
      domain: creds.domain,
      botName: creds.botName,
      tenantName: creds.tenantName,
      ownerOpenId: creds.ownerOpenId,
      allowlistCount: creds.allowlist?.length ?? 0,
    };
  }

  /** 保存凭证并立即让守护用上新凭证。 */
  private async runtimeFeishuSaveConfig(
    body: unknown,
  ): Promise<ApiResponse<FeishuConfigPublic>> {
    const parsed = parseFeishuConfigSaveRequest(body);
    if (typeof parsed === 'string') {
      return { ok: false, data: await this.feishuConfigView(), error: parsed };
    }

    let existing: FeishuCredentials | null = null;
    try {
      existing = await this.credentialsStore.load();
    } catch {
      existing = null;
    }

    const sameApp = existing?.appId === parsed.appId;
    const secret =
      parsed.appSecret ?? (sameApp ? existing?.appSecret : undefined);
    if (!secret) {
      return {
        ok: false,
        data: await this.feishuConfigView(),
        error: sameApp
          ? '请填写 App Secret。'
          : '更换 App ID 时必须重新填写 App Secret。',
      };
    }

    const next: FeishuCredentials = {
      appId: parsed.appId,
      appSecret: secret,
      domain: parsed.domain,
      ...(sameApp && existing
        ? {
            botName: existing.botName,
            botOpenId: existing.botOpenId,
            tenantName: existing.tenantName,
            allowlist: existing.allowlist,
          }
        : {}),
      ...(parsed.ownerOpenId
        ? { ownerOpenId: parsed.ownerOpenId }
        : sameApp && existing?.ownerOpenId
          ? { ownerOpenId: existing.ownerOpenId }
          : {}),
    };
    await this.credentialsStore.save(next);

    await this.runtimeFeishuStop().catch(() => undefined);
    const started = await this.runtimeFeishuStart().catch(
      (e): ApiResponse<FeishuHealthStatus | null> =>
        err(e instanceof Error ? e.message : String(e)),
    );
    return {
      ok: started.ok,
      data: await this.feishuConfigView(),
      error: started.ok
        ? null
        : `凭证已保存，但守护启动失败：${started.error ?? '未知原因'}`,
    };
  }

  /** 停守护 + 清除凭证。 */
  private async runtimeFeishuClearConfig(): Promise<
    ApiResponse<FeishuConfigPublic>
  > {
    await this.runtimeFeishuStop().catch(() => undefined);
    await this.credentialsStore.clear();
    return ok(await this.feishuConfigView());
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
        return this.send(
          socket,
          errorFrame(undefined, 'bad_json', '无法解析的帧'),
        );
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
          errorFrame(
            undefined,
            'internal',
            String(e instanceof Error ? e.message : e),
          ),
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
        const workspace = this.productWorkspace.snapshot();
        const profile = resolveAgentProfile(msg.payload.agentProfileId);
        if (msg.payload.agentProfileId && !profile) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'unknown_agent_profile',
              message: '未知 Agent profile',
            },
          });
        }
        if (
          profile &&
          profile.edition !== 'both' &&
          profile.edition !== workspace.context.edition
        ) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'forbidden_agent_profile',
              message:
                workspace.context.edition === 'personal'
                  ? '个人版只能使用 Otto、会议助手与通用专家。'
                  : '企业版不能使用个人版 Otto profile。',
            },
          });
        }
        if (
          profile?.roles &&
          !profile.roles.includes(
            workspace.context.role as (typeof profile.roles)[number],
          )
        ) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'forbidden_agent_profile',
              message: '当前企业角色不能使用这个 Agent profile。',
            },
          });
        }
        if (
          profile?.scope === 'department' &&
          workspace.context.edition !== 'enterprise'
        ) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'forbidden_agent_profile',
              message: '个人版不能使用企业部门专家。',
            },
          });
        }
        if (
          profile?.scope === 'department' &&
          workspace.context.role !== 'company_owner' &&
          workspace.context.role !== 'company_admin'
        ) {
          const currentDepartment =
            workspace.managerWorkspace?.organization.departments.find(
              (item) => item.id === workspace.context.departmentId,
            );
          if (
            currentDepartment &&
            profile.department !== currentDepartment.name
          ) {
            return this.send(conn.socket, {
              type: 'error',
              payload: {
                code: 'forbidden_agent_profile',
                message: '当前成员只能使用本部门 Agent。',
              },
            });
          }
        }
        const summary = this.store.createSession({
          title: msg.payload.title,
          model: msg.payload.model ?? this.currentModel(),
          agentProfileId: profile?.id,
          agentProfileName: profile?.name,
          productEdition: workspace.context.edition,
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
      case 'set_authorization_mode': {
        const { sessionId, mode, scope } = msg.payload;
        if (scope === 'all') {
          this.globalAuthorizationMode = mode;
          this.sessionAuthorizationModes.clear();
          patchUserSettings({ authorizationMode: mode });
          for (const session of this.store.listSessions()) {
            this.store
              .getRuntime(session.sessionId)
              ?.setAuthorizationMode?.(mode);
          }
        } else {
          this.sessionAuthorizationModes.set(sessionId, mode);
          this.store.getRuntime(sessionId)?.setAuthorizationMode?.(mode);
        }
        return;
      }
      case 'cancel': {
        this.store.getRuntime(msg.payload.sessionId)?.cancel();
        // 清除排队消息队列（可选，默认清）
        if (msg.payload.clearQueue !== false) {
          this.messageQueues.delete(msg.payload.sessionId);
        }
        return;
      }
      case 'tool_confirmation_response': {
        // 把用户对某待确认工具的应答（AskUserQuestion 的答案 / 危险命令确认等）
        // 按 callId 路由回该会话 runtime，唤醒 runToolCalls 里挂起的等待。
        // 会话 / runtime 不存在或 callId 无挂起时静默忽略（幂等）。
        const { sessionId, callId, outcome, payload } = msg.payload;
        this.store
          .getRuntime(sessionId)
          ?.resolveToolConfirmation(callId, outcome, payload);
        return;
      }
      case 'get_product_workspace':
        return this.send(conn.socket, {
          type: 'product_workspace',
          payload: this.productWorkspace.snapshot(),
        });
      case 'configure_enterprise': {
        try {
          const workspace = this.productWorkspace.configureManager(msg.payload);
          this.broadcastAll({ type: 'product_workspace', payload: workspace });
          this.broadcastAll({
            type: 'models_list',
            payload: {
              models: this.modelInfos(),
              current: this.currentModel(),
            },
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'workspace_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'switch_to_personal': {
        const workspace = this.productWorkspace.switchToPersonal();
        this.broadcastAll({ type: 'product_workspace', payload: workspace });
        this.broadcastAll({
          type: 'models_list',
          payload: { models: this.modelInfos(), current: this.currentModel() },
        });
        return;
      }
      case 'join_enterprise': {
        try {
          const workspace = this.productWorkspace.acceptInvite(
            msg.payload.link,
            {
              userId: msg.payload.userId,
              displayName: msg.payload.displayName,
            },
          );
          this.broadcastAll({ type: 'product_workspace', payload: workspace });
          this.broadcastAll({
            type: 'models_list',
            payload: {
              models: this.modelInfos(),
              current: this.currentModel(),
            },
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'workspace_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'create_enterprise_invite': {
        try {
          const invite = this.productWorkspace.issueInvite(msg.payload);
          this.send(conn.socket, {
            type: 'enterprise_invite_created',
            payload: invite,
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'workspace_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'add_friend': {
        try {
          const workspace = this.productWorkspace.addFriend(
            msg.payload.displayName,
            msg.payload.note,
          );
          this.broadcastAll({ type: 'product_workspace', payload: workspace });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'workspace_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'accept_company_link': {
        try {
          const workspace = this.productWorkspace.acceptCompanyLink(
            msg.payload.link,
          );
          this.broadcastAll({ type: 'product_workspace', payload: workspace });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'workspace_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'get_pending_auto_skills': {
        try {
          const candidates = (await listPendingSkillCandidates()).map(
            publicAutoSkillCandidate,
          );
          return this.send(conn.socket, {
            type: 'pending_auto_skills',
            payload: { candidates },
          });
        } catch (error) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'auto_skill_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      case 'confirm_pending_auto_skill': {
        try {
          const savedPath = await confirmPendingSkill(msg.payload.candidateId);
          const candidates = (await listPendingSkillCandidates()).map(
            publicAutoSkillCandidate,
          );
          return this.send(conn.socket, {
            type: 'pending_auto_skills',
            payload: {
              candidates,
              lastAction: {
                kind: 'confirmed',
                candidateId: msg.payload.candidateId,
                savedPath,
              },
            },
          });
        } catch (error) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'auto_skill_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      case 'reject_pending_auto_skill': {
        try {
          await rejectPendingSkill(msg.payload.candidateId);
          const candidates = (await listPendingSkillCandidates()).map(
            publicAutoSkillCandidate,
          );
          return this.send(conn.socket, {
            type: 'pending_auto_skills',
            payload: {
              candidates,
              lastAction: {
                kind: 'rejected',
                candidateId: msg.payload.candidateId,
              },
            },
          });
        } catch (error) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'auto_skill_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
      case 'get_schedules': {
        try {
          const schedules = listLocalSchedules(
            msg.payload.date,
            msg.payload.timezone,
          );
          this.send(conn.socket, {
            type: 'schedules_list',
            payload: { ...msg.payload, schedules },
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'schedule_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'create_schedule': {
        try {
          createLocalSchedule({ ...msg.payload, source: 'user' });
          // createLocalSchedule 的订阅会广播一次；这里给发起连接回一份确定的权威快照。
          this.send(conn.socket, {
            type: 'schedules_list',
            payload: { schedules: listLocalSchedules() },
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'schedule_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'update_schedule': {
        try {
          const { id, ...patch } = msg.payload;
          updateLocalSchedule(id, patch);
          this.send(conn.socket, {
            type: 'schedules_list',
            payload: { schedules: listLocalSchedules() },
          });
        } catch (error) {
          this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'schedule_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      case 'delete_schedule': {
        const deleted = deleteLocalSchedule(msg.payload.id);
        if (!deleted) {
          return this.send(conn.socket, {
            type: 'error',
            payload: { code: 'schedule_failed', message: '未找到要删除的日程' },
          });
        }
        return this.send(conn.socket, {
          type: 'schedules_list',
          payload: { schedules: listLocalSchedules() },
        });
      }
      case 'get_models':
        return this.send(conn.socket, {
          type: 'models_list',
          payload: { models: this.modelInfos(), current: this.currentModel() },
        });
      case 'save_custom_model':
        return this.handleSaveCustomModel(conn, msg);
      case 'delete_custom_model': {
        // 删除自定义模型：成功广播最新 models_list（多窗口同步刷新）；
        // 未命中（可能已被别的窗口删掉）或写盘失败回 error 帧。
        try {
          const removed = deleteCustomModel(msg.payload.id);
          if (!removed) {
            return this.send(conn.socket, {
              type: 'error',
              payload: {
                code: 'delete_failed',
                message: '该模型不存在（可能已被删除）',
              },
            });
          }
          return this.broadcastAll({
            type: 'models_list',
            payload: {
              models: this.modelInfos(),
              current: this.currentModel(),
            },
          });
        } catch (e) {
          return this.send(conn.socket, {
            type: 'error',
            payload: {
              code: 'delete_failed',
              message: `删除失败：${e instanceof Error ? e.message : '未知错误'}`,
            },
          });
        }
      }
      case 'delete_session':
        return this.handleDeleteSession(conn, msg);
      case 'rename_session':
        return this.handleRenameSession(conn, msg);
      case 'get_settings':
        return this.send(conn.socket, {
          type: 'settings',
          payload: this.settingsSnapshot(),
        });
      case 'set_setting':
        return this.handleSetSetting(conn, msg);
      case 'mcp_list':
        return this.send(conn.socket, {
          type: 'mcp_servers',
          payload: { servers: this.mcpServerInfos() },
        });
      case 'mcp_add':
        return this.handleMcpAdd(conn, msg);
      case 'mcp_remove':
        return this.handleMcpRemove(conn, msg);
      case 'get_context_breakdown':
        return this.handleGetContextBreakdown(conn, msg);
      case 'get_stats':
        return this.send(conn.socket, {
          type: 'stats_snapshot',
          payload: this.statsSnapshot(),
        });
      case 'run_doctor':
        return this.handleRunDoctor(conn);
      case 'get_todos':
        return this.send(conn.socket, {
          type: 'todos_list',
          payload: { todos: todoStore.getTodos() as TodoItemInfo[] },
        });
      case 'get_memory':
        return this.handleGetMemory(conn);
      case 'add_memory':
        return this.handleAddMemory(conn, msg);
      case 'get_skills':
        return this.handleGetSkills(conn);
      case 'get_tools':
        return this.handleGetTools(conn, msg);
      case 'compress_context':
        return this.handleCompressContext(conn, msg);
      case 'export_conversation':
        return this.handleExportConversation(conn, msg);
      case 'get_workflows':
        return this.handleGetWorkflows(conn);
      case 'get_extensions':
        return this.handleGetExtensions(conn);
      case 'get_ide_status':
        return this.handleGetIdeStatus(conn);
      case 'get_knowledge':
        return this.handleGetKnowledge(conn, msg);
      case 'search_knowledge':
        return this.handleSearchKnowledge(conn, msg);
      case 'add_knowledge':
        return this.handleAddKnowledge(conn, msg);
      case 'remove_knowledge':
        return this.handleRemoveKnowledge(conn, msg);
      case 'list_slash_commands': {
        const cmds = listSlashCommands();
        return this.send(conn.socket, {
          type: 'slash_commands_list',
          payload: { commands: cmds },
        });
      }
      case 'run_slash_command':
        return this.handleRunSlashCommand(conn, msg);
      default: {
        // 穷尽检查：新增 ClientToServer 分支时编译会在这里提示。
        const _exhaustive: never = msg;
        void _exhaustive;
        return;
      }
    }
  }

  /** 执行斜杠命令；查询回执不落会话库，submit_prompt 复用普通消息入口。 */
  private async handleRunSlashCommand(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'run_slash_command' }>,
  ): Promise<void> {
    const { sessionId, name, args } = msg.payload;
    if (!this.store.getSession(sessionId)) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }
    const outcome = await executeSlashCommand(
      this.buildCommandHost(),
      sessionId,
      name,
      args ?? '',
    );
    if (outcome.kind === 'submit_prompt') {
      const session = this.store.getSession(sessionId);
      if (
        session &&
        (session.status === 'thinking' || session.status === 'streaming')
      ) {
        this.send(conn.socket, {
          type: 'slash_command_result',
          payload: {
            sessionId,
            name,
            args: args ?? '',
            ok: false,
            markdown: `该会话正在生成回复，/${name} 未提交。请稍候或先取消，再重试。`,
          },
        });
        return;
      }
      this.send(conn.socket, {
        type: 'slash_command_result',
        payload: {
          sessionId,
          name,
          args: args ?? '',
          ok: true,
          markdown: outcome.note,
        },
      });
      await this.handleSendUserMessage(conn, {
        type: 'send_user_message',
        payload: {
          sessionId,
          content: [{ type: 'text', value: outcome.content }],
          source: 'local',
        },
      });
      return;
    }
    this.send(conn.socket, {
      type: 'slash_command_result',
      payload: {
        sessionId,
        name,
        args: args ?? '',
        ok: outcome.ok,
        markdown: outcome.markdown,
      },
    });
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

    // 会话正忙（thinking/streaming）：走消息队列而非直接拒绝。
    if (session.status === 'thinking' || session.status === 'streaming') {
      const queueAction: 'merge' | 'next_turn' | 'new_session' =
        msg.payload.queueAction ?? 'next_turn';

      // new_session: 创建新会话并路由消息
      if (queueAction === 'new_session') {
        const newSummary = this.store.createSession();
        this.broadcastAll({ type: 'session_upsert', payload: { session: newSummary } });
        return this.handleSendUserMessageRaw(
          newSummary.sessionId, conn, content, source, clientMessageId);
      }

      // merge / next_turn: 入队等待
      const queue = this.getOrCreateQueue(sessionId);
      const queued: QueuedMessage = {
        content,
        source,
        clientMessageId,
        queueAction,
      };
      queue.push(queued);
      return this.send(conn.socket, {
        type: 'message_queued',
        payload: { sessionId, queuePosition: queue.length, clientMessageId },
      });
    }

    return this.handleSendUserMessageRaw(sessionId, conn, content, source, clientMessageId);
  }

  /**
   * Raw message ingestion (after busy/new-session routing).
   * De-duplicated from handleSendUserMessage: session optional checks
   * and OttoSessionManager touches are done in the caller.
   */
  private async handleSendUserMessageRaw(
    sessionId: string,
    conn: ClientConn,
    content: MessageContent,
    source: MessageSource,
    clientMessageId?: string,
  ): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return this.send(
        conn.socket,
        errorFrame(sessionId, 'no_session', '会话不存在'),
      );
    }

    // ── OttoSessionManager ──
    try {
      const sessionMgr = getSessionManager();
      sessionMgr.touchSession(sessionId);
      const text = plainTextOf(content);
      if (text) {
        const topics = sessionMgr.inferTopics(text);
        for (const t of topics) {
          sessionMgr.addTopic(sessionId, t).catch(() => undefined);
        }
      }
      if (sessionMgr.shouldSplit(sessionId)) {
        sessionMgr
          .splitSession(sessionId, 'by_topic')
          .catch((e: unknown) =>
            console.warn('[Server] Auto-split session failed:', e),
          );
      }
    } catch {
      // session manager 非关键路径，静默降级
    }

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

    // 内部测试阶段所有身份都必须先绑定自己的 API。真实运行不允许回退 mock
    if (!this.shouldMock() && this.modelInfos().every((model) => !model.enabled)) {
      this.store.publish(sessionId, {
        type: 'error',
        payload: {
          sessionId,
          code: 'model_not_configured',
          message: '请先在设置中绑定个人 API，再开始对话。',
        },
      });
      this.store.setStatus(sessionId, 'error');
      return;
    }

    if (this.shouldMock()) {
      await this.mockEcho(sessionId);
      return;
    }

    const runtime = await this.ensureRuntime(sessionId);
    if (!runtime) {
      this.store.setStatus(sessionId, 'idle');
      return;
    }
    await runtime.run(content, source);

    this.captureKnowledgeAsync(sessionId);
    this.drainQueuedMessages(sessionId, conn);
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
        runtime.setAuthorizationMode?.(
          this.sessionAuthorizationModes.get(sessionId) ??
            this.globalAuthorizationMode,
        );
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

  /**
   * 异步自动沉淀知识库（fire-and-forget，不使用 await 避免阻塞主流程）。
   * 从会话历史构建 SimpleMessage[]，喂给 KnowledgeCapture 做判断和提取。
   * 沉淀失败静默忽略——知识库是增值功能，不能拖慢/阻断对话。
   */
  private captureKnowledgeAsync(sessionId: string): void {
    setTimeout(async () => {
      try {
        const history = this.store.getHistory(sessionId);
        if (!history || history.length === 0) return;

        const messages: SimpleMessage[] = history.map((msg) => {
          const text = plainTextOf(msg.content);
          const role =
            msg.role === 'user'
              ? 'user'
              : msg.role === 'assistant'
                ? 'assistant'
                : 'tool';
          // tool 结果：判断是否有成功标志（非 error 开头的文本）
          const toolSuccess =
            role === 'tool' && !/^(error|fail|exception)/i.test(text);
          return {
            role: role as 'user' | 'assistant' | 'tool',
            text,
            ...(role === 'tool' ? { toolSuccess } : {}),
          };
        });

        // 用同一个 knowledgeStore 实例，确保去重跨会话生效
        const capture = new KnowledgeCapture(this.knowledgeStore);
        if (!capture.shouldCapture(messages)) return;

        const candidates = capture.extractCandidates(messages, sessionId);
        if (candidates.length === 0) return;

        const result = await capture.ingestCandidates(candidates);

        // 广播 knowledge_activity 帧通知桌面端
        if (result.written > 0) {
          const entries = await this.knowledgeStore.list(5);
          this.broadcastAll({
            type: 'knowledge_activity',
            payload: {
              action: 'auto_capture',
              sessionId,
              written: result.written,
              skippedDuplicate: result.skippedDuplicate,
              skippedSanitized: result.skippedSanitized,
              skippedLowConfidence: result.skippedLowConfidence,
              recent: entries,
            },
          });
        }

        console.log(
          `[Server] Knowledge capture for ${sessionId}: written=${result.written} ` +
            `dup=${result.skippedDuplicate} sanitized=${result.skippedSanitized} ` +
            `lowConf=${result.skippedLowConfidence}`,
        );
      } catch (e) {
        // 沉淀失败静默忽略，不阻断对话
        console.warn(
          '[Server] Knowledge capture failed (non-fatal):',
          e instanceof Error ? e.message : e,
        );
      }
    }, 100);
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
      payload: { sessionId, messageId: assistant.id, text },
    });
    this.store.setStatus(sessionId, 'idle');
  }

  private subscribeConn(conn: ClientConn, sessionId: string): void {
    if (conn.subscriptions.has(sessionId)) return;
    const session = this.store.getSession(sessionId);
    if (!session) {
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
    // 再单发一帧当前会话状态：session_status 只在状态变化时广播，切走再切回的
    // 客户端错过了那次广播，不告知就不知道该会话还在 thinking/streaming，
    // 「正在生成」UI 恢复不出来（任务看起来像被切断了）。
    this.send(conn.socket, {
      type: 'session_status',
      payload: { sessionId, status: session.status },
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

  // ── Personal Knowledge Base handlers ────────────────────────────────────────────────────

  private knowledgeStore = new LocalKnowledgeStore();

  private async handleGetKnowledge(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'get_knowledge' }>,
  ): Promise<void> {
    try {
      const entries = await this.knowledgeStore.list(msg.payload.limit ?? 50);
      this.send(conn.socket, {
        type: 'knowledge_data',
        payload: { entries, action: 'list' },
      });
    } catch (e) {
      this.send(
        conn.socket,
        errorFrame(
          '',
          'knowledge_error',
          `knowledge load failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  private async handleSearchKnowledge(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'search_knowledge' }>,
  ): Promise<void> {
    try {
      const entries = await this.knowledgeStore.search(
        msg.payload.query,
        msg.payload.category,
      );
      this.send(conn.socket, {
        type: 'knowledge_data',
        payload: { entries, action: 'search', query: msg.payload.query },
      });
    } catch (e) {
      this.send(
        conn.socket,
        errorFrame(
          '',
          'knowledge_error',
          `knowledge search failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  private async handleAddKnowledge(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'add_knowledge' }>,
  ): Promise<void> {
    try {
      const entry = await this.knowledgeStore.add(
        msg.payload.category ?? 'general',
        msg.payload.content,
        msg.payload.tags ?? [],
      );
      this.send(conn.socket, {
        type: 'knowledge_added',
        payload: { entry },
      });
    } catch (e) {
      this.send(
        conn.socket,
        errorFrame(
          '',
          'knowledge_error',
          `knowledge add failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  private async handleRemoveKnowledge(
    conn: ClientConn,
    msg: Extract<ClientToServer, { type: 'remove_knowledge' }>,
  ): Promise<void> {
    try {
      const removed = await this.knowledgeStore.remove(msg.payload.id);
      if (!removed) {
        this.send(
          conn.socket,
          errorFrame(
            '',
            'knowledge_error',
            `entry ${msg.payload.id} not found`,
          ),
        );
        return;
      }
      this.send(conn.socket, {
        type: 'knowledge_removed',
        payload: { id: msg.payload.id },
      });
    } catch (e) {
      this.send(
        conn.socket,
        errorFrame(
          '',
          'knowledge_error',
          `knowledge remove failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  // ── Message queue (PR 2: busy 时排队，turn 完成后 drain) ──

  private readonly messageQueues = new Map<string, QueuedMessage[]>();

  private getOrCreateQueue(sessionId: string): QueuedMessage[] {
    let q = this.messageQueues.get(sessionId);
    if (!q) { q = []; this.messageQueues.set(sessionId, q); }
    return q;
  }

  private drainQueuedMessages(sessionId: string, conn: ClientConn): void {
    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    if (queue.length === 0) this.messageQueues.delete(sessionId);
    // fire-and-forget: 下一轮不阻塞当前返回
    setImmediate(() => {
      this.handleSendUserMessageRaw(
        sessionId, conn, next.content, next.source, next.clientMessageId);
    });
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

/** 读并解析 JSON 请求体（64KB 上限——凭证表单远小于此）。 */
function readJsonBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 校验 POST /feishu/config 请求体；通过返回规整后的请求，不通过返回错误文案。 */
function parseFeishuConfigSaveRequest(
  body: unknown,
): FeishuConfigSaveRequest | string {
  if (typeof body !== 'object' || body === null)
    return '请求体必须是 JSON 对象';
  const input = body as Record<string, unknown>;
  const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
  if (!appId) return '请填写 App ID（形如 cli_xxx）。';
  const domain = input.domain;
  if (domain !== 'feishu' && domain !== 'lark') {
    return 'domain 必须是 feishu（飞书）或 lark（Lark 国际版）。';
  }
  const appSecret =
    typeof input.appSecret === 'string' && input.appSecret.trim()
      ? input.appSecret.trim()
      : undefined;
  const ownerOpenId =
    typeof input.ownerOpenId === 'string' && input.ownerOpenId.trim()
      ? input.ownerOpenId.trim()
      : undefined;
  return {
    appId,
    domain,
    ...(appSecret ? { appSecret } : {}),
    ...(ownerOpenId ? { ownerOpenId } : {}),
  };
}
/** core WorkflowAgentRecord → 协议 WorkflowAgentSummary（裁掉 prompt/recentToolCalls 等大字段）。 */
function toWorkflowAgentSummary(a: WorkflowAgentRecord): WorkflowAgentSummary {
  return {
    agentId: a.agentId,
    label: a.label,
    status: a.status,
    startTime: a.startTime,
    endTime: a.endTime,
    tokenUsage: a.tokenUsage,
    toolCallCount: a.toolCallCount,
    currentPhase: a.currentPhase,
    outcome: a.outcome,
  };
}

/** 扩展目录约定：<root>/.otto-user/extensions/<name>/gemini-extension.json（对齐 CLI loadExtensions）。 */
const EXTENSIONS_DIR_SEGMENTS = ['.otto-user', 'extensions'] as const;
const EXTENSION_CONFIG_FILENAME = 'gemini-extension.json';

async function loadExtensionSummariesFromDir(
  rootDir: string,
): Promise<ExtensionSummary[]> {
  const extensionsDir = path.join(rootDir, ...EXTENSIONS_DIR_SEGMENTS);
  let subdirs: string[];
  try {
    subdirs = await fs.readdir(extensionsDir);
  } catch {
    return [];
  }
  const summaries: ExtensionSummary[] = [];
  for (const subdir of subdirs) {
    const extensionDir = path.join(extensionsDir, subdir);
    const configPath = path.join(extensionDir, EXTENSION_CONFIG_FILENAME);
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (typeof parsed.name === 'string') {
        summaries.push({
          name: parsed.name,
          version:
            typeof parsed.version === 'string' ? parsed.version : '0.0.0',
          path: extensionDir,
        });
      }
    } catch {
      // 单个扩展目录缺配置/解析失败：跳过，不影响其余扩展。
    }
  }
  return summaries;
}

/** 项目级 + 全局扩展目录合并去重（同名保留项目级优先，对齐 CLI loadExtensions 的语义）。 */
async function discoverExtensionSummaries(
  workspaceDir: string,
): Promise<ExtensionSummary[]> {
  const [workspaceExt, globalExt] = await Promise.all([
    loadExtensionSummariesFromDir(workspaceDir),
    loadExtensionSummariesFromDir(homedir()),
  ]);
  const byName = new Map<string, ExtensionSummary>();
  for (const ext of [...workspaceExt, ...globalExt]) {
    if (!byName.has(ext.name)) byName.set(ext.name, ext);
  }
  return Array.from(byName.values());
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
