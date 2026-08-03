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
 * 回推策略与实际行为一致（注意 CardKit 2.0 默认是**关闭**的，见
 * gateway.isCardKitV2Enabled：生产不稳定，需 OTTO_FEISHU_CARDKIT_V2=1 显式开启）：
 *   - CardKit 启用且起卡成功：1.5s 节流 pushContent 打字机流式 +
 *     chat_complete 时 finalize（对齐 cli `feishuCommand.ts` 主循环）。
 *   - CardKit 关闭 / 起卡失败（默认配置即如此）：首个 chunk 先发一条
 *     「⏳ 正在处理」提示（每条 assistant 流仅一次，避免长任务期间全程静默），
 *     chat_complete 时整段 sendMarkdown 一次性发出。
 */

import {
  ToolCallStatus,
  type AskUserQuestion,
  type ServerToClient,
  type ToolCall,
} from '../protocol.js';
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

/** 飞书流式卡刷新节流间隔（对齐 cli 的 MIN_UPDATE_INTERVAL）。 */
const MIN_PUSH_INTERVAL_MS = 1500;

const TERMINAL_TOOL_STATUSES = new Set<ToolCallStatus>([
  ToolCallStatus.Success,
  ToolCallStatus.Error,
  ToolCallStatus.Canceled,
  ToolCallStatus.BackgroundRunning,
]);

function toolNames(toolCalls: ToolCall[]): string {
  const names = Array.from(new Set(toolCalls.map((call) => (
    call.displayName?.trim() || call.toolName.trim() || '未命名操作'
  ))));
  const visible = names.slice(0, 4).join('、');
  return names.length > 4 ? `${visible}等 ${names.length} 类` : visible;
}

function toolProgressSummary(toolCalls: ToolCall[], complete: boolean): string {
  const names = toolNames(toolCalls);
  if (!complete) {
    const awaiting = toolCalls.filter(
      (call) => call.status === ToolCallStatus.WaitingForConfirmation,
    ).length;
    return awaiting > 0
      ? `🛠️ 正在处理 ${toolCalls.length} 项操作：${names}。其中 ${awaiting} 项等待确认。`
      : `🛠️ 正在处理 ${toolCalls.length} 项操作：${names}。`;
  }
  const succeeded = toolCalls.filter((call) => call.status === ToolCallStatus.Success).length;
  const failed = toolCalls.filter((call) => call.status === ToolCallStatus.Error).length;
  const canceled = toolCalls.filter((call) => call.status === ToolCallStatus.Canceled).length;
  const background = toolCalls.filter(
    (call) => call.status === ToolCallStatus.BackgroundRunning,
  ).length;
  const details = [
    succeeded > 0 ? `成功 ${succeeded} 项` : '',
    failed > 0 ? `失败 ${failed} 项` : '',
    canceled > 0 ? `取消 ${canceled} 项` : '',
    background > 0 ? `转入后台 ${background} 项` : '',
  ].filter(Boolean).join('，');
  const icon = failed > 0 || canceled > 0 ? '⚠️' : '✅';
  return `${icon} 本轮已处理 ${toolCalls.length} 项操作：${names}（${details}）。`;
}

/** 单条 assistant 流的回推状态机（一条 assistant 消息 = 一张飞书流式卡）。 */
interface OutboundStream {
  /** assistant 消息 id（chat_chunk/chat_complete 用它对账）。 */
  messageId: string;
  /** 本条 assistant 启动时快照的触发消息；后续轮次更新不会串改它。 */
  replyToMessageId?: string;
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
}

/**
 * 把某个飞书会话的 store 广播桥接到飞书卡片回推。
 *
 * @param sessionId  飞书会话 id（store 内部 id）
 * @param feishuChatId 对应的飞书 chatId（回推目标）
 * @param getReplyToMessageId 读取当前执行轮的飞书原始消息 id；每条 assistant
 *   在 message_start 时快照一次，后续排队轮次更新不会串改已开始的回复。
 * @returns Unsubscribe 句柄；会话结束/网关停止时调用以摘除订阅。
 */
export function bridgeSessionToFeishu(
  store: SessionStore,
  gateway: FeishuStreamSink,
  sessionId: string,
  feishuChatId: string,
  getReplyToMessageId: () => string | undefined,
): Unsubscribe {
  // 同一会话同一时刻只跟踪「当前正在流的那条 assistant 消息」。
  let active: OutboundStream | null = null;
  // 整个会话共用一条回推队列：工具多轮会产生多条 assistant 流，如果每条流
  // 各排各的，上一条尚未定稿时下一条就可能先起卡，导致旧结果晚于新话题出现。
  let outboundTail: Promise<void> = Promise.resolve();
  // 同一 assistant 工具批次只回推一次“处理中”和一次“已完成”，
  // 忽略 liveOutput 等高频字段变化，避免飞书消息刷屏。
  const toolSummaryPhase = new Map<string, 'working' | 'complete'>();
  const replyToByMessageId = new Map<string, string | undefined>();
  const pendingConfirmations = new Set<string>();

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

  const startStream = (
    messageId: string,
    replyToMessageId: string | undefined,
  ): OutboundStream => {
    const s: OutboundStream = {
      messageId,
      replyToMessageId,
      text: '',
      lastPushAt: 0,
      streaming: null,
      cardStarted: false,
    };
    return s;
  };

  /**
   * 串行排队一个回推动作：单次失败不阻断后续，但抛错时上报 feishu_push_result。
   * fn 内部对「返回 false（未抛但失败）」的情形也应自行调 reportPushFailure。
   */
  const enqueueOutbound = (
    messageId: string,
    fn: () => Promise<void>,
  ): void => {
    outboundTail = outboundTail.then(fn).catch((e) => {
      reportPushFailure(messageId, e instanceof Error ? e.message : String(e));
    });
  };

  const enqueue = (s: OutboundStream, fn: () => Promise<void>): void => {
    enqueueOutbound(s.messageId, fn);
  };

  const resolveConfirmation = (
    callId: string,
    outcome: 'approved' | 'rejected',
    payload?: { answers?: Record<string, string> },
  ): void => {
    store.getRuntime(sessionId)?.resolveToolConfirmation(callId, outcome, payload);
  };

  const askQuestion = async (
    callId: string,
    question: AskUserQuestion,
    replyToMessageId: string | undefined,
  ): Promise<string | null> => {
    const wait = gateway.waitForCardAction;
    if (!wait || question.options.length === 0) return null;
    if (!question.multiSelect) {
      const buttons = question.options.map((option, index) => ({
        label: option.label,
        value: `option:${index}`,
      }));
      buttons.push({ label: '取消', value: 'rejected' });
      const result = await wait.call(
        gateway,
        feishuChatId,
        question.header || '请选择',
        `${question.question}\n\n请求编号：${callId}`,
        buttons,
        'rejected',
        10 * 60_000,
        replyToMessageId,
      );
      if (result === 'rejected') return null;
      const index = Number(result.replace(/^option:/u, ''));
      return question.options[index]?.label ?? null;
    }

    const selected = new Set<number>();
    while (true) {
      const buttons = question.options.map((option, index) => ({
        label: `${selected.has(index) ? '✓ ' : ''}${option.label}`,
        value: `toggle:${index}`,
      }));
      buttons.push({ label: '完成选择', value: 'done' });
      buttons.push({ label: '取消', value: 'rejected' });
      const result = await wait.call(
        gateway,
        feishuChatId,
        question.header || '请选择',
        `${question.question}\n\n可多选，选择后点击“完成选择”。请求编号：${callId}`,
        buttons,
        'rejected',
        10 * 60_000,
        replyToMessageId,
      );
      if (result === 'rejected') return null;
      if (result === 'done') {
        return [...selected].map((index) => question.options[index]!.label).join(', ');
      }
      const index = Number(result.replace(/^toggle:/u, ''));
      if (!Number.isInteger(index) || !question.options[index]) return null;
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
    }
  };

  const handleConfirmation = async (
    callId: string,
    toolCall: ToolCall,
    replyToMessageId: string | undefined,
  ): Promise<void> => {
    const wait = gateway.waitForCardAction;
    if (!wait) {
      await gateway.sendMarkdown(
        feishuChatId,
        `⚠️ “${toolCall.displayName || toolCall.toolName}”需要确认，但当前飞书连接不支持安全确认，已拒绝执行。`,
        replyToMessageId,
      );
      resolveConfirmation(callId, 'rejected');
      return;
    }
    const details = toolCall.confirmationDetails;
    const questions = details?.questions ?? [];
    if (details?.type === 'question' && questions.length > 0) {
      const answers: Record<string, string> = {};
      for (const question of questions) {
        const answer = await askQuestion(callId, question, replyToMessageId);
        if (answer === null) {
          resolveConfirmation(callId, 'rejected');
          return;
        }
        answers[question.question] = answer;
      }
      resolveConfirmation(callId, 'approved', { answers });
      return;
    }

    const name = toolCall.displayName?.trim() || toolCall.toolName;
    const detail = details?.message || details?.reason || details?.command ||
      '该操作会调用企业工具。请核对后决定是否只批准本次执行。';
    const result = await wait.call(
      gateway,
      feishuChatId,
      `确认执行：${name}`,
      `${detail}\n\n请求编号：${callId}`,
      [
        { label: '仅批准本次', value: 'approved' },
        { label: '取消', value: 'rejected' },
      ],
      'rejected',
      10 * 60_000,
      replyToMessageId,
    );
    resolveConfirmation(callId, result === 'approved' ? 'approved' : 'rejected');
  };

  const handleFrame = (frame: ServerToClient): void => {
    switch (frame.type) {
      case 'message_start': {
        const m = frame.payload.message;
        // 只接管本会话的 assistant 流；用户消息（飞书来的那条）不回推。
        if (m.sessionId !== sessionId) return;
        if (m.role !== 'assistant') return;
        active = startStream(m.id, getReplyToMessageId());
        replyToByMessageId.set(m.id, active.replyToMessageId);
        return;
      }

      case 'tool_calls_update': {
        const { sessionId: sid, messageId, toolCalls } = frame.payload;
        if (sid !== sessionId || toolCalls.length === 0) return;
        const complete = toolCalls.every((call) => TERMINAL_TOOL_STATUSES.has(call.status));
        const phase = complete ? 'complete' : 'working';
        const summaryId = messageId || `tools-${toolCalls.map((call) => call.id).join('-')}`;
        if (toolSummaryPhase.get(summaryId) === phase) return;
        toolSummaryPhase.set(summaryId, phase);
        const replyToMessageId = messageId
          ? replyToByMessageId.get(messageId) ?? active?.replyToMessageId
          : active?.replyToMessageId;
        const text = toolProgressSummary(toolCalls, complete);
        enqueueOutbound(summaryId, async () => {
          const sent = await gateway.sendMarkdown(
            feishuChatId,
            text,
            replyToMessageId ?? getReplyToMessageId(),
          );
          if (sent === null) reportPushFailure(summaryId, '飞书工具摘要发送失败');
        });
        return;
      }

      case 'tool_confirmation_request': {
        const { sessionId: sid, callId, toolCall } = frame.payload;
        if (sid !== sessionId || pendingConfirmations.has(callId)) return;
        pendingConfirmations.add(callId);
        const replyToMessageId = active?.replyToMessageId ?? getReplyToMessageId();
        enqueueOutbound(callId, async () => {
          try {
            await handleConfirmation(callId, toolCall, replyToMessageId);
          } finally {
            pendingConfirmations.delete(callId);
          }
        });
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
              s.replyToMessageId,
            );
            if (handle.messageId) {
              s.streaming = {
                pushContent: handle.pushContent,
                finalize: handle.finalize,
              };
            } else {
              // CardKit 不可用（默认配置即如此，见 isCardKitV2Enabled）：
              // 本流降级为「最终一次 sendMarkdown」，中途增量不刷（避免狂发
              // 普通消息刷屏）。但长任务期间不能全程静默——先发一条提示让
              // 用户知道已受理（本块只在首个 chunk 进入一次，天然只发一次；
              // best effort，提示发不出去不影响最终回复）。
              s.streaming = null;
              await gateway
                .sendMarkdown(
                  feishuChatId,
                  '⏳ 正在处理，完成后回复完整结果…',
                  s.replyToMessageId,
                )
                .catch(() => null);
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
        const finalText = s.text.trim();
        // 纯工具轮会产生没有正文的 assistant complete。它只是内部轮次边界，
        // 不是用户可见回复；绝不能伪造成“（空回复）”刷进飞书。
        if (!finalText) {
          enqueue(s, async () => {
            // 极端情况下曾收到全空白 chunk 并已起卡，只做无内容定稿收口；
            // markdown 兜底则完全静默，不再发送占位文字。
            if (s.streaming) await s.streaming.finalize(' ');
          });
          if (active === s) active = null;
          return;
        }
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
              s.replyToMessageId,
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
        const messageId = active?.messageId ?? `error-${Date.now()}`;
        const replyToMessageId = active?.replyToMessageId ?? getReplyToMessageId();
        enqueueOutbound(messageId, async () => {
          const sent = await gateway.sendMarkdown(
            feishuChatId,
            text,
            replyToMessageId,
          );
          if (sent === null) reportPushFailure(messageId, '飞书错误消息发送失败');
        });
        return;
      }

      default:
        // 其余帧（session_status / history …）不回推飞书。
        return;
    }
  };

  return store.subscribe(sessionId, handleFrame);
}
