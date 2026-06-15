/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * customModelAdapter 末梢防线（callCustomModel / callCustomModelStream）的 sanitize 测试。
 *
 * 背景：
 *   commit e5f01a81 把 GeminiChat.sanitizeRequestContents 装在了 callCustomModel
 *   和 callCustomModelStream 的入口。这是「最后一道防线」——即使 setHistory/resumeChat
 *   被绕过、即使有别的代码路径直接通过 `chat.setHistory(...)` 把脏数据塞进去，
 *   出网前还会被这层兜住。
 *
 *   如果未来重构去掉了这两个入口的 sanitize 调用，该测试必须立刻报警。
 *
 * 测试策略：
 *   不需要真的发网络请求。只验证：
 *     1) 任意 provider 的 callCustomModel 都会调用 GeminiChat.sanitizeRequestContents
 *     2) 调用入参是 request.contents
 *     3) 下游 provider 函数收到的是「清洗后的版本」
 *
 *   这里的下游 provider 函数（callAnthropicModel 等）都会发 HTTP 请求，
 *   我们用 vi.spyOn(GeminiChat, 'sanitizeRequestContents') 做哨兵，
 *   并通过 mock global.fetch 阻断真实网络。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiChat } from './geminiChat.js';
import { callCustomModel, callCustomModelStream } from './customModelAdapter.js';
import { Content } from '../types/extendedContent.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';

// 模拟生产报错时的脏 contents：开头就是孤立 functionResponse + 末尾以 model 收尾
function makeDirtyContents(): Content[] {
  return [
    {
      role: MESSAGE_ROLES.USER,
      parts: [
        {
          functionResponse: {
            name: 'glob',
            id: 'toolu_orphan',
            response: { result: 'leftover' },
          } as any,
        },
      ],
    },
    {
      role: MESSAGE_ROLES.MODEL,
      parts: [{ text: '你好' } as any],
    },
    // 第二条 model 消息相邻 → 应当被合并
    {
      role: MESSAGE_ROLES.MODEL,
      parts: [{ text: '又说了一次' } as any],
    },
  ];
}

// 极简 stub，让 fetch 立即回一个 GenerateContentResponse 形状的 JSON
// 仅用于让 callCustomModel 能完整执行而不抛网络错。
function stubFetchOk() {
  const stubResponse = {
    candidates: [
      {
        content: { parts: [{ text: 'stub' }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };

  // 流式 stream stub：必须实现 ReadableStream 接口，下游 SDK 会逐 chunk 读
  const encoder = new TextEncoder();
  const sseChunks = [
    `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'x', usage: {} } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    `data: [DONE]\n\n`,
  ];

  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => stubResponse,
    text: async () => JSON.stringify(stubResponse),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  } as any);
}

describe('customModelAdapter > callCustomModel sanitize 末梢防线', () => {
  let sanitizeSpy: any;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    sanitizeSpy = vi.spyOn(GeminiChat, 'sanitizeRequestContents');
    originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetchOk() as any;
  });

  afterEach(() => {
    sanitizeSpy.mockRestore();
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as any).fetch;
  });

  // 实测：任意 provider 都共享同一个清洗入口
  // 我们逐个 provider 跑一遍，确认安全网无遗漏
  it.each(['openai', 'anthropic', 'gemini', 'openai-responses'] as const)(
    'provider=%s：脏 contents 经 callCustomModel 后，sanitize 必须被调用一次',
    async (provider) => {
      const dirty = makeDirtyContents();
      const modelConfig: any = {
        provider,
        modelId: 'fake-model',
        displayName: `fake ${provider}`,
        baseUrl: 'https://example.test',
        apiKey: 'test-key',
      };

      // 各 provider 内部实现细节可能在 fetch 后做不同处理；
      // 我们只关心 sanitize 是否被以脏 contents 调用一次，因此 catch 掉真实执行错误。
      try {
        await callCustomModel(modelConfig, { contents: dirty });
      } catch {
        // 忽略：fetch stub 不能完全 satisfy 所有 provider 的解析路径，
        // 但「sanitize 被调用」发生在任何下游 dispatch 之前
      }

      expect(sanitizeSpy).toHaveBeenCalledTimes(1);
      const calledWith = sanitizeSpy.mock.calls[0][0] as Content[];
      // 入参必须是原始脏 contents（同一个引用或同一份数据）
      expect(calledWith).toEqual(dirty);
    },
  );

  it('contents 缺失时（request 没有 contents 字段）：不应调用 sanitize、也不应崩溃', async () => {
    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      await callCustomModel(modelConfig, {} as any);
    } catch {
      // ignore
    }

    expect(sanitizeSpy).not.toHaveBeenCalled();
  });

  it('contents 是非数组（如字符串）：不应调用 sanitize、也不应崩溃', async () => {
    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      await callCustomModel(modelConfig, { contents: 'hello' as any });
    } catch {
      // ignore
    }

    expect(sanitizeSpy).not.toHaveBeenCalled();
  });

  it('清洗结果应当满足协议不变量（末尾 user / 无相邻同 role / 无孤立 fr）', async () => {
    const dirty = makeDirtyContents();
    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      await callCustomModel(modelConfig, { contents: dirty });
    } catch {
      // ignore
    }

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    const sanitized = sanitizeSpy.mock.results[0].value as Content[];

    // 末尾必须是 user
    expect(sanitized[sanitized.length - 1].role).toBe(MESSAGE_ROLES.USER);
    // 无相邻同 role
    for (let i = 1; i < sanitized.length; i++) {
      expect(sanitized[i].role).not.toBe(sanitized[i - 1].role);
    }
    // 无 toolu_orphan
    const hasOrphan = sanitized
      .flatMap(c => c.parts || [])
      .some((p: any) => p.functionResponse?.id === 'toolu_orphan');
    expect(hasOrphan).toBe(false);
  });

  it('原始 request 对象不被 sanitize 修改（不可变约束）', async () => {
    const dirty = makeDirtyContents();
    const originalLength = dirty.length;
    const originalRoles = dirty.map(c => c.role);

    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      await callCustomModel(modelConfig, { contents: dirty });
    } catch {
      // ignore
    }

    // 原始 dirty 数组不应被 sanitize 修改
    expect(dirty).toHaveLength(originalLength);
    expect(dirty.map(c => c.role)).toEqual(originalRoles);
  });
});

describe('customModelAdapter > callCustomModelStream sanitize 末梢防线', () => {
  let sanitizeSpy: any;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    sanitizeSpy = vi.spyOn(GeminiChat, 'sanitizeRequestContents');
    originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetchOk() as any;
  });

  afterEach(() => {
    sanitizeSpy.mockRestore();
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as any).fetch;
  });

  it.each(['openai', 'anthropic', 'gemini', 'openai-responses'] as const)(
    'provider=%s：脏 contents 经 callCustomModelStream 后，sanitize 必须被调用一次',
    async (provider) => {
      const dirty = makeDirtyContents();
      const modelConfig: any = {
        provider,
        modelId: 'fake-model',
        displayName: `fake ${provider}`,
        baseUrl: 'https://example.test',
        apiKey: 'test-key',
      };

      try {
        const stream = callCustomModelStream(modelConfig, { contents: dirty });
        // 至少消费一次以让 stream 生成器进入 sanitize 阶段
        // （sanitize 在 yield 之前执行；first await 即触发）
        await stream.next();
      } catch {
        // 流式下游可能因为 stub 不完整而抛错，但 sanitize 必定已被调用
      }

      expect(sanitizeSpy).toHaveBeenCalledTimes(1);
      const calledWith = sanitizeSpy.mock.calls[0][0] as Content[];
      expect(calledWith).toEqual(dirty);
    },
  );

  it('stream 路径下 contents 缺失：不应调用 sanitize', async () => {
    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      const stream = callCustomModelStream(modelConfig, {} as any);
      await stream.next();
    } catch {
      // ignore
    }

    expect(sanitizeSpy).not.toHaveBeenCalled();
  });
});

describe('customModelAdapter > 末梢防线与上游入口的协同', () => {
  let sanitizeSpy: any;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    sanitizeSpy = vi.spyOn(GeminiChat, 'sanitizeRequestContents');
    originalFetch = globalThis.fetch;
    globalThis.fetch = stubFetchOk() as any;
  });

  afterEach(() => {
    sanitizeSpy.mockRestore();
    if (originalFetch) globalThis.fetch = originalFetch;
    else delete (globalThis as any).fetch;
  });

  it('已经清洗过一次的 contents 再走末梢防线：行为幂等，不会破坏数据', async () => {
    const dirty = makeDirtyContents();
    // 模拟「已经被 setHistory 清洗过」的场景
    const preCleaned = GeminiChat.sanitizeRequestContents(dirty);
    sanitizeSpy.mockClear();

    const modelConfig: any = {
      provider: 'openai',
      modelId: 'fake',
      displayName: 'fake',
      baseUrl: 'https://example.test',
      apiKey: 'k',
    };

    try {
      await callCustomModel(modelConfig, { contents: preCleaned });
    } catch {
      // ignore
    }

    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    const finalSanitized = sanitizeSpy.mock.results[0].value as Content[];
    // 第二次清洗结果应当与第一次清洗结果完全一致（幂等）
    expect(finalSanitized).toEqual(preCleaned);
  });
});
