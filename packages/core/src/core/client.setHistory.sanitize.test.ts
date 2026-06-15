/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GeminiClient 的入口安全网端到端测试。
 *
 * 背景：
 *   /session select、useSessionRestore、ACP 会话水化、vscode-ui-plugin
 *   等多个真实路径都会通过 client.setHistory / client.resumeChat 注入历史。
 *   commit e5f01a81 的修复点正是把 GeminiChat.sanitizeRequestContents 装在了
 *   这两个入口上。如果未来有人重构这两个方法不小心去掉了清洗调用，
 *   这套测试必须立刻报警。
 *
 * 测试策略：
 *   GeminiClient 的真实 constructor 依赖 Config 的若干内部服务（ToolRegistry、
 *   PromptRegistry、HookSystem 等），完整 mock 成本极高。我们使用
 *   Object.create(GeminiClient.prototype) 跳过 constructor，注入一个
 *   伪造的 chat 对象，仅验证两件事：
 *     1) setHistory(脏历史) → 伪 chat 收到的是清洗后的数据
 *     2) resumeChat(脏历史) → 内部 startChat 被调用时收到的是清洗后的数据
 *
 *   清洗算法本身在 sanitizeRequestContents.test.ts / fixRequestContents.test.ts
 *   已有 60+ 用例验证；这里只关心「门是否真的装上了」。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiClient } from './client.js';
import { GeminiChat } from './geminiChat.js';
import { Content } from '../types/extendedContent.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';

// 制造一段「脏历史」：开头就是孤立的 functionResponse
// 这是真实 Bedrock 400 报错时用户磁盘上保存的会话快照
function makeDirtyHistory(): Content[] {
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
      parts: [{ text: '继续聊天' } as any],
    },
    // 末尾故意以 model 收尾（防 Bedrock prefill 的另一类脏输入）
    {
      role: MESSAGE_ROLES.MODEL,
      parts: [{ text: '上次回复中断了' } as any],
    },
  ];
}

describe('GeminiClient.setHistory > 入口安全网', () => {
  let client: GeminiClient;
  let mockChat: { setHistory: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = Object.create(GeminiClient.prototype) as GeminiClient;
    mockChat = { setHistory: vi.fn() };
    // 注入伪 chat
    (client as any).chat = mockChat;
  });

  it('脏历史进入 setHistory：底层 chat 应当收到「已清洗」的版本', () => {
    const dirty = makeDirtyHistory();

    client.setHistory(dirty);

    expect(mockChat.setHistory).toHaveBeenCalledTimes(1);
    const received = mockChat.setHistory.mock.calls[0][0] as Content[];

    // 不变量 1：孤立的 functionResponse 必须被清掉
    const hasOrphan = received
      .flatMap(c => c.parts || [])
      .some((p: any) => p.functionResponse?.id === 'toolu_orphan');
    expect(hasOrphan).toBe(false);

    // 不变量 2：末尾必须是 user（Bedrock prefill 防护）
    expect(received[received.length - 1].role).toBe(MESSAGE_ROLES.USER);

    // 不变量 3：相邻消息 role 不重复（合并相邻同 role）
    for (let i = 1; i < received.length; i++) {
      expect(received[i].role).not.toBe(received[i - 1].role);
    }
  });

  it('清洁历史进入 setHistory：底层 chat 收到的内容应当与输入语义等价', () => {
    const clean: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'hello' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'how are you' } as any] },
    ];

    client.setHistory(clean);

    const received = mockChat.setHistory.mock.calls[0][0] as Content[];
    expect(received).toEqual(clean);
  });

  it('空数组：底层 chat 收到空数组', () => {
    client.setHistory([]);
    expect(mockChat.setHistory).toHaveBeenCalledWith([]);
  });

  it('非数组（极端容错）：原样转交给底层 chat（不应崩溃）', () => {
    // setHistory 内部的 Array.isArray 守卫会让非数组直接透传给底层 chat。
    // 这是已知行为：让底层自行决定如何处理非法类型，而不是在卫士层 throw。
    expect(() => client.setHistory(undefined as any)).not.toThrow();
    expect(mockChat.setHistory).toHaveBeenCalledWith(undefined);
  });

  it('哨兵：直接验证 sanitizeRequestContents 在 setHistory 路径上被调用', () => {
    const sanitizeSpy = vi.spyOn(GeminiChat, 'sanitizeRequestContents');
    const dirty = makeDirtyHistory();
    client.setHistory(dirty);
    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    expect(sanitizeSpy).toHaveBeenCalledWith(dirty);
    sanitizeSpy.mockRestore();
  });
});

describe('GeminiClient.resumeChat > 入口安全网', () => {
  let client: GeminiClient;
  let startChatSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = Object.create(GeminiClient.prototype) as GeminiClient;
    // resumeChat 内部会调用 this.startChat(sanitized) 并把返回值赋给 this.chat；
    // 我们只关心 startChat 收到了什么参数，因此用 spy 替换 startChat。
    startChatSpy = vi.fn().mockResolvedValue({ /* fake GeminiChat */ });
    (client as any).startChat = startChatSpy;
    // resumeChat 还会调用 resetCompressionFlag，提供 noop 即可
    (client as any).resetCompressionFlag = vi.fn();
  });

  it('脏历史进入 resumeChat：startChat 收到「已清洗」的版本', async () => {
    const dirty = makeDirtyHistory();

    await client.resumeChat(dirty);

    expect(startChatSpy).toHaveBeenCalledTimes(1);
    const received = startChatSpy.mock.calls[0][0] as Content[];

    // 不变量 1：孤立 fr 已被清掉
    const hasOrphan = received
      .flatMap(c => c.parts || [])
      .some((p: any) => p.functionResponse?.id === 'toolu_orphan');
    expect(hasOrphan).toBe(false);

    // 不变量 2：末尾应该是 user 消息（追加了 [Conversation continues] 占位）
    expect(received[received.length - 1].role).toBe(MESSAGE_ROLES.USER);
  });

  it('清洁历史进入 resumeChat：startChat 收到的内容与输入等价', async () => {
    const clean: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'q' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'a' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'continue' } as any] },
    ];

    await client.resumeChat(clean);

    const received = startChatSpy.mock.calls[0][0] as Content[];
    expect(received).toEqual(clean);
  });

  it('空历史：startChat 收到空数组', async () => {
    await client.resumeChat([]);
    expect(startChatSpy).toHaveBeenCalledWith([]);
  });

  it('哨兵：sanitizeRequestContents 必须在 resumeChat 路径上被调用', async () => {
    const sanitizeSpy = vi.spyOn(GeminiChat, 'sanitizeRequestContents');
    const dirty = makeDirtyHistory();
    await client.resumeChat(dirty);
    expect(sanitizeSpy).toHaveBeenCalledTimes(1);
    expect(sanitizeSpy).toHaveBeenCalledWith(dirty);
    sanitizeSpy.mockRestore();
  });
});

describe('GeminiClient > 入口安全网防御性场景', () => {
  let client: GeminiClient;
  let mockChat: { setHistory: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = Object.create(GeminiClient.prototype) as GeminiClient;
    mockChat = { setHistory: vi.fn() };
    (client as any).chat = mockChat;
  });

  it('多个 functionCall 全部丢失响应（截断的工具调用回合）：应被补 cancel 并以 user 收尾', () => {
    const broken: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'do many things' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'a', id: 'a-1', args: {} } as any },
          { functionCall: { name: 'b', id: 'b-1', args: {} } as any },
          { functionCall: { name: 'c', id: 'c-1', args: {} } as any },
        ],
      },
      // 流被中断，没有 user(functionResponse) 跟在后面
    ];

    client.setHistory(broken);
    const received = mockChat.setHistory.mock.calls[0][0] as Content[];

    // 末尾应是 user 消息（cancel 补全），且包含 a/b/c 三个 cancel
    const last = received[received.length - 1];
    expect(last.role).toBe(MESSAGE_ROLES.USER);
    const cancelIds = (last.parts || [])
      .map((p: any) => p.functionResponse?.id)
      .filter(Boolean);
    expect(cancelIds).toEqual(expect.arrayContaining(['a-1', 'b-1', 'c-1']));
  });

  it('functionResponse 提前到达（response 在 call 之前）：作为孤立项被移除', () => {
    const wrongOrder: Content[] = [
      // response 在前
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'fn', id: 'pre', response: {} } as any }],
      },
      // call 在后（同名同 id）
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: 'pre', args: {} } as any }],
      },
    ];

    client.setHistory(wrongOrder);
    const received = mockChat.setHistory.mock.calls[0][0] as Content[];

    // 提前到达的 response 在 final cleanup 阶段会被识别为没有「前置 call」
    // （final cleanup 是按顺序扫描，call 出现在 response 之后不算）
    // 因此这条 response 必须被清掉，最终只留 model(call) → 补 user(cancel)
    const hasPreResponse = received
      .flatMap(c => c.parts || [])
      .some(
        (p: any) =>
          p.functionResponse?.id === 'pre' &&
          p.functionResponse?.response &&
          Object.keys(p.functionResponse.response).length === 0,
      );
    expect(hasPreResponse).toBe(false);

    // 末尾须是 user（补的 cancel）
    expect(received[received.length - 1].role).toBe(MESSAGE_ROLES.USER);
  });

  it('混入 inlineData（图片）的复杂历史：不影响图片，仅清理 fr/fc 孤立项', () => {
    const mixed: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { text: '看下这张图' } as any,
          { inlineData: { mimeType: 'image/png', data: 'aGk=' } } as any,
        ],
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: '收到' } as any],
      },
      // 故意混入孤立 fr
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'orphan', id: 'orphan', response: {} } as any },
          { text: '继续' } as any,
        ],
      },
    ];

    client.setHistory(mixed);
    const received = mockChat.setHistory.mock.calls[0][0] as Content[];

    // 图片仍在
    const hasImage = received
      .flatMap(c => c.parts || [])
      .some((p: any) => p.inlineData?.mimeType === 'image/png');
    expect(hasImage).toBe(true);

    // 孤立 fr 已被清掉
    const hasOrphan = received
      .flatMap(c => c.parts || [])
      .some((p: any) => p.functionResponse?.id === 'orphan');
    expect(hasOrphan).toBe(false);

    // 末尾用户的 text "继续" 仍在
    const allTexts = received.flatMap(c => c.parts || []).map((p: any) => p.text).filter(Boolean);
    expect(allTexts).toContain('继续');
  });
});
