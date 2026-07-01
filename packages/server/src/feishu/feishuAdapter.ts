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
 *     → 驱动 core 跑一轮（store.getRuntime().run()，Issue #1 接；未接走 mock）
 *     → core 流式帧经 streamBridge 既广播给 app、又节流回推飞书卡片。
 *
 *   app → 飞书：pushToFeishu(chatId, text) → gateway.sendMarkdown
 *     （server.ts 在 send_user_message(source:'local') 命中飞书会话时调用）。
 *
 * 与 cli `feishuCommand.ts` 的差异（宿主依赖替换，逻辑保留）：
 *   - `tuiContext.addItem(...)`（往 Ink history 打日志）→ 改为 deps.broadcast 的
 *     WS 事件帧 / logger，no-op 化（server 无 TUI）。
 *   - `appEvents.emit(AppEvent.Feishu*)`（驱动 FeishuStatusDashboard）→ 同上，
 *     由 WS 协议帧承载（双向同步视图 Issue #6 用 session_upsert / message_start）。
 *   - `isolatedSessions: Map<chatId, {config, geminiClient}>` → 提升为 store 的
 *     getOrCreateFeishuSession（store 本就是唯一会话源，天然就是隔离会话表）。
 *   - 工具确认 / slash 命令分发（CommandService 等强 CLI 耦合）→ 暂不迁，留 TODO。
 */

import { loadCredentials, isSenderAuthorized } from './vendor/credentials.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import { FeishuGateway } from './vendor/gateway.js';
import type { FeishuMessage } from './vendor/gateway.js';
import {
  bridgeSessionToFeishu,
  type FeishuStreamSink,
} from './streamBridge.js';
import type { SessionStore, Unsubscribe } from '../sessions.js';
import type { MessageContent, ServerToClient } from '../protocol.js';

/**
 * adapter 实际用到的 gateway 能力子集（结构子类型）。
 *
 * 真实 `FeishuGateway` 天然满足此接口（它的方法是其超集）。抽出接口让 adapter
 * 不强绑具体类，便于测试注入 fake gateway 驱动 onMessage 链路（无需真飞书凭证/连接）。
 */
export interface FeishuGatewayLike extends FeishuStreamSink {
  onMessage: ((msg: FeishuMessage) => Promise<string | null>) | null;
  onReady: (() => void) | null;
  onDisconnect: ((error?: Error) => void) | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/** gateway 工厂：缺省 = new FeishuGateway；测试可注入 fake。 */
export type FeishuGatewayFactory = (
  creds: FeishuCredentials,
) => FeishuGatewayLike;

/** 适配器依赖（由 registerFeishu 注入，源自 server.start）。 */
export interface FeishuAdapterDeps {
  store: SessionStore;
  /** 把一帧广播给某会话订阅者（= store.publish 的薄封装）。 */
  broadcast: (sessionId: string, frame: ServerToClient) => void;
  /** 可选凭证注入（测试用）；缺省走 loadCredentials() 读盘。 */
  credentials?: FeishuCredentials | null;
  /** 可选 gateway 工厂（测试用）；缺省 new FeishuGateway。 */
  gatewayFactory?: FeishuGatewayFactory;
}

/**
 * FeishuAdapter：持有 gateway 实例、连接态、每会话回推桥订阅。
 */
export class FeishuAdapter {
  private readonly store: SessionStore;
  private readonly broadcast: FeishuAdapterDeps['broadcast'];
  private gateway: FeishuGatewayLike | null = null;
  private creds: FeishuCredentials | null = null;
  private connected = false;
  private readonly injectedCreds?: FeishuCredentials | null;
  private readonly gatewayFactory: FeishuGatewayFactory;

  /** 已挂回推桥的飞书会话（sessionId → 取消订阅），避免重复订阅导致重复回推。 */
  private readonly bridged = new Map<string, Unsubscribe>();
  /** 会话淘汰监听取消句柄：会话被 store 容量淘汰时，连带摘除其回推桥。 */
  private readonly offEvict: Unsubscribe;

  constructor(deps: FeishuAdapterDeps) {
    this.store = deps.store;
    this.broadcast = deps.broadcast;
    this.injectedCreds = deps.credentials;
    this.gatewayFactory =
      deps.gatewayFactory ??
      ((creds) =>
        new FeishuGateway(creds.appId, creds.appSecret, creds.domain));
    // 会话被容量上限淘汰时，连带摘除其回推桥订阅（避免桥订阅泄漏 / 对已淘汰会话仍回推）。
    this.offEvict = this.store.onEvict((sessionId) => {
      const unsub = this.bridged.get(sessionId);
      if (unsub) {
        try {
          unsub();
        } catch {
          // 取消订阅失败不影响后续清理。
        }
        this.bridged.delete(sessionId);
      }
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * 启动：加载凭证 → new FeishuGateway → 接 onMessage/onReady/onDisconnect → connect。
   *
   * 凭证缺失时**不抛错**：返回未连接状态（server 仍可正常跑，飞书只是没启用）。
   * 这样 enableFeishu 但用户尚未 setup 飞书凭证时，server 启动不被阻断。
   */
  async start(): Promise<void> {
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

    // 2) 建网关并接线（缺省 new FeishuGateway；测试可注入 fake）。
    const creds = this.creds;
    const gateway = this.gatewayFactory(creds);
    this.gateway = gateway;

    gateway.onReady = () => {
      this.connected = true;
      logInfo('飞书网关已连接（WS 长连接就绪）。');
    };
    gateway.onDisconnect = (error?: Error) => {
      this.connected = false;
      logWarn(`飞书网关断开${error ? `：${error.message}` : ''}。`);
    };

    gateway.onMessage = (msg) => this.handleFeishuMessage(msg, creds);

    // 3) 建连（connect 内部 SDK 自带指数退避重连）。
    try {
      await gateway.connect();
    } catch (e) {
      // 建连失败不崩 server；保持 connected=false，可由上层重试。
      this.connected = false;
      logWarn(`飞书网关 connect 失败：${errMsg(e)}`);
    }
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

    // TODO(Issue #3 增强): 生命周期 / /bind / /restart / slash 命令拦截。
    //   cli feishuCommand 在这里拦截 `/feishu start|stop`、`/bind`、`/restart`、
    //   slash 命令。server 版暂不迁这些强 CLI 耦合命令（它们依赖 CommandService /
    //   进程自重启），先让普通对话走通。命中这些前缀时当前按普通消息透传给 core。

    // 映射飞书会话 → server 唯一会话源（source:'feishu'）。
    const wasNew = !this.store.getSession(this.peekFeishuSessionId(msg.chatId));
    const session = this.store.getOrCreateFeishuSession(msg.chatId);

    // 新飞书会话：广播 session_upsert，让 app 会话列表实时出现飞书会话。
    if (wasNew) {
      this.broadcast(session.sessionId, {
        type: 'session_upsert',
        payload: { session },
      });
    }

    // 挂回推桥（每会话一次，长期存活）：core 流式 → 飞书卡片。
    this.ensureBridge(session.sessionId, msg.chatId, msg.messageId);

    // 落库飞书用户消息 + 广播 message_start（app 实时看到飞书来的消息）。
    const content: MessageContent = [{ type: 'text', value: text }];
    const userMsg = this.store.appendMessage(session.sessionId, {
      role: 'user',
      content,
      source: 'feishu',
    });
    this.broadcast(session.sessionId, {
      type: 'message_start',
      payload: { message: userMsg },
    });

    // 驱动 core 跑一轮（Issue #1 接 runtime；未接走 mock 兜底）。
    const runtime = this.store.getRuntime(session.sessionId);
    if (runtime) {
      this.store.setStatus(session.sessionId, 'thinking');
      // 不 await：让 onMessage 尽快返回，core 流式经 store.publish 广播 +
      // streamBridge 异步回推飞书。错误经 error 帧广播 + bridge 回推飞书。
      void runtime.run(content, 'feishu').catch((e) => {
        this.store.publish(session.sessionId, {
          type: 'error',
          payload: {
            sessionId: session.sessionId,
            code: 'runtime_error',
            message: errMsg(e),
          },
        });
        this.store.setStatus(session.sessionId, 'error');
      });
    } else {
      // mock 兜底：core 未接时，回一条占位流式回复（对齐 server.ts mockEcho 精神），
      // 既广播给 app、又经 streamBridge 回推飞书 —— 双向链路今晚即可端到端验证。
      void this.mockEcho(session.sessionId);
    }

    return null;
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

  /** 给飞书会话挂一次回推桥（幂等）。 */
  private ensureBridge(
    sessionId: string,
    feishuChatId: string,
    replyToMessageId: string | undefined,
  ): void {
    if (this.bridged.has(sessionId)) return;
    const gateway = this.gateway;
    if (!gateway) return;
    const unsub = bridgeSessionToFeishu(
      this.store,
      gateway,
      sessionId,
      feishuChatId,
      replyToMessageId,
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
    await this.gateway.sendMarkdown(feishuChatId, text);
  }

  /** 停止：摘除所有回推桥订阅，断开网关长连接。 */
  async stop(): Promise<void> {
    try {
      this.offEvict();
    } catch {
      // 取消淘汰监听失败不影响后续清理。
    }
    for (const unsub of this.bridged.values()) {
      try {
        unsub();
      } catch {
        // 单个取消订阅失败不影响其余清理。
      }
    }
    this.bridged.clear();
    this.connected = false;
    if (this.gateway) {
      await this.gateway.disconnect().catch(() => undefined);
      this.gateway = null;
    }
  }

  /** mock：core 未接时回一条占位流式回复（与 server.ts mockEcho 对齐）。实装后删。 */
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
      '（mock）飞书网关已接入 server，core 驱动尚未接入（Issue #1）。双向链路 OK。';
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
