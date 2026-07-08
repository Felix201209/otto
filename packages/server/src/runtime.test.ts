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
import { CoreSessionRuntime } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import type { ServerToClient } from './protocol.js';

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
