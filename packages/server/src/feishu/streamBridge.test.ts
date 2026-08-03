/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 流式回推桥单测（离线）。
 *
 * 重点覆盖 CardKit 不可用（默认配置即如此，isCardKitV2Enabled()=false）的降级
 * 路径：首个 chunk 只发一次「⏳ 正在处理」提示，chat_complete 时整段 sendMarkdown；
 * 以及 CardKit 可用路径不发提示、走流式卡 finalize。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bridgeSessionToFeishu,
  type FeishuStreamSink,
} from './streamBridge.js';
import { InMemorySessionStore } from '../sessions.js';
import { ToolCallStatus } from '../protocol.js';

/** 等桥内串行队列（enqueue promise 链）落定。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('bridgeSessionToFeishu', () => {
  let store: InMemorySessionStore;
  let markdowns: Array<{ chatId: string; text: string; replyTo?: string }>;

  beforeEach(() => {
    store = new InMemorySessionStore();
    markdowns = [];
  });

  /** 构造一个 CardKit 不可用的 sink（对齐 gateway 默认关闭时的 noopHandle）。 */
  function makeNoCardSink(): FeishuStreamSink {
    return {
      async sendStreamingCardWithFooter() {
        return {
          messageId: null,
          pushContent: async () => false,
          finalize: async () => false,
        };
      },
      async sendMarkdown(chatId, markdown, replyToMessageId) {
        markdowns.push({ chatId, text: markdown, replyTo: replyToMessageId });
        return 'om_sent';
      },
    };
  }

  /** 起一条 assistant 流：message_start + 首个 chunk。返回 assistant 消息 id。 */
  function startAssistantStream(sessionId: string, firstDelta: string): string {
    const assistant = store.appendMessage(sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    store.publish(sessionId, {
      type: 'message_start',
      payload: { message: assistant },
    });
    store.publish(sessionId, {
      type: 'chat_chunk',
      payload: { sessionId, messageId: assistant.id, delta: firstDelta },
    });
    return assistant.id;
  }

  it('CardKit 不可用 → 首个 chunk 发一次「正在处理」提示，后续 chunk 不重复', async () => {
    const sess = store.getOrCreateFeishuSession('oc_bridge_1');
    bridgeSessionToFeishu(
      store,
      makeNoCardSink(),
      sess.sessionId,
      'oc_bridge_1',
      () => 'om_origin_1',
    );

    const messageId = startAssistantStream(sess.sessionId, '第一段');
    await flush();

    // 首个 chunk：只发了一条提示（回复到原始消息）。
    expect(markdowns).toHaveLength(1);
    expect(markdowns[0].text).toContain('正在处理');
    expect(markdowns[0].chatId).toBe('oc_bridge_1');
    expect(markdowns[0].replyTo).toBe('om_origin_1');

    // 后续 chunk：不再发提示、也不发增量（避免刷屏）。
    store.publish(sess.sessionId, {
      type: 'chat_chunk',
      payload: { sessionId: sess.sessionId, messageId, delta: '第二段' },
    });
    await flush();
    expect(markdowns).toHaveLength(1);

    // chat_complete：整段一次性 sendMarkdown。
    store.publish(sess.sessionId, {
      type: 'chat_complete',
      payload: { sessionId: sess.sessionId, messageId },
    });
    await flush();
    expect(markdowns).toHaveLength(2);
    expect(markdowns[1].text).toBe('第一段第二段');
  });

  it('CardKit 可用 → 不发提示，走流式卡并 finalize', async () => {
    const pushed: string[] = [];
    let finalized: string | null = null;
    const cardSink: FeishuStreamSink = {
      async sendStreamingCardWithFooter(_chatId, initialContent) {
        pushed.push(initialContent);
        return {
          messageId: 'om_card_1',
          pushContent: async (content: string) => {
            pushed.push(content);
            return true;
          },
          finalize: async (finalContent: string) => {
            finalized = finalContent;
            return true;
          },
        };
      },
      async sendMarkdown(chatId, markdown, replyToMessageId) {
        markdowns.push({ chatId, text: markdown, replyTo: replyToMessageId });
        return 'om_sent';
      },
    };

    const sess = store.getOrCreateFeishuSession('oc_bridge_2');
    bridgeSessionToFeishu(
      store,
      cardSink,
      sess.sessionId,
      'oc_bridge_2',
      () => undefined,
    );

    const messageId = startAssistantStream(sess.sessionId, '流式正文');
    await flush();
    store.publish(sess.sessionId, {
      type: 'chat_complete',
      payload: { sessionId: sess.sessionId, messageId },
    });
    await flush();

    // 卡片路径：起卡 + finalize，全程没有普通 markdown 消息（无提示）。
    expect(pushed.length).toBeGreaterThanOrEqual(1);
    expect(finalized).toBe('流式正文');
    expect(markdowns).toHaveLength(0);
  });

  it('纯工具轮的空 assistant complete 不向飞书发送“空回复”', async () => {
    const sess = store.getOrCreateFeishuSession('oc_bridge_empty');
    bridgeSessionToFeishu(
      store,
      makeNoCardSink(),
      sess.sessionId,
      'oc_bridge_empty',
      () => 'om_origin_empty',
    );
    const assistant = store.appendMessage(sess.sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    store.publish(sess.sessionId, {
      type: 'message_start',
      payload: { message: assistant },
    });
    store.publish(sess.sessionId, {
      type: 'chat_complete',
      payload: { sessionId: sess.sessionId, messageId: assistant.id, text: '' },
    });
    await flush();

    expect(markdowns).toHaveLength(0);
  });

  it('工具批次只发一次过程摘要和一次完成摘要', async () => {
    const sess = store.getOrCreateFeishuSession('oc_bridge_tools');
    bridgeSessionToFeishu(
      store,
      makeNoCardSink(),
      sess.sessionId,
      'oc_bridge_tools',
      () => 'om_origin_tools',
    );
    const assistant = store.appendMessage(sess.sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    store.publish(sess.sessionId, {
      type: 'message_start',
      payload: { message: assistant },
    });
    const baseCall = {
      id: 'call-1',
      toolName: 'read_file',
      displayName: '读取文件',
      parameters: {},
      status: ToolCallStatus.Executing,
    };
    store.publish(sess.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: sess.sessionId,
        messageId: assistant.id,
        toolCalls: [baseCall],
      },
    });
    // liveOutput 变化不应刷出第二条“处理中”。
    store.publish(sess.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: sess.sessionId,
        messageId: assistant.id,
        toolCalls: [{ ...baseCall, liveOutput: '50%' }],
      },
    });
    store.publish(sess.sessionId, {
      type: 'tool_calls_update',
      payload: {
        sessionId: sess.sessionId,
        messageId: assistant.id,
        toolCalls: [{ ...baseCall, status: ToolCallStatus.Success }],
      },
    });
    await flush();

    expect(markdowns).toHaveLength(2);
    expect(markdowns[0]).toMatchObject({
      chatId: 'oc_bridge_tools',
      replyTo: 'om_origin_tools',
    });
    expect(markdowns[0].text).toContain('正在处理 1 项操作：读取文件');
    expect(markdowns[1].text).toContain('本轮已处理 1 项操作：读取文件');
    expect(markdowns[1].text).toContain('成功 1 项');
  });

  it('高风险工具确认绑定原始飞书消息和 callId，确认后才唤醒 runtime', async () => {
    const confirmations: Array<{ replyTo?: string; content: string }> = [];
    const sink: FeishuStreamSink = {
      ...makeNoCardSink(),
      async waitForCardAction(
        _chatId,
        _title,
        content,
        _buttons,
        _defaultValue,
        _timeoutMs,
        replyToMessageId,
      ) {
        confirmations.push({ replyTo: replyToMessageId, content });
        return 'approved';
      },
    };
    const sess = store.getOrCreateFeishuSession('oc_bridge_confirm');
    const resolveToolConfirmation = vi.fn();
    store.attachRuntime(sess.sessionId, {
      async run() {},
      cancel() {},
      setModel() {},
      getConfig() { return undefined; },
      resolveToolConfirmation,
      async dispose() {},
    });
    bridgeSessionToFeishu(
      store,
      sink,
      sess.sessionId,
      'oc_bridge_confirm',
      () => 'om_original_request',
    );
    const assistant = store.appendMessage(sess.sessionId, {
      role: 'assistant',
      content: [{ type: 'text', value: '' }],
      source: 'local',
      isStreaming: true,
    });
    store.publish(sess.sessionId, {
      type: 'message_start',
      payload: { message: assistant },
    });
    store.publish(sess.sessionId, {
      type: 'tool_confirmation_request',
      payload: {
        sessionId: sess.sessionId,
        callId: 'call-dangerous-1',
        toolCall: {
          id: 'call-dangerous-1',
          toolName: 'shell_command',
          displayName: '运行命令',
          parameters: {},
          status: ToolCallStatus.WaitingForConfirmation,
          confirmationDetails: {
            type: 'exec',
            riskLevel: 'high',
            command: 'restricted command',
          },
        },
      },
    });
    await flush();

    expect(confirmations).toEqual([{
      replyTo: 'om_original_request',
      content: expect.stringContaining('call-dangerous-1'),
    }]);
    expect(resolveToolConfirmation).toHaveBeenCalledWith(
      'call-dangerous-1',
      'approved',
      undefined,
    );
  });

  it('不同 assistant 流共用回推队列，后一条不能越过前一条定稿', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstFinalizing!: () => void;
    const firstFinalizing = new Promise<void>((resolve) => {
      markFirstFinalizing = resolve;
    });
    const sink: FeishuStreamSink = {
      async sendStreamingCardWithFooter(_chatId, initialContent) {
        events.push(`card:${initialContent}`);
        return {
          messageId: `om_${initialContent}`,
          pushContent: async () => true,
          finalize: async () => {
            events.push(`finalize:${initialContent}:start`);
            if (initialContent === '第一条') {
              markFirstFinalizing();
              await firstGate;
            }
            events.push(`finalize:${initialContent}:end`);
            return true;
          },
        };
      },
      async sendMarkdown() {
        return 'om_sent';
      },
    };
    const sess = store.getOrCreateFeishuSession('oc_bridge_order');
    bridgeSessionToFeishu(
      store,
      sink,
      sess.sessionId,
      'oc_bridge_order',
      () => 'om_origin_order',
    );

    const firstId = startAssistantStream(sess.sessionId, '第一条');
    await flush();
    store.publish(sess.sessionId, {
      type: 'chat_complete',
      payload: { sessionId: sess.sessionId, messageId: firstId },
    });
    await firstFinalizing;

    const secondId = startAssistantStream(sess.sessionId, '第二条');
    await flush();
    expect(events).not.toContain('card:第二条');

    releaseFirst();
    await flush();
    store.publish(sess.sessionId, {
      type: 'chat_complete',
      payload: { sessionId: sess.sessionId, messageId: secondId },
    });
    await flush();
    expect(events.indexOf('finalize:第一条:end')).toBeLessThan(
      events.indexOf('card:第二条'),
    );
  });
});
