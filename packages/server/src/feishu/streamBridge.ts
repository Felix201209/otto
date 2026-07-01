/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 流式回推桥（core 流式 → 飞书卡片）。
 *
 * 这是飞书双向同步的「回程」。设计目标：**与 Issue #1 的 core 驱动彻底解耦**。
 *
 * core 驱动（SessionRuntime.run）只负责把一轮对话的流式事件
 * `publish` 成协议帧（message_start / chat_chunk / chat_complete …）广播给
 * store 的订阅者。本桥**作为一个普通订阅者**挂在飞书会话上，截获这些帧、
 * 节流地把 assistant 增量推回飞书卡片 —— runtime 不需要知道飞书的存在。
 *
 * 因此：
 *   - Issue #1 接上真实 core 后，本文件**无需改动**：runtime 照常 publish，
 *     桥照常订阅回推。
 *   - core 未接（mock 兜底）时，mock 也走同一套 publish，飞书侧同样能看到回推。
 *
 * 节流逻辑对齐 cli `feishuCommand.ts` 主循环：CardKit 2.0 流式卡 +
 * 1.5s 节流 pushContent + chat_complete 时 finalize。CardKit 创建失败则
 * 回退到「整段 sendMarkdown」一次性发出。
 */

import type { ServerToClient } from '../protocol.js';
import type { SessionStore, Unsubscribe } from '../sessions.js';

/**
 * bridge 实际用到的 gateway 能力子集（流式卡 + markdown 回推）。
 *
 * 真实 `FeishuGateway` 是其超集，结构子类型天然满足。抽出接口让 bridge 不强绑
 * 具体类，也便于测试注入 fake gateway 断言回推。
 */
export interface FeishuStreamSink {
  /** 起一张 CardKit 2.0 流式卡（返回 push/finalize 句柄；不可用时 messageId=null）。 */
  sendStreamingCardWithFooter(
    chatId: string,
    initialContent: string,
    initialFooterMetrics?: unknown,
    replyToMessageId?: string,
  ): Promise<{
    messageId: string | null;
    pushContent: (content: string) => Promise<boolean>;
    finalize: (finalContent: string) => Promise<boolean>;
  }>;
  /** 整段 markdown 一次性发出（CardKit 不可用时的兜底）。 */
  sendMarkdown(
    chatId: string,
    markdown: string,
    replyToMessageId?: string,
  ): Promise<string | null>;
}

/** 飞书流式卡刷新节流间隔（对齐 cli 的 MIN_UPDATE_INTERVAL）。 */
const MIN_PUSH_INTERVAL_MS = 1500;

/** 单条 assistant 流的回推状态机（一条 assistant 消息 = 一张飞书流式卡）。 */
interface OutboundStream {
  /** assistant 消息 id（chat_chunk/chat_complete 用它对账）。 */
  messageId: string;
  /** 累积到目前为止的完整正文（飞书 pushContent 收的是累计全文，非 delta）。 */
  text: string;
  /** 上次推送时间，用于节流。 */
  lastPushAt: number;
  /** CardKit 流式句柄；为 null 表示走 sendMarkdown 兜底（创建失败或未起卡）。 */
  streaming:
    | {
        pushContent: (content: string) => Promise<boolean>;
        finalize: (finalContent: string) => Promise<boolean>;
      }
    | null;
  /** 标记是否已尝试过起卡，避免对空增量反复建卡。 */
  cardStarted: boolean;
  /** 串行化 push，避免并发 RPC 乱序（飞书 sequence 必须单调）。 */
  pending: Promise<void>;
}

/**
 * 把某个飞书会话的 store 广播桥接到飞书卡片回推。
 *
 * @param sessionId  飞书会话 id（store 内部 id）
 * @param feishuChatId 对应的飞书 chatId（回推目标）
 * @param replyToMessageId 触发本轮的飞书原始消息 id（回复式起卡，可空）
 * @returns Unsubscribe 句柄；会话结束/网关停止时调用以摘除订阅。
 */
export function bridgeSessionToFeishu(
  store: SessionStore,
  gateway: FeishuStreamSink,
  sessionId: string,
  feishuChatId: string,
  replyToMessageId: string | undefined,
): Unsubscribe {
  // 同一会话同一时刻只跟踪「当前正在流的那条 assistant 消息」。
  let active: OutboundStream | null = null;

  /**
   * 回推失败上报：向会话订阅者广播一帧 feishu_push_result(ok:false)，
   * 让 renderer 浮出「飞书回推失败」提示，不再静默吞掉失败。
   */
  const reportPushFailure = (messageId: string, error: string): void => {
    store.publish(sessionId, {
      type: 'feishu_push_result',
      payload: { sessionId, feishuChatId, messageId, ok: false, error },
    });
  };

  const startStream = (messageId: string): OutboundStream => {
    const s: OutboundStream = {
      messageId,
      text: '',
      lastPushAt: 0,
      streaming: null,
      cardStarted: false,
      pending: Promise.resolve(),
    };
    return s;
  };

  /**
   * 串行排队一个回推动作：单次失败不阻断后续，但抛错时上报 feishu_push_result。
   * fn 内部对「返回 false（未抛但失败）」的情形也应自行调 reportPushFailure。
   */
  const enqueue = (s: OutboundStream, fn: () => Promise<void>): void => {
    s.pending = s.pending.then(fn).catch((e) => {
      reportPushFailure(s.messageId, e instanceof Error ? e.message : String(e));
    });
  };

  const handleFrame = (frame: ServerToClient): void => {
    switch (frame.type) {
      case 'message_start': {
        const m = frame.payload.message;
        // 只接管本会话的 assistant 流；用户消息（飞书来的那条）不回推。
        if (m.sessionId !== sessionId) return;
        if (m.role !== 'assistant') return;
        active = startStream(m.id);
        return;
      }

      case 'chat_chunk': {
        const { sessionId: sid, messageId, delta } = frame.payload;
        if (sid !== sessionId) return;
        const s = active && active.messageId === messageId ? active : null;
        if (!s) return;
        s.text += delta;
        const now = Date.now();

        // 首块：起一张 CardKit 流式卡（失败则标记走兜底）。
        if (!s.cardStarted) {
          s.cardStarted = true;
          const initial = s.text.trim();
          enqueue(s, async () => {
            const handle = await gateway.sendStreamingCardWithFooter(
              feishuChatId,
              initial || ' ',
              undefined,
              replyToMessageId,
            );
            if (handle.messageId) {
              s.streaming = {
                pushContent: handle.pushContent,
                finalize: handle.finalize,
              };
            } else {
              // CardKit 不可用：本流降级为「最终一次 sendMarkdown」，
              // 中途增量不刷（避免狂发普通消息刷屏）。
              s.streaming = null;
            }
            s.lastPushAt = Date.now();
          });
          return;
        }

        // 后续块：节流推增量正文（仅 CardKit 流式路径才有打字机增量）。
        if (s.streaming && now - s.lastPushAt >= MIN_PUSH_INTERVAL_MS) {
          s.lastPushAt = now;
          const snapshot = s.text.trim();
          enqueue(s, async () => {
            // pushContent 返回 false = 未抛但回推失败（限流/网络）；显式上报。
            const okPush = await s.streaming?.pushContent(snapshot || ' ');
            if (okPush === false) {
              reportPushFailure(s.messageId, '飞书流式卡更新失败');
            }
          });
        }
        return;
      }

      case 'chat_complete': {
        const { sessionId: sid, messageId } = frame.payload;
        if (sid !== sessionId) return;
        const s = active && active.messageId === messageId ? active : null;
        if (!s) return;
        const finalText = s.text.trim() || '（空回复）';
        enqueue(s, async () => {
          if (s.streaming) {
            // finalize 返回 false = 定稿失败（未抛）；显式上报。
            const okFinal = await s.streaming.finalize(finalText);
            if (okFinal === false) {
              reportPushFailure(s.messageId, '飞书流式卡定稿失败');
            }
          } else {
            // 兜底：没有 CardKit 流式卡时，整段一次性发出。
            // sendMarkdown 返回 null = 发送失败（未抛）；显式上报。
            const sent = await gateway.sendMarkdown(
              feishuChatId,
              finalText,
              replyToMessageId,
            );
            if (sent === null) {
              reportPushFailure(s.messageId, '飞书消息发送失败');
            }
          }
        });
        // 本条流结束。下一条 message_start 会重置 active。
        if (active === s) active = null;
        return;
      }

      case 'error': {
        // 把会话级错误也回推飞书，避免飞书侧「发了没反应」。
        if (frame.payload.sessionId && frame.payload.sessionId !== sessionId) {
          return;
        }
        const text = `⚠️ 处理出错：${frame.payload.message}`;
        void gateway
          .sendMarkdown(feishuChatId, text, replyToMessageId)
          .catch(() => undefined);
        return;
      }

      default:
        // 其余帧（tool_calls_update / session_status / history …）暂不回推飞书。
        // TODO(Issue #3 增强): 工具调用进度也可回推成飞书卡片状态行。
        return;
    }
  };

  return store.subscribe(sessionId, handleFrame);
}
