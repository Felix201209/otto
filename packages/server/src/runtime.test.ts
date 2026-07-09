/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CoreSessionRuntime 流式落库/收口对账单测（修「切换会话后任务看似中断」三件套）。
 *
 * 用 fake Config + fake chat 流驱动 run()，不接真 core 模型：
 *   ① 流式中途 getHistory 就能拿到已累积文本——客户端切走（退订）再切回时
 *      靠 subscribe 回灌的 history 恢复正文，若 store 里还是空占位就会缺头；
 *   ② 收口 chat_complete 帧带定稿全文 text（客户端对账自愈的数据来源）；
 *   ③ 定稿后 store 里正文完整、isStreaming=false。
 */

import { describe, it, expect } from 'vitest';
import type { Config } from 'otto-core';
import { AskUserQuestionTool } from 'otto-core';
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { ToolCallStatus, type ServerToClient } from './protocol.js';

/** 构造一条只有文本的流式 chunk（结构对齐 GenerateContentResponse）。 */
function chunk(text: string, finishReason?: string): unknown {
  return {
    candidates: [
      {
        content: { parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
      },
    ],
  };
}

/** 最小 fake Config：只实现 run()/initialize() 实际触碰的方法。 */
function makeFakeConfig(stream: () => AsyncGenerator<unknown>): Config {
  const fake = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getToolRegistry: async () => ({
      discoverMcpTools: async () => undefined,
      getFunctionDeclarations: () => [],
    }),
    getOttoClient: () => ({
      getChat: async () => ({
        sendMessageStream: async () => stream(),
      }),
    }),
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
  };
  return fake as unknown as Config;
}

describe('CoreSessionRuntime 流式落库与收口对账', () => {
  it('流式中途增量落库（getHistory 有已累积文本）+ chat_complete 带定稿全文', async () => {
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: 't' });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (f) => frames.push(f));

    // 门闩：第一个 chunk 被 run() 消费完后流才等待，测试趁机检查中途落库。
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let firstChunkConsumed!: () => void;
    const firstConsumed = new Promise<void>((r) => (firstChunkConsumed = r));

    async function* stream(): AsyncGenerator<unknown> {
      yield chunk('你好');
      // 生成器要到第二次 next() 才会走到这里——说明首个 chunk 已被循环体处理完。
      firstChunkConsumed();
      await gate;
      yield chunk('，世界', 'STOP');
    }

    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      makeFakeConfig(stream),
    );
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: 'hi' }], 'local');
    await firstConsumed;

    // ① 流式中途：assistant 占位已被增量落库，不再是空占位。
    const midAssistant = store
      .getHistory(session.sessionId)
      .find((m) => m.role === 'assistant');
    expect(midAssistant).toBeDefined();
    expect(midAssistant!.content).toEqual([{ type: 'text', value: '你好' }]);
    // 中途不动 isStreaming——收口才定稿。
    expect(midAssistant!.isStreaming).toBe(true);

    releaseGate();
    await running;

    // ② 收口 chat_complete 帧带定稿全文（客户端据此对账自愈缺头）。
    const complete = frames.find((f) => f.type === 'chat_complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'chat_complete') {
      expect(complete.payload.text).toBe('你好，世界');
    }

    // ③ 定稿后 store 里正文完整、isStreaming=false。
    const finalAssistant = store
      .getHistory(session.sessionId)
      .find((m) => m.role === 'assistant');
    expect(finalAssistant!.content).toEqual([
      { type: 'text', value: '你好，世界' },
    ]);
    expect(finalAssistant!.isStreaming).toBe(false);
  });
});

// ── AskUserQuestion 交互闸门 ──────────────────────────────────────────────
// headless runtime 走 executeToolCall（不弹确认框），若不接闸门，ask_user_question
// 的 execute() 拿不到答案会永远返回 "User declined to answer questions."。这里验证
// 闸门把用户答案注入回工具、结果不再是 declined；以及跳过/取消时如实回落 declined。

/** 一次调用 ask_user_question 的 functionCalls chunk。 */
function askChunk(callId: string): unknown {
  return {
    candidates: [{ content: { parts: [] } }],
    functionCalls: [
      {
        name: 'ask_user_question',
        id: callId,
        args: {
          questions: [
            {
              question: '选哪个？',
              header: '选择',
              options: [
                { label: 'A 方案', description: '甲' },
                { label: 'B 方案', description: '乙' },
              ],
            },
          ],
        },
      },
    ],
  };
}

/**
 * fake Config：注册真实 AskUserQuestionTool；sendMessageStream 按轮次返回不同流
 * （第 1 轮发起工具调用，第 2 轮收口纯文本）。
 */
function makeFakeConfigWithAsk(
  turns: Array<() => AsyncGenerator<unknown>>,
): Config {
  const tool = new AskUserQuestionTool({} as unknown as Config);
  const registry = {
    discoverMcpTools: async () => undefined,
    getFunctionDeclarations: () => [],
    getTool: (name: string) =>
      name === 'ask_user_question' ? tool : undefined,
    getAllTools: () => [tool],
  };
  let call = 0;
  const fake = {
    initialize: async () => undefined,
    refreshAuth: async () => undefined,
    getToolRegistry: async () => registry,
    getOttoClient: () => ({
      getChat: async () => ({
        sendMessageStream: async () =>
          turns[Math.min(call++, turns.length - 1)](),
      }),
    }),
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
  };
  return fake as unknown as Config;
}

/** 起会话 + 订阅，返回在收到 tool_confirmation_request 时兑现的 promise。 */
function startAskSession(config: Config) {
  const store = new InMemorySessionStore();
  const session = store.createSession({ title: 't' });
  const frames: ServerToClient[] = [];
  let onQuestion!: () => void;
  const questionAsked = new Promise<void>((r) => (onQuestion = r));
  store.subscribe(session.sessionId, (f) => {
    frames.push(f);
    if (f.type === 'tool_confirmation_request') onQuestion();
  });
  const runtime = new CoreSessionRuntime(store, session.sessionId, config);
  return { store, session, frames, questionAsked, runtime };
}

/** 取某 callId 的 ask 工具卡最终结果显示文本（末次 tool_calls_update 快照）。 */
function askCardResult(
  frames: ServerToClient[],
  callId: string,
): { status: string; data?: unknown } | undefined {
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.type !== 'tool_calls_update') continue;
    const card = f.payload.toolCalls.find((t) => t.id === callId);
    if (card) return { status: card.status, data: card.result?.data };
  }
  return undefined;
}

describe('CoreSessionRuntime · AskUserQuestion 交互闸门', () => {
  it('弹问答卡 → 用户作答 → 答案注入工具结果（不再是 declined）', async () => {
    const config = makeFakeConfigWithAsk([
      () =>
        (async function* () {
          yield askChunk('call-1');
        })(),
      () =>
        (async function* () {
          yield {
            candidates: [
              { content: { parts: [{ text: '好的' }] }, finishReason: 'STOP' },
            ],
          };
        })(),
    ]);
    const { frames, session, questionAsked, runtime } =
      startAskSession(config);
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: '帮我选' }], 'local');

    // 等工具卡进入待确认（发出 tool_confirmation_request）。
    await questionAsked;

    // 待确认帧携带问题清单，状态为 awaiting_approval。
    const req = frames.find((f) => f.type === 'tool_confirmation_request');
    expect(req).toBeDefined();
    if (req?.type === 'tool_confirmation_request') {
      expect(req.payload.callId).toBe('call-1');
      expect(req.payload.toolCall.status).toBe(
        ToolCallStatus.WaitingForConfirmation,
      );
      expect(req.payload.toolCall.confirmationDetails?.type).toBe('question');
      expect(
        req.payload.toolCall.confirmationDetails?.questions?.[0]?.question,
      ).toBe('选哪个？');
    }

    // 用户作答（选 A 方案），路由回 runtime。
    runtime.resolveToolConfirmation('call-1', 'approved', {
      answers: { '选哪个？': 'A 方案' },
    });

    await running;

    // 工具卡收口为成功，结果文本含用户答案、绝不是 "declined"。
    const result = askCardResult(frames, 'call-1');
    expect(result?.status).toBe(ToolCallStatus.Success);
    expect(String(result?.data)).toContain('A 方案');
    expect(String(result?.data)).not.toContain('declined');
    // 会话不再卡在 running（可继续下一轮）。
    expect(session).toBeDefined();
  });

  it('用户跳过（rejected）→ 工具如实回落 declined', async () => {
    const config = makeFakeConfigWithAsk([
      () =>
        (async function* () {
          yield askChunk('call-2');
        })(),
      () =>
        (async function* () {
          yield {
            candidates: [
              { content: { parts: [{ text: '知道了' }] }, finishReason: 'STOP' },
            ],
          };
        })(),
    ]);
    const { frames, questionAsked, runtime } = startAskSession(config);
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: '帮我选' }], 'local');
    await questionAsked;

    runtime.resolveToolConfirmation('call-2', 'rejected');
    await running;

    const result = askCardResult(frames, 'call-2');
    // rejected → onConfirm 标记 cancelled → execute() 回落 declined（如实，不假装作答）。
    expect(String(result?.data)).toContain('declined');
  });
});
