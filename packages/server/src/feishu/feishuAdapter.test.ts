/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书 adapter 双向链路端到端测试（离线）。
 *
 * 注入 fake gateway + fake creds，绕开真飞书 SDK / 凭证读盘，验证：
 *   1. 飞书入站消息 → 落进会话源（source:'feishu'）+ 广播 message_start 给 app；
 *   2. 仅显式 mock 模式回占位回复，其流式帧经 streamBridge 回推飞书卡片；
 *   3. 新飞书会话首条消息会懒初始化真实 runtime，不得回 mock；
 *   4. 接了 runtime 时，runtime.run 被调用、其 publish 的流式帧同样回推飞书；
 *   5. 鉴权 fail-closed：未授权 sender 不进会话源、只回一句拒绝；
 *   6. app→飞书回推 pushToFeishu 调 gateway.sendMarkdown。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeishuAdapter, type FeishuGatewayLike } from './feishuAdapter.js';
import type { FeishuMessage } from './vendor/gateway.js';
import type { FeishuCredentials } from './vendor/credentials.js';
import { InMemorySessionStore } from '../sessions.js';
import type { SessionRuntime } from '../sessions.js';
import type { MessageContent, ServerToClient } from '../protocol.js';

/** 记录所有回推飞书的动作，供断言。 */
interface PushLog {
  cards: Array<{ chatId: string; pushed: string[]; finalized: string | null; replyTo?: string }>;
  markdowns: Array<{ chatId: string; text: string; replyTo?: string }>;
}

/** 构造一个 fake gateway：捕获回推、可手动触发 onMessage / onReady。 */
function makeFakeGateway(log: PushLog): {
  gw: FeishuGatewayLike;
  fireMessage: (msg: FeishuMessage) => Promise<string | null>;
  fireReady: () => void;
} {
  let onMessage: ((m: FeishuMessage) => Promise<string | null>) | null = null;
  let onReady: (() => void) | null = null;

  const gw: FeishuGatewayLike = {
    get onMessage() {
      return onMessage;
    },
    set onMessage(fn) {
      onMessage = fn;
    },
    get onReady() {
      return onReady;
    },
    set onReady(fn) {
      onReady = fn;
    },
    onDisconnect: null,
    async connect() {
      /* fake：立即就绪 */
    },
    async disconnect() {
      /* fake */
    },
    async sendStreamingCardWithFooter(chatId, initialContent, _metrics, replyToMessageId) {
      const card = { chatId, pushed: [initialContent], finalized: null as string | null, replyTo: replyToMessageId };
      log.cards.push(card);
      return {
        messageId: 'om_card_1',
        async pushContent(content: string) {
          card.pushed.push(content);
          return true;
        },
        async finalize(finalContent: string) {
          card.finalized = finalContent;
          return true;
        },
      };
    },
    async sendMarkdown(chatId, markdown, replyToMessageId) {
      log.markdowns.push({ chatId, text: markdown, replyTo: replyToMessageId });
      return 'om_md_1';
    },
  };

  return {
    gw,
    fireMessage: (m) => {
      if (!onMessage) throw new Error('onMessage 未接');
      return onMessage(m);
    },
    fireReady: () => onReady?.(),
  };
}

const CREDS: FeishuCredentials = {
  appId: 'cli_app',
  appSecret: 'secret',
  domain: 'feishu',
  ownerOpenId: 'ou_owner',
  allowlist: ['ou_allowed'],
};

function makeMsg(over: Partial<FeishuMessage> = {}): FeishuMessage {
  return {
    text: 'hello otto',
    messageId: 'om_in_1',
    chatId: 'oc_chat_A',
    chatType: 'p2p',
    senderOpenId: 'ou_owner',
    mentions: [],
    messageType: 'text',
    ...over,
  };
}

/** 等所有微任务（adapter 内部 void 的异步链 + bridge 串行队列）落定。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('FeishuAdapter 双向链路', () => {
  let store: InMemorySessionStore;
  let appFrames: ServerToClient[];
  let log: PushLog;

  beforeEach(() => {
    store = new InMemorySessionStore();
    appFrames = [];
    log = { cards: [], markdowns: [] };
  });

  /** 把 adapter 的 broadcast 接到一个全局 app 订阅者（模拟 Electron WS 连接）。 */
  function newAdapter(opts: {
    fire: () => ReturnType<typeof makeFakeGateway>;
    mock?: boolean;
  }) {
    const fake = opts.fire();
    const adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: CREDS,
      gatewayFactory: () => fake.gw,
      mock: opts.mock,
    });
    return { adapter, fake };
  }

  it('飞书消息（mock 回复）→ 落会话源 + 广播 app + 回推飞书卡片', async () => {
    const { adapter, fake } = newAdapter({
      fire: () => makeFakeGateway(log),
      mock: true,
    });
    await adapter.start();
    fake.fireReady();
    expect(adapter.isConnected()).toBe(true);

    // 飞书来一条消息。
    await fake.fireMessage(makeMsg());
    await flush();

    // 会话源里应有 source:'feishu' 会话，含 1 条 user(feishu) + 1 条 assistant。
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    const sess = sessions[0];
    expect(sess.source).toBe('feishu');
    expect(sess.feishuChatId).toBe('oc_chat_A');

    const history = store.getHistory(sess.sessionId);
    const userMsg = history.find((m) => m.role === 'user');
    expect(userMsg?.source).toBe('feishu');
    expect(userMsg?.content[0]).toEqual({ type: 'text', value: 'hello otto' });
    expect(history.some((m) => m.role === 'assistant')).toBe(true);

    // 回推飞书：mock 回复应已起一张流式卡并 finalize。
    expect(log.cards).toHaveLength(1);
    expect(log.cards[0].chatId).toBe('oc_chat_A');
    expect(log.cards[0].finalized).toContain('mock');
  });

  it('未授权 sender → 不进会话源，只回一句拒绝', async () => {
    const { adapter, fake } = newAdapter({ fire: () => makeFakeGateway(log) });
    await adapter.start();

    const reply = await fake.fireMessage(
      makeMsg({ senderOpenId: 'ou_stranger' }),
    );
    await flush();

    expect(reply).toBeNull(); // 回复不走返回值
    expect(store.listSessions()).toHaveLength(0); // 未授权不污染会话源
    // 拒绝语经 sendMarkdown 直接回推。
    expect(log.markdowns).toHaveLength(1);
    expect(log.markdowns[0].text).toContain('🛡️');
  });

  it('企业关闭飞书自动回答后 fail closed，不落会话也不触发 runtime', async () => {
    const fake = makeFakeGateway(log);
    let runtimeCalls = 0;
    const adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: CREDS,
      gatewayFactory: () => fake.gw,
      shouldAutoReply: async () => false,
      ensureRuntime: async () => {
        runtimeCalls += 1;
        return undefined;
      },
    });
    await adapter.start();

    await fake.fireMessage(makeMsg());
    await flush();

    expect(runtimeCalls).toBe(0);
    expect(store.listSessions()).toHaveLength(0);
    expect(log.markdowns).toEqual([
      expect.objectContaining({ text: expect.stringContaining('关闭飞书自动回答') }),
    ]);
  });

  it('接了 runtime → runtime.run 被调用，其流式帧回推飞书', async () => {
    const { adapter, fake } = newAdapter({ fire: () => makeFakeGateway(log) });
    await adapter.start();

    // 先让会话被创建（adapter 在 onMessage 里 getOrCreateFeishuSession），
    // 但 runtime 必须在 run 前挂上。这里用一个 runtime，run 时模拟 core 流式 publish。
    let runCalled = 0;
    const makeRuntime = (sessionId: string): SessionRuntime => ({
      async run(input: MessageContent, source) {
        runCalled++;
        void input;
        void source;
        // 模拟 core 一轮流式：message_start(assistant) → chunk → complete。
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
          payload: { sessionId, messageId: assistant.id, delta: 'core 真实回复' },
        });
        store.publish(sessionId, {
          type: 'chat_complete',
          payload: { sessionId, messageId: assistant.id },
        });
      },
      cancel() {},
      setModel() {},
      getConfig() { return undefined; },
      async dispose() {},
    });

    // adapter 在收到首条消息时创建会话；我们需要在 run 之前把 runtime 挂上。
    // 用 store 的 getOrCreateFeishuSession 预建会话并 attachRuntime，
    // 保证 adapter.handleFeishuMessage 命中已挂 runtime 的会话。
    const pre = store.getOrCreateFeishuSession('oc_chat_B');
    store.attachRuntime(pre.sessionId, makeRuntime(pre.sessionId));

    await fake.fireMessage(makeMsg({ chatId: 'oc_chat_B', messageId: 'om_in_2' }));
    await flush();

    expect(runCalled).toBe(1); // 走了 core，不是 mock
    // core 流式经 streamBridge 回推飞书卡片。
    expect(log.cards).toHaveLength(1);
    expect(log.cards[0].finalized).toContain('core 真实回复');
  });

  it('新飞书会话 → 首条消息先懒初始化真实 runtime，不得回 mock', async () => {
    const fake = makeFakeGateway(log);
    let ensureCalls = 0;
    let runCalls = 0;
    const adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: CREDS,
      gatewayFactory: () => fake.gw,
      ensureRuntime: async (sessionId): Promise<SessionRuntime> => {
        ensureCalls += 1;
        return {
          async run() {
            runCalls += 1;
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
              payload: {
                sessionId,
                messageId: assistant.id,
                delta: '首条消息的真实回复',
              },
            });
            store.publish(sessionId, {
              type: 'chat_complete',
              payload: {
                sessionId,
                messageId: assistant.id,
                text: '首条消息的真实回复',
              },
            });
          },
          cancel() {},
          setModel() {},
          getConfig() {
            return undefined;
          },
          async dispose() {},
        };
      },
    });
    await adapter.start();

    await fake.fireMessage(
      makeMsg({ chatId: 'oc_chat_first', messageId: 'om_first' }),
    );
    await flush();

    expect(ensureCalls).toBe(1);
    expect(runCalls).toBe(1);
    expect(log.cards).toHaveLength(1);
    expect(log.cards[0].finalized).toContain('首条消息的真实回复');
    expect(log.cards[0].finalized).not.toContain('mock');
  });

  it('app→飞书回推：pushToFeishu 调 sendMarkdown', async () => {
    const { adapter } = newAdapter({ fire: () => makeFakeGateway(log) });
    await adapter.start();

    await adapter.pushToFeishu('oc_chat_C', 'app 内发的话');
    expect(log.markdowns).toContainEqual({
      chatId: 'oc_chat_C',
      text: 'app 内发的话',
      replyTo: undefined,
    });
  });

  it('无凭证 → start fail-soft，不抛错、未连接', async () => {
    const adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: null, // 显式无凭证
    });
    await expect(adapter.start()).resolves.toBeUndefined();
    expect(adapter.isConnected()).toBe(false);
    await adapter.pushToFeishu('x', 'y').then(
      () => {
        throw new Error('应当因网关未启动而拒绝');
      },
      (e) => expect(String(e)).toContain('未启动'),
    );
  });

  it('同一会话连发两条消息 → 串行执行（第二轮等第一轮结束），顺序正确', async () => {
    const { adapter, fake } = newAdapter({ fire: () => makeFakeGateway(log) });
    await adapter.start();
    void adapter;

    // 第一轮 run 卡在 gate 上，用于验证第二轮不会并发启动。
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let calls = 0;
    const runtime: SessionRuntime = {
      async run(input: MessageContent) {
        const n = ++calls;
        const text = (input[0] as { type: 'text'; value: string }).value;
        events.push(`start${n}:${text}`);
        if (n === 1) await gate;
        events.push(`end${n}`);
      },
      cancel() {},
      setModel() {},
      getConfig() { return undefined; },
      async dispose() {},
    };
    const pre = store.getOrCreateFeishuSession('oc_chat_Q');
    store.attachRuntime(pre.sessionId, runtime);

    await fake.fireMessage(
      makeMsg({ chatId: 'oc_chat_Q', messageId: 'om_q1', text: '第一条' }),
    );
    await fake.fireMessage(
      makeMsg({ chatId: 'oc_chat_Q', messageId: 'om_q2', text: '第二条' }),
    );
    await flush();

    // 第一轮尚未结束时，第二轮绝不能开跑（否则 streamBridge 会互相踩踏）。
    expect(events).toEqual(['start1:第一条']);
    // 排队时给用户发了简短提示。
    expect(
      log.markdowns.some(
        (m) => m.chatId === 'oc_chat_Q' && m.text.includes('排队'),
      ),
    ).toBe(true);

    releaseFirst();
    await flush();
    expect(events).toEqual(['start1:第一条', 'end1', 'start2:第二条', 'end2']);
  });

  it('同一飞书会话的每轮回复引用各自触发消息，而不是永远引用第一条', async () => {
    const { adapter, fake } = newAdapter({ fire: () => makeFakeGateway(log) });
    await adapter.start();
    const pre = store.getOrCreateFeishuSession('oc_chat_reply');
    let turn = 0;
    store.attachRuntime(pre.sessionId, {
      async run() {
        turn += 1;
        const assistant = store.appendMessage(pre.sessionId, {
          role: 'assistant',
          content: [{ type: 'text', value: '' }],
          source: 'local',
          isStreaming: true,
        });
        store.publish(pre.sessionId, {
          type: 'message_start',
          payload: { message: assistant },
        });
        store.publish(pre.sessionId, {
          type: 'chat_chunk',
          payload: {
            sessionId: pre.sessionId,
            messageId: assistant.id,
            delta: `第 ${turn} 轮回复`,
          },
        });
        store.publish(pre.sessionId, {
          type: 'chat_complete',
          payload: { sessionId: pre.sessionId, messageId: assistant.id },
        });
      },
      cancel() {},
      setModel() {},
      getConfig() { return undefined; },
      async dispose() {},
    } as SessionRuntime);

    await fake.fireMessage(makeMsg({
      chatId: 'oc_chat_reply',
      messageId: 'om_reply_1',
      text: '第一问',
    }));
    await flush();
    await fake.fireMessage(makeMsg({
      chatId: 'oc_chat_reply',
      messageId: 'om_reply_2',
      text: '第二问',
    }));
    await flush();

    expect(log.cards.map((card) => card.replyTo)).toEqual([
      'om_reply_1',
      'om_reply_2',
    ]);
  });

  it('上一轮飞书定稿未完成时，下一轮不能绕过会话回推队列先起卡', async () => {
    const fake = makeFakeGateway(log);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstFinalizing!: () => void;
    const firstFinalizing = new Promise<void>((resolve) => {
      markFirstFinalizing = resolve;
    });
    fake.gw.sendStreamingCardWithFooter = async (
      _chatId,
      initialContent,
    ) => {
      events.push(`card:${initialContent}`);
      return {
        messageId: `om_${initialContent}`,
        pushContent: async () => true,
        finalize: async () => {
          events.push(`finalize:${initialContent}:start`);
          if (initialContent === '第一轮') {
            markFirstFinalizing();
            await firstGate;
          }
          events.push(`finalize:${initialContent}:end`);
          return true;
        },
      };
    };
    const adapter = new FeishuAdapter({
      store,
      broadcast: (sessionId, frame) => store.publish(sessionId, frame),
      credentials: CREDS,
      gatewayFactory: () => fake.gw,
    });
    await adapter.start();
    const pre = store.getOrCreateFeishuSession('oc_chat_order');
    let turn = 0;
    store.attachRuntime(pre.sessionId, {
      async run() {
        turn += 1;
        const text = turn === 1 ? '第一轮' : '第二轮';
        const assistant = store.appendMessage(pre.sessionId, {
          role: 'assistant',
          content: [{ type: 'text', value: '' }],
          source: 'local',
          isStreaming: true,
        });
        store.publish(pre.sessionId, {
          type: 'message_start',
          payload: { message: assistant },
        });
        store.publish(pre.sessionId, {
          type: 'chat_chunk',
          payload: { sessionId: pre.sessionId, messageId: assistant.id, delta: text },
        });
        store.publish(pre.sessionId, {
          type: 'chat_complete',
          payload: { sessionId: pre.sessionId, messageId: assistant.id },
        });
      },
      cancel() {},
      setModel() {},
      getConfig() { return undefined; },
      async dispose() {},
    } as SessionRuntime);

    await fake.fireMessage(makeMsg({
      chatId: 'oc_chat_order',
      messageId: 'om_order_1',
      text: '第一问',
    }));
    await firstFinalizing;
    await fake.fireMessage(makeMsg({
      chatId: 'oc_chat_order',
      messageId: 'om_order_2',
      text: '第二问',
    }));
    await flush();
    expect(events).not.toContain('card:第二轮');

    releaseFirst();
    await flush();
    expect(events.indexOf('finalize:第一轮:end')).toBeLessThan(
      events.indexOf('card:第二轮'),
    );
  });

  // appFrames 仅作占位说明：broadcast 直接走 store.publish，
  // 上面各用例已通过 store.getHistory / log 断言广播效果。
  void appFrames;
});
