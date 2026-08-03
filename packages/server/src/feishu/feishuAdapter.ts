/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书适配器（server 侧的「飞书 ↔ 会话源」桥接）。
 *
 * 这是 Issue #3 的核心：把 cli 的纯网关（vendor/gateway.ts）接入 server 的
 * 唯一会话源（SessionStore），实现**双向同步**：
 *
 *   飞书 → app：gateway.onMessage 收到飞书消息
 *     → 鉴权（复用 credentials.isSenderAuthorized）
 *     → store.getOrCreateFeishuSession(chatId) 映射成 source:'feishu' 会话
 *     → appendMessage + broadcast(message_start) 让 app（Electron）实时看到
 *     → 首条消息经 ensureRuntime 懒建隔离 core runtime，再执行 run()
 *     → core 流式帧经 streamBridge 既广播给 app、又节流回推飞书卡片。
 *
 *   app → 飞书：pushToFeishu(chatId, text) → gateway.sendMarkdown
 *     （server.ts 在 send_user_message(source:'local') 命中飞书会话时调用）。
 *
 * 与 cli `feishuCommand.ts` 的差异（宿主依赖替换，逻辑保留）：
 *   - `tuiContext.addItem(...)`（往 Ink history 打日志）→ 改为 deps.broadcast 的
 *     WS 事件帧 / logger，no-op 化（server 无界面）。
 *   - `appEvents.emit(AppEvent.Feishu*)`（驱动 FeishuStatusDashboard）→ 同上，
 *     由 WS 协议帧承载（双向同步视图 Issue #6 用 session_upsert / message_start）。
 *   - `isolatedSessions: Map<chatId, {config, geminiClient}>` → 提升为 store 的
 *     getOrCreateFeishuSession（store 本就是唯一会话源，天然就是隔离会话表）。
 *   - 工具确认 / slash 命令分发（CommandService 等强 CLI 耦合）→ 暂不迁，留 TODO。
 */

import { createHash } from 'node:crypto';

import { loadCredentials, isSenderAuthorized } from './vendor/credentials.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import { FeishuGateway, FeishuGatewayLockError } from './vendor/gateway.js';
import type { FeishuMessage, OnMeetingEndedCallback } from './vendor/gateway.js';
import {
  bridgeSessionToFeishu,
  type FeishuStreamSink,
} from './streamBridge.js';
import type {
  SessionRuntime,
  SessionStore,
  Unsubscribe,
} from '../sessions.js';
import type {
  FeishuHealthStatus,
  MessageContent,
  ServerToClient,
  SessionSummary,
} from '../protocol.js';
import { FeishuInboundQueue } from './inboundQueue.js';

/**
 * adapter 实际用到的 gateway 能力子集（结构子类型）。
 *
 * 真实 `FeishuGateway` 天然满足此接口（它的方法是其超集）。抽出接口让 adapter
 * 不强绑具体类，便于测试注入 fake gateway 驱动 onMessage 链路（无需真飞书凭证/连接）。
 */
export interface FeishuGatewayLike extends FeishuStreamSink {
  onMessage: ((msg: FeishuMessage) => Promise<string | null>) | null;
  onMeetingEnded?: OnMeetingEndedCallback | null;
  onReady: (() => void) | null;
  onDisconnect: ((error?: Error) => void) | null;
  /** SDK 内部重连开始/成功（可选：老 fake / 精简实现可以不提供）。 */
  onReconnecting?: (() => void) | null;
  onReconnected?: (() => void) | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * 底层连接健康快照（可选）：僵尸探测用。socketOpen=null 表示「读不到、
   * 视为未知」，探测方不得据此判死，避免误杀健康连接。
   */
  getConnectionHealth?(): { hasClient: boolean; socketOpen: boolean | null };
  /** Interactive confirmation; the real gateway validates the card operator. */
  waitForCardAction?(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs?: number,
    replyToMessageId?: string,
  ): Promise<string>;
}

// ── 守护参数（连上一次之后就不允许永久断开：无限重连 + 心跳探活）──

/** 重连退避起步（1s）。 */
const RECONNECT_BASE_MS = 1_000;
/** 重连退避上限（60s）。达到上限后维持此间隔无限重试，永不放弃。 */
const RECONNECT_MAX_MS = 60_000;
/** 心跳周期：探测僵尸连接 / 兜底补排重连。 */
const HEARTBEAT_INTERVAL_MS = 60_000;
/**
 * 建连悬挂 / SDK 内部重连的接管时限。
 *
 * 为什么需要：SDK（WSClient）自带无限内部重连，断网时 gateway.connect() 的
 * Promise 会长期不落定（既不 resolve 也不 reject）——这是正常自愈路径，上层
 * 不应立刻拆台。但若 SDK 内部循环意外死掉（Promise 永远悬着、也不再重试），
 * 没有时限就等于永久断开。10 分钟（SDK 内部约 5 轮重试的窗口）仍未恢复，
 * 上层强制收尾重来，保证「永不放弃」不依赖 SDK 内部实现的正确性。
 */
const TAKEOVER_STUCK_MS = 10 * 60_000;
/** 僵尸判定需要的连续心跳次数（防单次抖动误判：2 次 ≈ 持续 1 分钟以上）。 */
const ZOMBIE_STRIKE_LIMIT = 2;

/** gateway 工厂：缺省 = new FeishuGateway；测试可注入 fake。 */
export type FeishuGatewayFactory = (
  creds: FeishuCredentials,
) => FeishuGatewayLike;

/** 适配器依赖（由 registerFeishu 注入，源自 server.start）。 */
export interface FeishuAdapterDeps {
  store: SessionStore;
  /**
   * 取得当前身份可用的飞书会话。生产 server 用它在首条
   * 消息时绑定中心账号/组织；独立 adapter 测试仍可回退 store 默认实现。
   */
  getOrCreateSession?: (chatId: string, title?: string) => SessionSummary;
  /** 把一帧广播给某会话订阅者（= store.publish 的薄封装）。 */
  broadcast: (sessionId: string, frame: ServerToClient) => void;
  /**
   * 为飞书会话取得或懒创建真实 core runtime。
   *
   * 官方 EasyCode 会在每个 chat 首条消息到达时先初始化隔离 Config/LLM client；
   * Otto 对应的单一入口是 server.ensureRuntime，必须由生产 registerFeishu 注入。
   */
  ensureRuntime?: (
    sessionId: string,
  ) => Promise<SessionRuntime | undefined>;
  /** 企业功能开关；返回 false 时授权用户也只收到停用提示，不触发 runtime。 */
  shouldAutoReply?: (senderOpenId: string) => boolean | Promise<boolean>;
  /** 仅供显式测试/开发模式使用；生产缺省 false，绝不把 mock 冒充 AI 回复。 */
  mock?: boolean;
  /** 可选凭证注入（测试用）；缺省走 loadCredentials() 读盘。 */
  credentials?: FeishuCredentials | null;
  /** 可选 gateway 工厂（测试用）；缺省 new FeishuGateway。 */
  gatewayFactory?: FeishuGatewayFactory;
  /** Durable inbound queue path. null keeps isolated tests in memory. */
  inboundQueuePath?: string | null;
}

/**
 * FeishuAdapter：持有 gateway 实例、连接态、每会话回推桥订阅。
 */
export class FeishuAdapter {
  private readonly store: SessionStore;
  private readonly broadcast: FeishuAdapterDeps['broadcast'];
  private readonly getOrCreateSession: NonNullable<
    FeishuAdapterDeps['getOrCreateSession']
  >;
  private readonly ensureRuntime: FeishuAdapterDeps['ensureRuntime'];
  private readonly shouldAutoReply: FeishuAdapterDeps['shouldAutoReply'];
  private readonly mock: boolean;
  private gateway: FeishuGatewayLike | null = null;
  private creds: FeishuCredentials | null = null;
  private connected = false;
  private readonly injectedCreds?: FeishuCredentials | null;
  private readonly gatewayFactory: FeishuGatewayFactory;
  private readonly inboundQueue: FeishuInboundQueue;
  private inboundDraining = false;
  private inboundRetryTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 守护状态（重连循环 + 心跳 + 对外可见状态）──
  /** 用户主动 stop 过（有意停止后绝不自动重连；start 重新调用时恢复守护）。 */
  private stopped = false;
  /** 一次 connect() 正在飞（防并发重复建连）。 */
  private connecting = false;
  /** 当前这次 connect() 的起点（悬挂超时接管用）；未在连为 null。 */
  private connectStartedAt: number | null = null;
  /** SDK 内部重连的开始时间（超时接管用）；SDK 未在自愈为 null。 */
  private sdkReconnectingSince: number | null = null;
  /** adapter 层重连排程句柄；无排程为 null。stop() 必须清干净，杜绝幽灵重连。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 心跳句柄（僵尸探测 + 守护兜底）。 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 自上次成功以来 adapter 层已发起的重连尝试次数（成功归零 → 退避归零）。 */
  private reconnectAttempts = 0;
  /** 僵尸判定连击计数（连续 ZOMBIE_STRIKE_LIMIT 次探到 socket 已死才动手）。 */
  private zombieStrikes = 0;
  // 对外状态（getStatus / health 端点透出）。
  private lastConnectedAt: number | null = null;
  private lastDisconnectAt: number | null = null;
  private lastDisconnectReason: string | null = null;
  private nextRetryAt: number | null = null;
  private lockHeldByOtherPid: number | null = null;

  /** 已挂回推桥的飞书会话（sessionId → 取消订阅），避免重复订阅导致重复回推。 */
  private readonly bridged = new Map<string, Unsubscribe>();
  /** 当前真正执行轮的飞书消息 id；bridge 在 assistant message_start 时快照。 */
  private readonly replyTargets = new Map<string, string>();
  /**
   * 会话淘汰监听取消句柄：会话被 store 容量淘汰时，连带摘除其回推桥。
   * 生命周期跟随 start()/stop()（而非构造器）——运行期 stop 后再 start
   * （守护恢复）时监听必须能重建，否则第二段生命周期里桥订阅会泄漏。
   */
  private offEvict: Unsubscribe | null = null;

  constructor(deps: FeishuAdapterDeps) {
    this.store = deps.store;
    this.broadcast = deps.broadcast;
    this.getOrCreateSession =
      deps.getOrCreateSession
      ?? ((chatId, title) => this.store.getOrCreateFeishuSession(chatId, title));
    this.ensureRuntime = deps.ensureRuntime;
    this.shouldAutoReply = deps.shouldAutoReply;
    this.mock = deps.mock ?? false;
    this.injectedCreds = deps.credentials;
    this.gatewayFactory =
      deps.gatewayFactory ??
      ((creds) =>
        new FeishuGateway(creds.appId, creds.appSecret, creds.domain));
    this.inboundQueue = new FeishuInboundQueue(deps.inboundQueuePath ?? null);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 守护状态快照（server /health 与桌面端徽标共用）。
   *
   * 诚实原则：锁被别的进程拿着时给出 lockHeldByOtherPid，绝不谎报已连接；
   * reconnecting 覆盖三种「正在抢救」形态——adapter 排程中 / connect 在飞 /
   * SDK 内部自愈中。
   */
  getStatus(): FeishuHealthStatus {
    const inbound = this.inboundQueue.summary();
    return {
      configured: this.creds !== null,
      running: this.gateway !== null && !this.stopped,
      connected: this.connected,
      reconnecting:
        !this.connected &&
        this.gateway !== null &&
        !this.stopped &&
        (this.connecting ||
          this.reconnectTimer !== null ||
          this.sdkReconnectingSince !== null),
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectAt: this.lastDisconnectAt,
      lastDisconnectReason: this.lastDisconnectReason,
      reconnectAttempts: this.reconnectAttempts,
      nextRetryAt: this.nextRetryAt,
      lockHeldByOtherPid: this.lockHeldByOtherPid,
      inboundQueue: inbound,
    };
  }

  /**
   * 启动：加载凭证 → new FeishuGateway → 接回调 → 发起建连并进入守护。
   *
   * 凭证缺失时**不抛错**：返回未连接状态（server 仍可正常跑，飞书只是没启用）。
   * 这样 enableFeishu 但用户尚未 setup 飞书凭证时，server 启动不被阻断。
   *
   * 与旧版的关键差异：**不再 await 建连结果**。SDK 断网时 connect() 会长期
   * 悬挂（内部无限重连、Promise 不落定），await 会把 server 启动整个卡死。
   * 现在 start() 只负责接线 + 发起首次建连 + 挂心跳，连接结果经 onReady /
   * 重连循环异步收敛——server 启动时断网，网络恢复后也能自己连上。
   */
  async start(): Promise<void> {
    if (this.gateway) {
      // 已在跑：幂等返回，不重复建网关/心跳（避免双守护互相拆台）。
      logWarn('飞书网关已在运行，忽略重复 start。');
      return;
    }
    this.stopped = false;

    // 1) 凭证：优先注入（测试），否则读盘。
    try {
      this.creds =
        this.injectedCreds !== undefined
          ? this.injectedCreds
          : await loadCredentials();
    } catch (e) {
      // CredentialsLoadError（损坏/换密钥）—— 记录但不崩，视为未配置。
      this.creds = null;
      logWarn(`飞书凭证加载失败，飞书网关不启动：${errMsg(e)}`);
    }
    if (!this.creds) {
      logWarn('未发现飞书凭证（~/.otto-user/feishu-credentials.json），飞书网关跳过启动。');
      return;
    }

    // 2) 会话淘汰监听：会话被 store 容量淘汰时，连带摘除其回推桥订阅
    //    （避免桥订阅泄漏 / 对已淘汰会话仍回推）。start/stop 成对注册/注销。
    this.offEvict ??= this.store.onEvict((sessionId) => {
      const unsub = this.bridged.get(sessionId);
      if (unsub) {
        try {
          unsub();
        } catch {
          // 取消订阅失败不影响后续清理。
        }
        this.bridged.delete(sessionId);
      }
      this.replyTargets.delete(sessionId);
    });

    // 3) 建网关并接线（缺省 new FeishuGateway；测试可注入 fake）。
    const creds = this.creds;
    const gateway = this.gatewayFactory(creds);
    this.gateway = gateway;

    gateway.onReady = () => this.handleConnected('已连接（WS 长连接就绪）');
    gateway.onDisconnect = (error?: Error) => {
      this.connected = false;
      this.lastDisconnectAt = Date.now();
      this.lastDisconnectReason = error?.message ?? '连接断开（未给出原因）';
      if (this.stopped) return; // 有意停止的收尾断开，不进重连循环
      logWarn(
        `飞书网关断开${error ? `：${error.message}` : ''}，转入自动重连。`,
      );
      this.scheduleReconnect(this.lastDisconnectReason);
    };
    // SDK 内部自愈事件（可选回调；真 gateway 已透传，老 fake 不接也不影响）：
    // 自愈期间状态如实标记「未连接/重连中」，自愈成功等价于一次 onReady。
    gateway.onReconnecting = () => {
      this.connected = false;
      if (this.sdkReconnectingSince === null) {
        this.sdkReconnectingSince = Date.now();
        this.lastDisconnectAt = Date.now();
        this.lastDisconnectReason = 'WS 掉线，SDK 内部重连中';
        logWarn('飞书 WS 掉线，SDK 内部重连中…');
      }
    };
    gateway.onReconnected = () =>
      this.handleConnected('SDK 内部重连成功，连接恢复');

    gateway.onMessage = (msg) => this.handleFeishuMessage(msg, creds);
    this.scheduleInboundDrain();

    // 4) 心跳守护：僵尸探测 + 悬挂接管 + 兜底补排（详见 heartbeatTick）。
    this.heartbeatTimer = setInterval(
      () => this.heartbeatTick(),
      HEARTBEAT_INTERVAL_MS,
    );
    // 心跳不该拽住进程退出（Node 环境才有 unref；类型上防御 fake timer）。
    (this.heartbeatTimer as { unref?: () => void }).unref?.();

    // 5) 发起首次建连（不 await：失败/悬挂都由守护循环接管，见方法注释）。
    void this.attemptConnect();
  }

  // ────────────────────────────────────────────────────────────────────
  // 守护循环：断线自动重连（指数退避 + 抖动，无限次）+ 心跳探活
  // ────────────────────────────────────────────────────────────────────

  /** 连接成功的统一收口（onReady / onReconnected 共用）：归零退避、撤排程。 */
  private handleConnected(reason: string): void {
    this.connected = true;
    this.lastConnectedAt = Date.now();
    this.reconnectAttempts = 0; // 成功 → 退避归零，下次断线从 1s 重新起步
    this.nextRetryAt = null;
    this.lockHeldByOtherPid = null;
    this.sdkReconnectingSince = null;
    this.zombieStrikes = 0;
    // SDK 抢先自愈成功时，撤掉 adapter 层的冗余排程，别到点去拆健康连接。
    this.clearReconnectTimer();
    logInfo(`飞书网关${reason}。`);
  }

  /**
   * 发起一次建连尝试。失败 → 排下一次重试；成功 → onReady 收口。
   *
   * 注意：断网时真 gateway.connect() 可能长期悬挂（SDK 内部无限重连），
   * 此时 connecting 一直为 true——这是正常自愈路径；若悬挂超过
   * TAKEOVER_STUCK_MS 仍未连上，心跳会强制收尾重来。
   */
  private async attemptConnect(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway || this.stopped || this.connected || this.connecting) return;
    this.connecting = true;
    this.connectStartedAt = Date.now();
    try {
      await gateway.connect();
      // 成功路径的状态归位在 onReady 里（真 gateway resolve 与 onReady 同步发生）。
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof FeishuGatewayLockError) {
        // 锁冲突：另一进程（如 CLI daemon）持有同 appId 连接。诚实上报持有者
        // pid，且**继续退避重试**——对方退出后本进程可接管，无需人工干预。
        this.lockHeldByOtherPid = e.holderPid;
        this.lastDisconnectReason = `连接锁被另一进程持有（pid ${e.holderPid}）`;
      } else {
        this.lockHeldByOtherPid = null;
        this.lastDisconnectReason = errMsg(e);
      }
      this.scheduleReconnect(this.lastDisconnectReason);
    } finally {
      this.connecting = false;
      this.connectStartedAt = null;
    }
  }

  /**
   * 排一次重连（指数退避 + 抖动，1s 起步、60s 封顶，无限次）。
   * 幂等：已有排程 / 已连接 / 已停止时不重复排。日志一次一行，不刷屏。
   */
  private scheduleReconnect(reason: string): void {
    if (this.stopped || !this.gateway) return;
    if (this.connected || this.reconnectTimer) return;
    const delay = this.nextBackoffMs();
    this.reconnectAttempts += 1;
    this.nextRetryAt = Date.now() + delay;
    logWarn(
      `飞书重连第 ${this.reconnectAttempts} 次将于 ${Math.round(delay / 1000)}s 后发起（${reason}）。`,
    );
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      void this.attemptConnect();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.reconnectTimer = timer;
  }

  /** 退避计算：min(60s, 1s·2^n)，±20% 抖动防多实例齐射。 */
  private nextBackoffMs(): number {
    const exp = Math.min(this.reconnectAttempts, 6); // 2^6=64 → 已越上限，封顶
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exp);
    return Math.min(
      RECONNECT_MAX_MS,
      Math.round(base * (0.8 + Math.random() * 0.4)),
    );
  }

  /** 撤销 adapter 层重连排程（成功收口 / stop 收尾用）。 */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextRetryAt = null;
  }

  /**
   * 强制重连：把旧连接干净收尾（关 WS、释放连接锁）后进重连循环。
   * 僵尸连接 / 悬挂超时的出口。收尾失败不阻断——下一次 connect() 内部
   * 还会再 disconnect 一遍（gateway.connect 自带先清后连）。
   */
  private async forceReconnect(reason: string): Promise<void> {
    if (this.stopped || !this.gateway) return;
    logWarn(`飞书强制重连：${reason}`);
    this.connected = false;
    this.connecting = false;
    this.connectStartedAt = null;
    this.sdkReconnectingSince = null;
    this.lastDisconnectAt = Date.now();
    this.lastDisconnectReason = reason;
    try {
      await this.gateway.disconnect();
    } catch {
      // 收尾失败不阻断重连。
    }
    this.scheduleReconnect(reason);
  }

  /**
   * 心跳（每 60s）：
   *   1. 已连接 → 僵尸探测：底层 socket 连续两拍非 OPEN（SDK 自以为连着、
   *      实际已死）→ 强制走重连循环。探测走 gateway 内部状态快照，零网络开销；
   *      读不到（返回 null / fake gateway 未实现）视为未知，不误杀。
   *   2. 未连接且 connect() 悬挂超时 / SDK 内部自愈超时 → 强制接管重来。
   *   3. 未连接且无人在抢救（无排程、无在飞的 connect、SDK 也没在自愈）→
   *      兜底补排一次。正常流程到不了这里，纯防御：任何漏网路径最迟 60s 被拉回。
   */
  private heartbeatTick(): void {
    if (this.stopped || !this.gateway) return;

    if (this.connected) {
      const health = this.gateway.getConnectionHealth?.();
      const dead =
        health !== undefined &&
        (!health.hasClient || health.socketOpen === false);
      if (dead) {
        this.zombieStrikes += 1;
        if (this.zombieStrikes >= ZOMBIE_STRIKE_LIMIT) {
          this.zombieStrikes = 0;
          void this.forceReconnect(
            '僵尸连接：心跳连续探测到底层 socket 已断，但连接状态未更新',
          );
        }
      } else {
        this.zombieStrikes = 0;
      }
      return;
    }

    if (this.reconnectTimer) return; // 已有排程，等它到点

    if (this.connecting) {
      if (
        this.connectStartedAt !== null &&
        Date.now() - this.connectStartedAt > TAKEOVER_STUCK_MS
      ) {
        void this.forceReconnect('建连尝试悬挂超时（>10 分钟），上层接管重来');
      }
      return;
    }

    if (this.sdkReconnectingSince !== null) {
      if (Date.now() - this.sdkReconnectingSince > TAKEOVER_STUCK_MS) {
        void this.forceReconnect('SDK 内部重连超时（>10 分钟），上层接管重来');
      }
      return;
    }

    this.scheduleReconnect('心跳兜底：连接未在守护中');
  }

  /**
   * 飞书入站消息处理（gateway.onMessage 回调）。
   *
   * 返回 null：回复一律经 streamBridge 推回飞书卡片，不走 onMessage 返回值。
   */
  private async handleFeishuMessage(
    msg: FeishuMessage,
    creds: FeishuCredentials,
  ): Promise<string | null> {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return null;

    // 🛡️ 鉴权（复用 cli 同源逻辑）：仅 owner / allowlist 可触发 agent。
    // 与 cli 一致 fail-closed：未配置授权用户时一律拒绝，杜绝 Bot 成 RCE 入口。
    if (!isSenderAuthorized(creds, msg.senderOpenId)) {
      const reply = creds.ownerOpenId
        ? `🛡️ 此 Bot 仅响应授权用户。请联系 Bot 拥有者添加你（open_id: ${msg.senderOpenId}）。`
        : `🛡️ 此 Bot 尚未配置授权用户（open_id: ${msg.senderOpenId}）。`;
      // 直接回推一句（不进会话源，避免未授权噪声污染唯一会话源）。
      if (this.gateway) {
        await this.gateway
          .sendMarkdown(msg.chatId, reply, msg.messageId)
          .catch(() => undefined);
      }
      return null;
    }

    if (this.shouldAutoReply && !(await this.shouldAutoReply(msg.senderOpenId))) {
      if (this.gateway) {
        await this.gateway
          .sendMarkdown(
            msg.chatId,
            '⏸️ 当前企业已关闭飞书自动回答，请联系企业管理员开启。',
            msg.messageId,
          )
          .catch(() => undefined);
      }
      return null;
    }

    // TODO(Issue #3 增强): 生命周期 / /bind / /restart / slash 命令拦截。
    //   cli feishuCommand 在这里拦截 `/feishu start|stop`、`/bind`、`/restart`、
    //   slash 命令。server 版暂不迁这些强 CLI 耦合命令（它们依赖 CommandService /
    //   进程自重启），先让普通对话走通。命中这些前缀时当前按普通消息透传给 core。

    const eventId = this.feishuEventId(msg);
    const alreadyAccepted = this.inboundQueue.get(eventId);
    if (alreadyAccepted) {
      this.scheduleInboundDrain();
      return null;
    }

    // 映射飞书会话 → server 唯一会话源（source:'feishu'）。
    const previousSessionId = this.peekFeishuSessionId(msg.chatId);
    const session = this.getOrCreateSession(msg.chatId);
    // 身份变更后同一 chatId 会映射到新租户会话，此时也必须
    // 按新会话广播，不得因历史 feishuChatId 存在而跳过。
    const wasNew = previousSessionId !== session.sessionId;

    // 新飞书会话：广播 session_upsert，让 app 会话列表实时出现飞书会话。
    if (wasNew) {
      this.broadcast(session.sessionId, {
        type: 'session_upsert',
        payload: { session },
      });
    }

    // 每个飞书会话只挂一个长期 bridge，保证跨轮回推也共用同一条网络队列。
    // reply target 由 runTurn 在真正开跑时更新，bridge 会在 assistant 起始时快照。
    this.ensureBridge(session.sessionId, msg.chatId);

    // 用户消息先写穿透到 SessionStore，再把仅含路由 ID 的执行记录写进 durable
    // inbox。若第二步失败，网关会要求飞书重推；确定性 message id 保证不会重复落库。
    const content: MessageContent = [{ type: 'text', value: text }];
    const sessionMessageId = `feishu_${createHash('sha256')
      .update(eventId, 'utf8')
      .digest('hex')}`;
    let userMsg = this.store.getHistory(session.sessionId)
      .find((item) => item.id === sessionMessageId);
    if (!userMsg) {
      userMsg = this.store.appendMessage(session.sessionId, {
        id: sessionMessageId,
        role: 'user',
        content,
        source: 'feishu',
      });
    }
    const wasBusy = this.inboundQueue.hasPendingForSession(session.sessionId);
    const accepted = this.inboundQueue.enqueue({
      eventId,
      chatId: msg.chatId,
      sessionId: session.sessionId,
      sessionMessageId,
      replyToMessageId: msg.messageId || null,
    });
    if (accepted.inserted) {
      this.broadcast(session.sessionId, {
        type: 'message_start',
        payload: { message: userMsg },
      });
    }
    this.scheduleInboundDrain();

    // 排队提示（best effort）：会话正忙时告知用户消息已收到、在上一轮结束后处理。
    if (wasBusy && this.gateway) {
      void this.gateway
        .sendMarkdown(
          msg.chatId,
          '⏳ 上一条消息还在处理中，这条已排队，稍后按顺序处理。',
          msg.messageId,
        )
        .catch(() => undefined);
    }

    return null;
  }

  private feishuEventId(msg: FeishuMessage): string {
    const id = msg.messageId?.trim();
    if (id) return id;
    return `feishu_fallback_${createHash('sha256')
      .update(`${msg.chatId}\0${msg.senderOpenId}\0${msg.createTime ?? ''}\0${msg.text}`, 'utf8')
      .digest('hex')}`;
  }

  private scheduleInboundDrain(delayMs = 0): void {
    if (this.stopped || this.inboundDraining) return;
    if (this.inboundRetryTimer) clearTimeout(this.inboundRetryTimer);
    this.inboundRetryTimer = setTimeout(() => {
      this.inboundRetryTimer = null;
      void this.drainInboundQueue();
    }, Math.max(0, delayMs));
    this.inboundRetryTimer.unref?.();
  }

  private async drainInboundQueue(): Promise<void> {
    if (this.inboundDraining || this.stopped) return;
    this.inboundDraining = true;
    try {
      while (!this.stopped) {
        const record = this.inboundQueue.nextDue();
        if (!record) break;
        this.inboundQueue.markRunning(record.eventId);
        this.ensureBridge(record.sessionId, record.chatId);
        const message = this.store.getHistory(record.sessionId)
          .find((item) => item.id === record.sessionMessageId);
        if (!message) {
          this.inboundQueue.markFailed(
            record.eventId,
            'Persistent Feishu session message is missing',
            1,
          );
          continue;
        }
        const result = await this.runTurn(
          record.sessionId,
          message.content,
          record.replyToMessageId ?? undefined,
        );
        if (result.ok) {
          this.inboundQueue.markCompleted(record.eventId);
        } else {
          this.inboundQueue.markFailed(record.eventId, result.error);
        }
      }
    } finally {
      this.inboundDraining = false;
      const retryAt = this.inboundQueue.nextRetryAt();
      if (!this.stopped && retryAt !== null) {
        this.scheduleInboundDrain(Math.max(0, retryAt - Date.now()));
      }
    }
  }

  /**
   * 跑一轮 agent turn（串行队列的执行单元）：已有 runtime 直接复用，首条消息
   * 经 ensureRuntime 懒初始化；初始化失败诚实报错。仅显式 mock 模式走占位回复。
   * 错误不抛出（经 error 帧广播，streamBridge 会把它回推飞书），保证队列不断链。
   */
  private async runTurn(
    sessionId: string,
    content: MessageContent,
    replyToMessageId: string | undefined,
  ): Promise<{ ok: boolean; error?: string }> {
    // 排队轮真正开跑时才更新目标；bridge 会在每条 assistant message_start
    // 时把它快照进流状态，后续排队消息不会串改已开始的回复。
    if (replyToMessageId) this.replyTargets.set(sessionId, replyToMessageId);
    else this.replyTargets.delete(sessionId);
    let runtime = this.store.getRuntime(sessionId);
    if (!runtime && this.ensureRuntime) {
      try {
        runtime = await this.ensureRuntime(sessionId);
      } catch (e) {
        this.store.publish(sessionId, {
          type: 'error',
          payload: {
            sessionId,
            code: 'runtime_init_failed',
            message: `飞书会话运行时初始化失败：${errMsg(e)}`,
          },
        });
        this.store.setStatus(sessionId, 'error');
        return { ok: false, error: errMsg(e) };
      }
    }
    if (!runtime) {
      if (this.mock) {
        // 只有显式测试/开发模式才能回 mock；生产链路永远不会静默伪装成功。
        await this.mockEcho(sessionId);
        return { ok: true };
      }
      // server.ensureRuntime 初始化失败时已经发布过具体错误并把状态设为 error；
      // 独立使用 adapter 且未注入初始化器时，补一条可行动的诚实错误。
      if (this.store.getSession(sessionId)?.status !== 'error') {
        this.store.publish(sessionId, {
          type: 'error',
          payload: {
            sessionId,
            code: 'runtime_unavailable',
            message: '飞书会话的 AI 运行时未初始化，无法处理本条消息。',
          },
        });
        this.store.setStatus(sessionId, 'error');
      }
      return { ok: false, error: 'Feishu session runtime is unavailable' };
    }
    this.store.setStatus(sessionId, 'thinking');
    try {
      await runtime.run(content, 'feishu');
      if (this.store.getSession(sessionId)?.status === 'error') {
        return { ok: false, error: 'Feishu agent turn finished in an error state' };
      }
      return { ok: true };
    } catch (e) {
      this.store.publish(sessionId, {
        type: 'error',
        payload: {
          sessionId,
          code: 'runtime_error',
          message: errMsg(e),
        },
      });
      this.store.setStatus(sessionId, 'error');
      return { ok: false, error: errMsg(e) };
    }
  }

  /**
   * 取某 chatId 已映射的 sessionId（若存在），用于判断是否新会话。
   * store 未暴露反查接口，这里借 getOrCreateFeishuSession 的幂等性间接探测：
   * 先 list 找 feishuChatId 匹配项；找不到返回空串（getSession(空串)→undefined）。
   */
  private peekFeishuSessionId(chatId: string): string {
    const hit = this.store
      .listSessions()
      .find((s) => s.feishuChatId === chatId);
    return hit?.sessionId ?? '';
  }

  /** 给飞书会话挂一个长期回推桥（幂等），跨轮共享回推顺序。 */
  private ensureBridge(
    sessionId: string,
    feishuChatId: string,
  ): void {
    if (this.bridged.has(sessionId)) return;
    const gateway = this.gateway;
    if (!gateway) return;
    const unsub = bridgeSessionToFeishu(
      this.store,
      gateway,
      sessionId,
      feishuChatId,
      () => this.replyTargets.get(sessionId),
    );
    this.bridged.set(sessionId, unsub);
  }

  /**
   * app → 飞书回推：把 app 内对某飞书会话的发言推回飞书。
   * server.ts 在 send_user_message(source:'local') 命中飞书会话时调用。
   *
   * 注意：这里只推「用户在 app 里手敲的那句话」到飞书；core 对该句的回复
   * 会经 store 广播 → streamBridge 自动回推飞书，无需在此重复处理。
   */
  async pushToFeishu(feishuChatId: string, text: string): Promise<void> {
    if (!this.gateway) {
      throw new Error('飞书网关未启动，无法回推。');
    }
    // app 本地发言不是对上一条飞书消息的“回复”；清掉动态引用目标，随后同一轮
    // AI 输出也会以普通消息回推。桥保持不变，跨轮网络顺序不会因此被打断。
    const session = this.store
      .listSessions()
      .find((item) => item.feishuChatId === feishuChatId);
    if (session) {
      this.replyTargets.delete(session.sessionId);
      this.ensureBridge(session.sessionId, feishuChatId);
    }
    await this.gateway.sendMarkdown(feishuChatId, text);
  }

  /**
   * 停止（用户/宿主主动）：先立「有意停止」旗，再取消全部守护定时器、
   * 摘除回推桥订阅、断开网关长连接。stop 之后绝不自动重连（无幽灵定时器）；
   * 再次调用 start() 时恢复守护。
   */
  async stop(): Promise<void> {
    // 旗子先立：并发路径（onDisconnect / 在飞的 attemptConnect / 心跳）看到
    // stopped 一律不再排重连——先清 timer 后立旗会留竞态窗口。
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.inboundRetryTimer) {
      clearTimeout(this.inboundRetryTimer);
      this.inboundRetryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.connecting = false;
    this.connectStartedAt = null;
    this.sdkReconnectingSince = null;
    this.zombieStrikes = 0;
    this.reconnectAttempts = 0;
    this.lockHeldByOtherPid = null;
    try {
      this.offEvict?.();
    } catch {
      // 取消淘汰监听失败不影响后续清理。
    }
    this.offEvict = null; // start 重新调用时重建监听（守护恢复语义）
    for (const unsub of this.bridged.values()) {
      try {
        unsub();
      } catch {
        // 单个取消订阅失败不影响其余清理。
      }
    }
    this.bridged.clear();
    this.replyTargets.clear();
    this.connected = false;
    if (this.gateway) {
      await this.gateway.disconnect().catch(() => undefined);
      this.gateway = null;
    }
  }

  /** mock：仅供显式测试/开发模式验证飞书收发链路；生产模式禁止进入。 */
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
    const text = '（mock）飞书显式测试模式：双向收发链路正常。';
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
}

// ── 小工具：日志 / 错误归一（server 无 Ink，用 console.error 即可；
//    保持低调，不污染 stdout —— Ink 时代教训：飞书进程里别往 stdout 打）──

function logInfo(msg: string): void {
  console.error(`[feishu] ${msg}`);
}
function logWarn(msg: string): void {
  console.error(`[feishu][warn] ${msg}`);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
