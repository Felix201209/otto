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

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bridgeSessionToFeishu,
  type FeishuStreamSink,
} from './streamBridge.js';
import { InMemorySessionStore } from '../sessions.js';

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
      'om_origin_1',
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
      undefined,
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
});
