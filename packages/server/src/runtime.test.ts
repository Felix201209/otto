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

import { describe, it, expect, vi } from 'vitest';
import type { Config, CustomModelConfig } from 'otto-core';
import {
  AskUserQuestionTool,
  ToolConfirmationOutcome,
  generateCustomModelId,
} from 'otto-core';
import { CoreSessionRuntime, messageNeedsBuiltinPptSkill } from './runtime.js';
import { InMemorySessionStore } from './sessions.js';
import { ToolCallStatus, type ServerToClient } from './protocol.js';

const noOpWorkLogger = { log: async () => undefined };

describe('PPT 内置 Skill 自动路由', () => {
  it('普通会话中的自然语言 PPT 任务也会命中，普通文档任务不会误触发', () => {
    expect(messageNeedsBuiltinPptSkill('帮我做一个产品发布会 PPT')).toBe(true);
    expect(messageNeedsBuiltinPptSkill('把这份材料整理成演示文稿')).toBe(true);
    expect(messageNeedsBuiltinPptSkill('生成一个 pitch deck')).toBe(true);
    expect(messageNeedsBuiltinPptSkill('写一份 Word 工作总结')).toBe(false);
  });

  it('命中后把随包 Skill 写入 system rules 并刷新当前 chat', async () => {
    async function* stream(): AsyncGenerator<unknown> {
      yield chunk('PPT_READY', 'STOP');
    }
    let rules = '';
    const refreshSystem = vi.fn(async () => undefined);
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getToolRegistry: async () => ({
        discoverMcpTools: async () => undefined,
        getFunctionDeclarations: () => [],
      }),
      getOttoClient: () => ({
        updateSystemPromptWithMcpPrompts: refreshSystem,
        getChat: async () => ({ sendMessageStream: async () => stream() }),
      }),
      getUserRules: () => rules,
      setUserRules: (next: string) => { rules = next; },
      getModel: () => 'test-model',
      getMaxSessionTurns: () => 10,
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '自然语言做 PPT' });
    const runtime = new CoreSessionRuntime(store, session.sessionId, config, noOpWorkLogger);
    await runtime.initialize();

    await runtime.run([{ type: 'text', value: '帮我做一份发布会 PPT' }], 'local');

    expect(rules).toContain('<skill_loaded name="ppt-creator" source="otto-builtin">');
    expect(rules).toContain('# 发布会级 PPT 视觉导演');
    expect(refreshSystem).toHaveBeenCalledTimes(1);
  });
});

describe('CoreSessionRuntime 模型切换', () => {
  it('通过 OttoClient.switchModel 切换正在使用的 live chat，而不只改 Config 标签', async () => {
    const switchModel = vi.fn(async (model: string) => ({
      success: true,
      modelName: model,
    }));
    const setModel = vi.fn();
    const config = {
      getOttoClient: () => ({ switchModel }),
      setModel,
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '模型切换' });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );

    await runtime.setModel('custom:openai-responses:gpt-5.6-sol@test');

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(switchModel).toHaveBeenCalledWith(
      'custom:openai-responses:gpt-5.6-sol@test',
      expect.any(AbortSignal),
    );
    expect(setModel).not.toHaveBeenCalled();
  });

  it('live chat 拒绝切换时如实失败，不能伪装成已生效', async () => {
    const config = {
      getOttoClient: () => ({
        switchModel: vi.fn(async () => ({
          success: false,
          modelName: 'target',
          error: '上下文无法适配目标模型',
        })),
      }),
      setModel: vi.fn(),
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '模型切换失败' });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );

    await expect(runtime.setModel('target')).rejects.toThrow(
      '上下文无法适配目标模型',
    );
  });
});

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
  it('模型请求在首个 token 前失败时返回可读错误，不残留空白 assistant', async () => {
    async function* stream(): AsyncGenerator<unknown> {
      throw new TypeError('Failed to parse URL from /v1/chat/stream');
    }
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '个人模型' });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      makeFakeConfig(stream),
      noOpWorkLogger,
    );
    await runtime.initialize();

    await runtime.run([{ type: 'text', value: '你能做什么' }], 'local');

    const assistant = store
      .getHistory(session.sessionId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      {
        type: 'text',
        value: '模型服务地址尚未配置，请先绑定个人 API。',
      },
    ]);
    const complete = frames.find((frame) => frame.type === 'chat_complete');
    expect(complete?.type === 'chat_complete' && complete.payload.text).toBe(
      '模型服务地址尚未配置，请先绑定个人 API。',
    );
    const error = frames.find((frame) => frame.type === 'error');
    expect(error?.type === 'error' && error.payload.message).toBe(
      '模型服务地址尚未配置，请先绑定个人 API。',
    );
  });

  it('模型网络失败且没有备用模型时返回可操作提示，不暴露 fetch failed', async () => {
    async function* stream(): AsyncGenerator<unknown> {
      throw new TypeError('fetch failed');
    }
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: 'DeepSeek 连接失败' });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      makeFakeConfig(stream),
      noOpWorkLogger,
    );
    await runtime.initialize();

    await runtime.run([{ type: 'text', value: '你好' }], 'local');

    const assistant = store
      .getHistory(session.sessionId)
      .find((message) => message.role === 'assistant');
    const error = frames.find((frame) => frame.type === 'error');
    const expected =
      '当前模型连接失败，已重试但仍无法访问其 API。请在模型菜单切换到其他模型，或在设置中检查 Base URL、API Key 和网络代理。';
    expect(assistant?.content).toEqual([{ type: 'text', value: expected }]);
    expect(error?.type === 'error' && error.payload.message).toBe(expected);
    expect(JSON.stringify(frames)).not.toContain('fetch failed');
  });

  it('首个 token 前网络失败时自动切到不同接口的备用模型并完成回复', async () => {
    const brokenModel: CustomModelConfig = {
      displayName: 'DeepSeek',
      provider: 'openai',
      baseUrl: 'https://broken.example/v1',
      apiKey: 'broken-key',
      modelId: 'deepseek-v4-pro',
      enabled: true,
    };
    const fallbackModel: CustomModelConfig = {
      displayName: 'GPT',
      provider: 'openai-responses',
      baseUrl: 'https://working.example/v1',
      apiKey: 'working-key',
      modelId: 'gpt-5',
      enabled: true,
    };
    const brokenId = generateCustomModelId(brokenModel);
    const fallbackId = generateCustomModelId(fallbackModel);
    let currentModel = brokenId;
    const switchModel = vi.fn(async (model: string) => {
      currentModel = model;
      return { success: true, modelName: model };
    });
    async function* brokenStream(): AsyncGenerator<unknown> {
      throw new TypeError('fetch failed');
    }
    async function* fallbackStream(): AsyncGenerator<unknown> {
      yield chunk('FALLBACK_OK', 'STOP');
    }
    const config = {
      initialize: async () => undefined,
      refreshAuth: async () => undefined,
      getToolRegistry: async () => ({
        discoverMcpTools: async () => undefined,
        getFunctionDeclarations: () => [],
      }),
      getOttoClient: () => ({
        getChat: async () => ({
          sendMessageStream: async () =>
            currentModel === brokenId ? brokenStream() : fallbackStream(),
        }),
        switchModel,
      }),
      getModel: () => currentModel,
      getMaxSessionTurns: () => 10,
      getCustomModels: () => [brokenModel, fallbackModel],
      getCustomModelConfig: (model: string) =>
        model === brokenId ? brokenModel : fallbackModel,
    } as unknown as Config;
    const store = new InMemorySessionStore();
    const session = store.createSession({
      title: '自动备用',
      model: brokenId,
    });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    await runtime.run([{ type: 'text', value: '你好' }], 'local');

    expect(switchModel).toHaveBeenCalledWith(
      fallbackId,
      expect.any(AbortSignal),
    );
    expect(store.getSession(session.sessionId)?.model).toBe(fallbackId);
    const assistant = store
      .getHistory(session.sessionId)
      .find((message) => message.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'text', value: 'FALLBACK_OK' },
    ]);
    expect(frames.some((frame) => frame.type === 'error')).toBe(false);
    const complete = frames.find((frame) => frame.type === 'chat_complete');
    expect(complete?.type === 'chat_complete' && complete.payload.text).toBe(
      'FALLBACK_OK',
    );
  });

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
      noOpWorkLogger,
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

  it('终轮完成后记录用户任务与最终工作结果', async () => {
    async function* stream(): AsyncGenerator<unknown> {
      yield chunk('已完成三家竞品的价格与定位对比。', 'STOP');
    }
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '新会话' });
    const entries: Array<Record<string, unknown>> = [];
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      makeFakeConfig(stream),
      {
        log: async (entry) => {
          entries.push(entry as unknown as Record<string, unknown>);
        },
      },
    );
    await runtime.initialize();

    await runtime.run(
      [{ type: 'text', value: '调研三家企业 AI 竞品并给出结论' }],
      'local',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      toolName: 'otto_work_result',
      entryType: 'work_result',
      taskTitle: '调研三家企业 AI 竞品并给出结论',
      userInput: '调研三家企业 AI 竞品并给出结论',
      details: '已完成三家竞品的价格与定位对比。',
      sessionId: session.sessionId,
      success: true,
    });
  });
});

// ── AskUserQuestion 交互闸门 ──────────────────────────────────────────────
// headless runtime 走 executeToolCall（不弹确认框），若不接闸门，ask_user_question
// 的 execute() 拿不到答案会永远返回 "User declined to answer questions."。这里验证
// 闸门把用户答案注入回工具、结果不再是 declined；以及跳过/取消时如实回落 declined。

/** 一次调用 ask_user_question 的 functionCalls chunk；省略 id 可模拟 Gemini 原生工具调用。 */
function askChunk(callId?: string): unknown {
  return {
    candidates: [{ content: { parts: [] } }],
    functionCalls: [
      {
        name: 'ask_user_question',
        ...(callId ? { id: callId } : {}),
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
  let onToolStarted!: () => void;
  const toolStarted = new Promise<void>((r) => (onToolStarted = r));
  store.subscribe(session.sessionId, (f) => {
    frames.push(f);
    if (f.type === 'tool_confirmation_request') onQuestion();
    if (
      f.type === 'tool_calls_update' &&
      f.payload.toolCalls.some(
        (toolCall) => toolCall.status === ToolCallStatus.Executing,
      )
    ) {
      onToolStarted();
    }
  });
  const runtime = new CoreSessionRuntime(
    store,
    session.sessionId,
    config,
    noOpWorkLogger,
  );
  return { store, session, frames, questionAsked, toolStarted, runtime };
}

/** 普通工具调用 chunk（可省略 id），用于覆盖稳定 ID 与不配合取消的工具。 */
function toolChunk(name: string, callId?: string): unknown {
  return {
    candidates: [{ content: { parts: [] } }],
    functionCalls: [
      {
        name,
        ...(callId ? { id: callId } : {}),
        args: {},
      },
    ],
  };
}

/** 注册一个最小真实执行工具；execute 可由测试注入门闩，模拟忽略 AbortSignal。 */
function makeFakeConfigWithTool(
  turns: Array<() => AsyncGenerator<unknown>>,
  execute: (
    args?: unknown,
    signal?: AbortSignal,
    updateOutput?: (output: string) => void,
  ) => Promise<{ llmContent: string; returnDisplay: string }>,
  shouldConfirmExecute: (
    args?: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown> = async () => false,
): Config {
  const tool = {
    name: 'test_tool',
    shouldConfirmExecute,
    execute,
  };
  const registry = {
    discoverMcpTools: async () => undefined,
    getFunctionDeclarations: () => [],
    getTool: (name: string) => (name === tool.name ? tool : undefined),
    getAllTools: () => [tool],
  };
  let call = 0;
  return {
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
  } as unknown as Config;
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
    const { frames, session, questionAsked, runtime } = startAskSession(config);
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
              {
                content: { parts: [{ text: '知道了' }] },
                finishReason: 'STOP',
              },
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

  it('工具阶段取消后持久消息清掉 isProcessingTools，重新拉历史不会恢复卡死停止态', async () => {
    const config = makeFakeConfigWithAsk([
      () =>
        (async function* () {
          yield askChunk('call-cancel');
        })(),
    ]);
    const { store, session, questionAsked, runtime } = startAskSession(config);
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: '帮我选' }], 'local');
    await questionAsked;
    runtime.cancel();
    await running;

    const assistant = store
      .getHistory(session.sessionId)
      .find((message) => message.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant?.isStreaming).toBe(false);
    expect(assistant?.isProcessingTools).toBe(false);
  });

  it('模型未提供 functionCall.id 时，同一次调用仍沿用唯一稳定 id', async () => {
    const config = makeFakeConfigWithAsk([
      () =>
        (async function* () {
          yield askChunk();
        })(),
    ]);
    const { frames, toolStarted, runtime } = startAskSession(config);
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: '帮我选' }], 'local');
    await toolStarted;
    // 让 gateAskUserQuestion 有机会发布确认帧；旧实现会因二次生成随机 id 而找不到卡。
    await Promise.resolve();
    runtime.cancel();
    await running;

    const initial = frames.find((frame) => frame.type === 'tool_calls_update');
    const request = frames.find(
      (frame) => frame.type === 'tool_confirmation_request',
    );
    expect(initial?.type).toBe('tool_calls_update');
    expect(request?.type).toBe('tool_confirmation_request');
    if (
      initial?.type === 'tool_calls_update' &&
      request?.type === 'tool_confirmation_request'
    ) {
      expect(request.payload.callId).toBe(initial.payload.toolCalls[0]?.id);
    }
  });
});

describe('CoreSessionRuntime · 工具状态收口', () => {
  it('飞书适配器发起的普通工具无需桌面确认即可执行', async () => {
    let markProgress!: () => void;
    const progress = new Promise<void>((resolve) => {
      markProgress = resolve;
    });
    const onConfirm = vi.fn(async () => {
      markProgress();
    });
    const execute = vi.fn(async () => {
      markProgress();
      return { llmContent: 'tool done', returnDisplay: 'tool done' };
    });
    const config = makeFakeConfigWithTool(
      [
        () =>
          (async function* () {
            yield toolChunk('test_tool', 'feishu-auto');
          })(),
        () =>
          (async function* () {
            yield chunk('已完成', 'STOP');
          })(),
      ],
      execute,
      async () => ({
        type: 'exec',
        title: '执行测试工具',
        command: 'test_tool',
        warning: '测试高风险操作',
        onConfirm,
      }),
    );
    const store = new InMemorySessionStore();
    const session = store.getOrCreateFeishuSession('oc_confirm');
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => {
      frames.push(frame);
      if (frame.type === 'tool_confirmation_request') markProgress();
    });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    const running = runtime.run(
      [{ type: 'text', value: '执行操作' }],
      'feishu',
    );
    await progress;
    const requested = frames.some(
      (frame) => frame.type === 'tool_confirmation_request',
    );
    if (requested) {
      runtime.resolveToolConfirmation('feishu-auto', 'approved');
    }
    await running;

    expect(requested).toBe(false);
    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('桌面在飞书绑定会话里发起工具时仍保留确认', async () => {
    const onConfirm = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      llmContent: 'tool done',
      returnDisplay: 'tool done',
    }));
    const config = makeFakeConfigWithTool(
      [
        () =>
          (async function* () {
            yield toolChunk('test_tool', 'local-confirm');
          })(),
        () =>
          (async function* () {
            yield chunk('已完成', 'STOP');
          })(),
      ],
      execute,
      async () => ({
        type: 'exec',
        title: '执行测试工具',
        command: 'test_tool',
        onConfirm,
      }),
    );
    const store = new InMemorySessionStore();
    const session = store.getOrCreateFeishuSession('oc_local_confirm');
    let confirmRequested!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      confirmRequested = resolve;
    });
    store.subscribe(session.sessionId, (frame) => {
      if (frame.type === 'tool_confirmation_request') confirmRequested();
    });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    const running = runtime.run(
      [{ type: 'text', value: '从桌面执行操作' }],
      'local',
    );
    await confirmation;
    expect(execute).not.toHaveBeenCalled();
    runtime.resolveToolConfirmation('local-confirm', 'approved');
    await running;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('工具尚未结束时就把实时授权 URL 写入 liveOutput 并发布给桌面端', async () => {
    const authUrl =
      'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=flow-1&user_code=ABCD';
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let markToolInvoked!: () => void;
    const toolInvoked = new Promise<void>((resolve) => {
      markToolInvoked = resolve;
    });
    const config = makeFakeConfigWithTool(
      [
        () =>
          (async function* () {
            yield toolChunk('test_tool', 'auth-live');
          })(),
        () =>
          (async function* () {
            yield chunk('授权完成', 'STOP');
          })(),
      ],
      async (_args, _signal, updateOutput) => {
        updateOutput?.(`请扫码授权：\n${authUrl}`);
        markToolInvoked();
        await toolGate;
        return { llmContent: 'done', returnDisplay: 'done' };
      },
    );
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: '授权' });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: '连接飞书' }], 'local');
    await toolInvoked;
    const liveFrame = frames.find(
      (frame) =>
        frame.type === 'tool_calls_update' &&
        frame.payload.toolCalls.some((toolCall) =>
          toolCall.liveOutput?.includes(authUrl),
        ),
    );

    releaseTool();
    await running;
    expect(liveFrame).toBeDefined();
  });

  it('普通工具成功并进入下一轮后，历史消息不残留 isProcessingTools=true', async () => {
    const config = makeFakeConfigWithTool(
      [
        () =>
          (async function* () {
            yield toolChunk('test_tool', 'stable-ok');
          })(),
        () =>
          (async function* () {
            yield chunk('done', 'STOP');
          })(),
      ],
      async () => ({ llmContent: 'tool done', returnDisplay: 'tool done' }),
    );
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: 't' });
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    await runtime.run([{ type: 'text', value: 'run tool' }], 'local');

    const assistants = store
      .getHistory(session.sessionId)
      .filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(
      assistants.every((message) => message.isProcessingTools !== true),
    ).toBe(true);
    expect(assistants[0]?.isProcessingTools).toBe(false);
    expect(assistants[0]?.associatedToolCalls?.[0]?.status).toBe(
      ToolCallStatus.Success,
    );
  });

  it('工具忽略 AbortSignal 时，cancel 也立即发布取消终态，不等待工具返回', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>(
      (resolve) => (markToolStarted = resolve),
    );
    const config = makeFakeConfigWithTool(
      [
        () =>
          (async function* () {
            yield toolChunk('test_tool', 'blocking');
          })(),
      ],
      async () => {
        markToolStarted();
        await toolGate; // 刻意不读取 signal，模拟不配合取消的长耗时工具。
        return { llmContent: 'late result', returnDisplay: 'late result' };
      },
    );
    const store = new InMemorySessionStore();
    const session = store.createSession({ title: 't' });
    const frames: ServerToClient[] = [];
    store.subscribe(session.sessionId, (frame) => frames.push(frame));
    const runtime = new CoreSessionRuntime(
      store,
      session.sessionId,
      config,
      noOpWorkLogger,
    );
    await runtime.initialize();

    const running = runtime.run([{ type: 'text', value: 'run tool' }], 'local');
    await toolStarted;
    runtime.cancel();
    await Promise.resolve();
    const cancelledBeforeToolReturned = frames.some(
      (frame) =>
        frame.type === 'chat_complete' &&
        frame.payload.finishReason === 'cancelled',
    );
    const cardCancelledBeforeToolReturned = frames.some(
      (frame) =>
        frame.type === 'tool_calls_update' &&
        frame.payload.toolCalls.some(
          (toolCall) => toolCall.status === ToolCallStatus.Canceled,
        ),
    );

    releaseTool();
    await running;

    expect(cancelledBeforeToolReturned).toBe(true);
    expect(cardCancelledBeforeToolReturned).toBe(true);
  });
});
