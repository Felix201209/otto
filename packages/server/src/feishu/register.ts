/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书网关接缝（Issue #3 实装）。
 *
 * server.ts 的 `start()` 在 `enableFeishu` 时调 `registerFeishu({ store, broadcast })`，
 * 得到一个 `FeishuRegistration` 句柄（isConnected / pushToFeishu / stop）。本文件
 * 把地基预留的接缝接到真实的 `FeishuAdapter`（见 feishuAdapter.ts），完成双向同步：
 *
 *   - 飞书 → app：adapter.start() 内 `new FeishuGateway` + connect，
 *     gateway.onMessage 把飞书消息落进 store（source:'feishu'）并广播，
 *     再驱动 core（runtime）跑一轮；core 流式经 streamBridge 既广播给 app、
 *     又节流回推飞书卡片。
 *   - app → 飞书：registration.pushToFeishu(chatId, text) → gateway.sendMarkdown。
 *
 * 生产注册必须显式注入 ensureRuntime：飞书 chat 的首条消息先懒创建与桌面会话
 * 同款的真实 core runtime；这对应官方 EasyCode 的隔离 Config/LLM client 初始化。
 *
 * 真连不通的外部部分（无凭证 / 飞书不可达）：adapter.start() 内部 fail-soft，
 * 返回 isConnected()=false 的句柄，不抛错、不阻断 server 启动。
 */

import type { SessionRuntime, SessionStore } from '../sessions.js';
import type { FeishuHealthStatus, ServerToClient } from '../protocol.js';
import { FeishuAdapter, type FeishuGatewayFactory } from './feishuAdapter.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import { isFeishuAutoReplyEnabledForOpenId } from '../enterprise/db.js';

/** registerFeishu 的依赖注入（server 提供存储 + 广播能力）。 */
export interface FeishuRegisterDeps {
  store: SessionStore;
  /** 由 server 按当前中心企业身份取得/创建飞书会话。 */
  getOrCreateSession?: (
    chatId: string,
    title?: string,
  ) => ReturnType<SessionStore['createSession']>;
  /** 把一帧广播给某会话的所有订阅者（= store.publish 的薄封装）。 */
  broadcast: (sessionId: string, frame: ServerToClient) => void;
  /** 飞书首条消息到达时，为对应隔离会话懒创建真实 core runtime。 */
  ensureRuntime: (
    sessionId: string,
  ) => Promise<SessionRuntime | undefined>;
  /** 企业配置可按飞书 open_id 关闭自动回答。 */
  shouldAutoReply?: (senderOpenId: string) => boolean | Promise<boolean>;
  /** 仅显式测试/开发模式允许 mock；生产缺省 false。 */
  mock?: boolean;
  /** 可选凭证注入（测试用）；缺省 adapter 内部 loadCredentials() 读盘。 */
  credentials?: FeishuCredentials | null;
  /** 可选 gateway 工厂（测试用）；缺省 new FeishuGateway。 */
  gatewayFactory?: FeishuGatewayFactory;
}

/** 注册结果句柄：供 server 查询连接态、回推飞书、启停。 */
export interface FeishuRegistration {
  /** 飞书 WS 长连接是否已建立。 */
  isConnected(): boolean;
  /** 守护状态快照（/health 透出：重连次数、下次重试、锁冲突等）。 */
  getStatus(): FeishuHealthStatus;
  /**
   * 运行期启动/恢复守护（幂等）：已在跑时 no-op；stop() 过之后重新拉起
   * （凭证会重新加载——用户运行期才配好凭证的场景由此覆盖）。
   */
  start(): Promise<void>;
  /**
   * app→飞书回推：把 app 内对某飞书会话的发言推回飞书。
   * @param feishuChatId 目标飞书会话 chatId
   * @param text 回推文本（markdown）
   */
  pushToFeishu(feishuChatId: string, text: string): Promise<void>;
  /** 停止网关、断开长连接（有意停止：之后不自动重连，直到再次 start）。 */
  stop(): Promise<void>;
}

/**
 * 注册飞书网关（实装）。
 *
 * 建 FeishuAdapter 并 start（读凭证 → 建 gateway → 接 onMessage → connect）。
 * start 内部对「无凭证 / 连接失败」fail-soft，因此本函数始终成功返回一个句柄。
 */
export async function registerFeishu(
  deps: FeishuRegisterDeps,
): Promise<FeishuRegistration> {
  const adapter = new FeishuAdapter({
    store: deps.store,
    getOrCreateSession: deps.getOrCreateSession,
    broadcast: deps.broadcast,
    ensureRuntime: deps.ensureRuntime,
    shouldAutoReply: deps.shouldAutoReply ?? isFeishuAutoReplyEnabledForOpenId,
    mock: deps.mock,
    credentials: deps.credentials,
    gatewayFactory: deps.gatewayFactory,
  });

  // start 内部 fail-soft：凭证缺失/连接失败只记录不抛错，句柄照常返回。
  await adapter.start();

  return {
    isConnected(): boolean {
      return adapter.isConnected();
    },
    getStatus(): FeishuHealthStatus {
      return adapter.getStatus();
    },
    async start(): Promise<void> {
      await adapter.start();
    },
    async pushToFeishu(feishuChatId: string, text: string): Promise<void> {
      await adapter.pushToFeishu(feishuChatId, text);
    },
    async stop(): Promise<void> {
      await adapter.stop();
    },
  };
}
