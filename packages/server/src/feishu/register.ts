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
 * ⚠️ 签名保持与地基冻结的接口完全一致（FeishuRegisterDeps / FeishuRegistration），
 *    server.ts 无需任何改动。
 *
 * 真连不通的外部部分（无凭证 / 飞书不可达）：adapter.start() 内部 fail-soft，
 * 返回 isConnected()=false 的句柄，不抛错、不阻断 server 启动。
 */

import type { SessionStore } from '../sessions.js';
import type { ServerToClient } from '../protocol.js';
import { FeishuAdapter } from './feishuAdapter.js';

/** registerFeishu 的依赖注入（server 提供存储 + 广播能力）。 */
export interface FeishuRegisterDeps {
  store: SessionStore;
  /** 把一帧广播给某会话的所有订阅者（= store.publish 的薄封装）。 */
  broadcast: (sessionId: string, frame: ServerToClient) => void;
}

/** 注册结果句柄：供 server 查询连接态、回推飞书、停止。 */
export interface FeishuRegistration {
  /** 飞书 WS 长连接是否已建立。 */
  isConnected(): boolean;
  /**
   * app→飞书回推：把 app 内对某飞书会话的发言推回飞书。
   * @param feishuChatId 目标飞书会话 chatId
   * @param text 回推文本（markdown）
   */
  pushToFeishu(feishuChatId: string, text: string): Promise<void>;
  /** 停止网关、断开长连接。 */
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
    broadcast: deps.broadcast,
  });

  // start 内部 fail-soft：凭证缺失/连接失败只记录不抛错，句柄照常返回。
  await adapter.start();

  return {
    isConnected(): boolean {
      return adapter.isConnected();
    },
    async pushToFeishu(feishuChatId: string, text: string): Promise<void> {
      await adapter.pushToFeishu(feishuChatId, text);
    },
    async stop(): Promise<void> {
      await adapter.stop();
    },
  };
}
