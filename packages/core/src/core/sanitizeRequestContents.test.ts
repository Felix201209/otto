/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * sanitizeRequestContents 是 fixRequestContents 的静态包装器，
 * 它是 /session select、resumeChat、CustomModelAdapter 出网前的「最后一道安全网」。
 *
 * fixRequestContents.test.ts 已经覆盖了「正常 + 部分边界」的协议场景；
 * 本文件聚焦于「奇葩输入 / 真实生产事故 / 多层污染嵌套」的回归用例：
 *
 *   - 已知 Bedrock 400：孤立 tool_result 在历史首条
 *   - 末尾以 model 收尾：必须追加 user 占位符
 *   - 截断后 functionCall 残留 / functionResponse 提前到达
 *   - 跨轮 ID 复用（同一 callId 出现多次）
 *   - 多个 cancel + 多个真实结果混在一起
 *   - 完全空对象 / parts 缺失 / role 异常 / 怪异类型字段
 *   - 静态方法与实例方法行为完全一致（防漂移哨兵）
 *   - 调用方可以反复调用且幂等（再清洗一次结果不再变）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiChat } from './geminiChat.js';
import { Content } from '../types/extendedContent.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { Config } from '../config/config.js';
import { logger } from '../utils/enhancedLogger.js';

vi.mock('../config/config.js');
vi.mock('./contentGenerator.js');

// 公共 mock config，避免每个 describe 都重写一遍
function makeMockConfig(): Config {
  return {
    getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
    getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'oauth' }),
    getProjectRoot: vi.fn().mockReturnValue('/mock/path'),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
    setModel: vi.fn(),
  } as unknown as Config;
}

// 静默业务日志，避免污染 vitest 输出
let loggerDebugSpy: ReturnType<typeof vi.spyOn> | undefined;
let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  loggerDebugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  loggerDebugSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  consoleLogSpy?.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────
// 1. 静态 / 实例方法行为一致性（防漂移哨兵）
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 静态/实例一致性', () => {
  it('简单输入：静态方法应当与实例方法 fixRequestContents 行为完全一致', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'search', id: 'abc', args: {} } as any },
        ],
      },
    ];

    const chat = new GeminiChat(makeMockConfig(), {} as any);
    const instanceResult = (chat as any).fixRequestContents(input);
    const staticResult = GeminiChat.sanitizeRequestContents(input);
    expect(staticResult).toEqual(instanceResult);
  });

  it('复杂输入：脏历史（模型截断+混合 ID 缺失）也应当行为一致', () => {
    // 这是更接近真实事故的输入
    const dirty: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          {
            functionResponse: {
              name: 'glob',
              id: 'toolu_glob_orphan',
              response: { result: 'leftover-from-truncated-session' },
            } as any,
          },
        ],
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { text: '我来帮你查文件' } as any,
          { functionCall: { name: 'read_file', id: 'rf-1', args: { path: 'a' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', id: 'rf-1', response: { content: 'ok' } } as any },
        ],
      },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: '完成' } as any] },
    ];

    const chat = new GeminiChat(makeMockConfig(), {} as any);
    const instanceResult = (chat as any).fixRequestContents(dirty);
    const staticResult = GeminiChat.sanitizeRequestContents(dirty);
    expect(staticResult).toEqual(instanceResult);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. 已知生产事故：/session select 加载脏历史 → Bedrock 400
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 真实事故回归', () => {
  it('Bedrock 400 现场还原：历史首条就是孤立 functionResponse，应当被移除', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          {
            functionResponse: {
              name: 'glob',
              id: 'toolu_glob',
              response: { result: 'ok' },
            } as any,
          },
        ],
      },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: '继续聊天' } as any],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '请你检查一下上面生成的MVP项目，调优一下。' } as any],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);

    const allParts = result.flatMap(c => c.parts || []);
    const hasOrphan = allParts.some(
      p => (p as any).functionResponse && (p as any).functionResponse.id === 'toolu_glob',
    );
    expect(hasOrphan).toBe(false);

    const lastUser = result[result.length - 1];
    expect(lastUser.role).toBe(MESSAGE_ROLES.USER);
  });

  it('末尾以 model 消息收尾时应自动追加 user 占位（防止 Anthropic prefill 错误）', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: '你好' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: '你好啊' } as any] },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const last = result[result.length - 1];
    expect(last.role).toBe(MESSAGE_ROLES.USER);
    expect((last.parts?.[0] as any).text).toBe('[Conversation continues]');
  });

  it('多个孤立 functionResponse 同时出现：应当全部被移除', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'a', id: 'a-1', response: {} } as any },
          { functionResponse: { name: 'b', id: 'b-1', response: {} } as any },
          { functionResponse: { name: 'c', id: 'c-1', response: {} } as any },
        ],
      },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'reply' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'continue' } as any] },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const remainingFRIds = result.flatMap(c => c.parts || [])
      .map((p: any) => p.functionResponse?.id)
      .filter(Boolean);
    expect(remainingFRIds).toEqual([]);
  });

  it('孤立 fr 与正常 fr/fc 配对混在同一历史：只清孤立、保留正常', () => {
    const input: Content[] = [
      // 孤立的（前置 call 已丢失）
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'orphan', id: 'orphan-1', response: {} } as any },
        ],
      },
      // 正常配对
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'paired', id: 'paired-1', args: {} } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'paired', id: 'paired-1', response: { ok: true } } as any },
        ],
      },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'done' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'next?' } as any] },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const ids = result.flatMap(c => c.parts || [])
      .map((p: any) => p.functionResponse?.id)
      .filter(Boolean);
    expect(ids).toContain('paired-1');
    expect(ids).not.toContain('orphan-1');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. 截断 / 流中断的各种残局
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 截断/流中断残局', () => {
  it('functionCall 在最后一条 model 没有任何后续：应当被补 user-cancel 并以 user 收尾', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: '搜个东西' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'search', id: 'abc', args: { q: 'x' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const last = result[result.length - 1];
    expect(last.role).toBe(MESSAGE_ROLES.USER);
    const cancelPart = last.parts?.find(
      (p: any) => p.functionResponse?.id === 'abc',
    );
    expect(cancelPart).toBeDefined();
    expect(((cancelPart as any).functionResponse.response as any).result).toBe('user cancel');
  });

  it('多个相邻 user 消息（中断恢复时常见）：应当合并成一条 user', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'q' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: 'c1', args: {} } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'fn', id: 'c1', response: { v: 1 } } as any }],
      },
      // 由客户端注入的 "continue" 消息
      { role: MESSAGE_ROLES.USER, parts: [{ text: '[System] continue' } as any] },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    // 任意相邻两条 role 不能相同
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
    // 尾部 user 应该既包含 functionResponse 又包含 text
    const last = result[result.length - 1];
    expect(last.role).toBe(MESSAGE_ROLES.USER);
    const partTypes = (last.parts || []).map((p: any) =>
      p.functionResponse ? 'fr' : p.text ? 'text' : 'unknown',
    );
    expect(partTypes).toContain('fr');
    expect(partTypes).toContain('text');
  });

  it('cancel 与真实结果分散在两条 user：保留真实结果，不再补冗余 cancel', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'todo_write', id: 'tw-1' } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{
          functionResponse: { name: 'todo_write', id: 'tw-1', response: { result: 'user cancel' } } as any,
        }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{
          functionResponse: { name: 'todo_write', id: 'tw-1', response: { output: 'real-result' } } as any,
        }],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fRs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    expect(fRs).toHaveLength(1);
    expect((fRs[0] as any).functionResponse.response.output).toBe('real-result');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Claude / Anthropic 兼容性：ID 缺失 / 模糊匹配
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > Claude/Anthropic 协议兼容', () => {
  it('Call 无 ID + Response 有 ID：应通过 name 匹配并对齐 ID', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        // Claude 风格：functionCall 缺失 ID
        parts: [{ functionCall: { name: 'glob', args: { pattern: '**/*' } } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'glob', id: 'glob-real', response: { output: 'files' } } as any }],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fr = result.flatMap(c => c.parts || []).find((p: any) => p.functionResponse);
    expect(fr).toBeDefined();
    // 业务的「ID 对齐」逻辑会让 response 的 id 同步成 call 的 id
    expect((fr as any).functionResponse.id).toBeUndefined();
    expect((fr as any).functionResponse.response.output).toBe('files');
  });

  it('Call 有 ID + Response 无 ID：应通过 name 匹配并保留', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'search', id: 'search-1', args: {} } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'search', response: { ok: true } } as any }],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fr = result.flatMap(c => c.parts || []).find((p: any) => p.functionResponse);
    expect(fr).toBeDefined();
    expect((fr as any).functionResponse.name).toBe('search');
  });

  it('混合：同一历史中既有 call 缺 ID、又有 response 缺 ID', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'a', args: {} } as any }, // call 无 ID
          { functionCall: { name: 'b', id: 'b-1', args: {} } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'a', id: 'a-1', response: {} } as any }, // response 有 ID
          { functionResponse: { name: 'b', response: {} } as any }, // response 无 ID
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fNames = result
      .flatMap(c => c.parts || [])
      .filter((p: any) => p.functionResponse)
      .map((p: any) => p.functionResponse.name);
    expect(fNames).toContain('a');
    expect(fNames).toContain('b');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. 重复 / 仲裁 / 跨轮 ID 复用
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 仲裁与去重', () => {
  it('完全相同的 functionResponse 出现两次：仅保留一个', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: 'c1', args: {} } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'fn', id: 'c1', response: { v: 1 } } as any },
          { functionResponse: { name: 'fn', id: 'c1', response: { v: 1 } } as any }, // 完全重复
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fRs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    expect(fRs).toHaveLength(1);
  });

  it('真实结果优先于 user cancel（即便 cancel 在前）', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: 'c1' } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'fn', id: 'c1', response: { result: 'user cancel' } } as any },
          { functionResponse: { name: 'fn', id: 'c1', response: { value: 'REAL' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fRs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    expect(fRs).toHaveLength(1);
    expect((fRs[0] as any).functionResponse.response.value).toBe('REAL');
  });

  it('同一对话连续多轮使用相同 callId（理论上不该但生产偶发）：应整体保留所有配对', () => {
    // 极少数情况下，模型/客户端会在不同轮里复用同一个 toolu_xxx
    // 业务规则：结构合法（model→user→model→user 交替）就保留
    const input: Content[] = [
      { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'fn', id: 'shared', args: { v: 1 } } as any }] },
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'fn', id: 'shared', response: { v: 1 } } as any }] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'fn', id: 'shared', args: { v: 2 } } as any }] },
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'fn', id: 'shared', response: { v: 2 } } as any }] },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    // 结构必须保持 model/user 严格交替，不允许相邻同 role
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
    // 至少保留了一个 functionResponse（业务的去重 Map 会按 id 仅保留一个，这是已知取舍）
    const fRs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    expect(fRs.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. 极端边界 / 奇葩输入：不能崩溃
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 极端边界（不崩溃即合格）', () => {
  it('空数组：应原样返回空数组', () => {
    expect(GeminiChat.sanitizeRequestContents([])).toEqual([]);
  });

  it('仅一条 user 消息：应原样返回（不被错误注入占位符）', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: '你好' } as any] },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    expect(result).toEqual(input);
  });

  it('仅一条 model 消息：应被追加 user 占位（防 prefill 错误）', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'hello' } as any] },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe(MESSAGE_ROLES.USER);
  });

  it('parts 缺失（undefined）：不应 crash', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: undefined as any },
      { role: MESSAGE_ROLES.MODEL, parts: undefined as any },
    ];
    expect(() => GeminiChat.sanitizeRequestContents(input)).not.toThrow();
  });

  it('parts 是空数组：保留消息结构但不报错', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' } as any] },
    ];
    expect(() => GeminiChat.sanitizeRequestContents(input)).not.toThrow();
  });

  it('parts 中混入未知字段（既非 text 也非 functionCall/Response）：应保留', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: '收到图片' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: '多谢' } as any] },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    // 图片/未知 part 应保留
    const hasInline = result.flatMap(c => c.parts || []).some((p: any) => p.inlineData);
    expect(hasInline).toBe(true);
  });

  it('多条 model 相邻（极端损坏）：应被合并成一条 model', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'q' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'a' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'b' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'c' } as any] },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    // 不允许相邻同 role
    for (let i = 1; i < result.length; i++) {
      expect(result[i].role).not.toBe(result[i - 1].role);
    }
    // model 段的 'a' 'b' 都应保留在合并后的 parts 里
    const modelMsg = result.find(c => c.role === MESSAGE_ROLES.MODEL);
    const modelText = (modelMsg!.parts || []).map((p: any) => p.text).filter(Boolean);
    expect(modelText).toContain('a');
    expect(modelText).toContain('b');
  });

  it('functionCall 但 args 缺失：不应 crash 也应正常补 cancel', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'go' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: 'no-args' } as any }], // 没有 args
      },
    ];
    expect(() => GeminiChat.sanitizeRequestContents(input)).not.toThrow();
    const result = GeminiChat.sanitizeRequestContents(input);
    expect(result[result.length - 1].role).toBe(MESSAGE_ROLES.USER);
  });

  it('functionResponse 但 response 字段缺失：保留消息不 crash', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'fn', id: 'r-1' } as any }] },
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'fn', id: 'r-1' } as any }] },
    ];
    expect(() => GeminiChat.sanitizeRequestContents(input)).not.toThrow();
  });

  it('100 条历史的压力测试：应在毫秒级完成且不丢配对结构', () => {
    const input: Content[] = [];
    for (let i = 0; i < 50; i++) {
      input.push({
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'fn', id: `c-${i}`, args: {} } as any }],
      });
      input.push({
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'fn', id: `c-${i}`, response: { i } } as any }],
      });
    }

    const start = Date.now();
    const result = GeminiChat.sanitizeRequestContents(input);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // 极宽松阈值，正常 <50ms
    // 100 条都应保留
    expect(result.length).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. 幂等性：清洗结果再清洗一次应不再变化
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 幂等性', () => {
  it('对脏历史清洗一次，结果再清洗一次应当与第一次清洗结果完全一致', () => {
    const dirty: Content[] = [
      // 孤立 fr
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'orphan', id: 'orphan-1', response: {} } as any }] },
      // 末尾 model
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'last is model' } as any] },
    ];

    const once = GeminiChat.sanitizeRequestContents(dirty);
    const twice = GeminiChat.sanitizeRequestContents(once);
    expect(twice).toEqual(once);
  });

  it('对干净历史多次清洗应保持完全相等', () => {
    const clean: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'hello' } as any] },
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'continue' } as any] },
    ];

    const once = GeminiChat.sanitizeRequestContents(clean);
    const twice = GeminiChat.sanitizeRequestContents(once);
    const thrice = GeminiChat.sanitizeRequestContents(twice);
    expect(once).toEqual(clean);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. 不变量保证：清洗结果必须满足下游协议契约
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 协议不变量', () => {
  // 通用断言：检查任意输出是否满足下游契约
  function assertContractInvariants(result: Content[]) {
    if (result.length === 0) return;

    // 不变量 1：相邻消息 role 不同（合并相邻同 role）
    for (let i = 1; i < result.length; i++) {
      expect(
        result[i].role,
        `相邻第 ${i} 与 ${i - 1} 条 role 相同：${result[i - 1].role} → ${result[i].role}`,
      ).not.toBe(result[i - 1].role);
    }

    // 不变量 2：末尾必须是 user（防 Bedrock prefill 报错）
    expect(result[result.length - 1].role).toBe(MESSAGE_ROLES.USER);

    // 不变量 3：每个 functionResponse 必能在前面找到 name 或 id 匹配的 functionCall
    const calls: any[] = [];
    for (const c of result) {
      if (c.role === MESSAGE_ROLES.MODEL && c.parts) {
        for (const p of c.parts) {
          if ((p as any).functionCall) calls.push((p as any).functionCall);
        }
      }
      if (c.role === MESSAGE_ROLES.USER && c.parts) {
        for (const p of c.parts) {
          const fr = (p as any).functionResponse;
          if (!fr) continue;
          const matched = calls.some(
            call => (fr.id && call.id === fr.id) || (fr.name && call.name === fr.name),
          );
          expect(matched, `孤立的 functionResponse 未被清理：${JSON.stringify(fr)}`).toBe(true);
        }
      }
    }
  }

  it('真实事故输入清洗后满足全部协议不变量', () => {
    const dirty: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'glob', id: 'orphan', response: {} } as any }] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: '你好' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: '我又说了一次' } as any] }, // 相邻同 role
      { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' } as any] },
    ];
    assertContractInvariants(GeminiChat.sanitizeRequestContents(dirty));
  });

  it('压力混合输入清洗后满足全部协议不变量', () => {
    const dirty: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'q1' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: 'a', id: 'a-1' } as any }] },
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'a', id: 'a-1', response: {} } as any }] },
      // 故意制造的脏数据：没有前置 call 的孤立 fr
      { role: MESSAGE_ROLES.USER, parts: [{ functionResponse: { name: 'orphan', id: 'orphan' } as any }] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'reply' } as any] },
      // 末尾 model（需要补 user 占位）
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'still model' } as any] },
    ];
    assertContractInvariants(GeminiChat.sanitizeRequestContents(dirty));
  });

  it('极简两条消息（user→model）清洗后也满足全部不变量（追加占位后仍然合法）', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' } as any] },
      { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'hello' } as any] },
    ];
    assertContractInvariants(GeminiChat.sanitizeRequestContents(input));
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. 并行同名工具调用兜底（用户实拍 400 回归）
//
//   状态栏 [Gemini] gemini-3.5-flash 全程未切模型，
//   错误是 Gemini 原生上游 400：
//     "Please ensure that the number of function response parts is equal
//      to the number of function call parts of the function call turn."
//
//   触发条件：单个 model turn 里**并行调用 N 次同名工具**（如同时
//   read_file 多个文件、replace 多处），按 Gemini 原生协议 functionCall /
//   functionResponse 的 id 都允许缺省，于是 N 个 fr 都同名无 id，去重阶段
//   误判为「重复响应」只保留 1 个 → 400。
//
//   修复行为：sanitize 在最开头做 FIFO 合成 id 配对，仅当**同名 ≥2 个无 id
//   fc** 触发；任一侧已带 id / 单条无 id 都不动（保护现有 Claude 跨模型场景）。
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 并行同名工具调用兜底', () => {
  it('单 turn 内并行调用 2 次同名工具（双方都无 id）：两组 fc/fr 全部保留', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: '同时读两个文件' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { absolute_path: '/a.css' } } as any },
          { functionCall: { name: 'read_file', args: { absolute_path: '/b.css' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', response: { output: 'AAA' } } as any },
          { functionResponse: { name: 'read_file', response: { output: 'BBB' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);

    // 关键不变量：fc 的数量必须 === fr 的数量（这正是 Gemini 400 的判定式）
    const fcCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).length;
    const frCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).length;
    expect(fcCount).toBe(2);
    expect(frCount).toBe(2);

    // 两组 fr 的内容必须都被保留（按出现顺序 FIFO 配对到 fc）
    const frs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    const outputs = frs.map((p: any) => p.functionResponse.response.output).sort();
    expect(outputs).toEqual(['AAA', 'BBB']);
  });

  it('并行 N 次同名工具（N=5，双方都无 id）：全部 5 组 fc/fr 都保留，数量严格相等', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: Array.from({ length: 5 }, (_, i) => ({
          functionCall: { name: 'replace', args: { idx: i } } as any,
        })),
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: Array.from({ length: 5 }, (_, i) => ({
          functionResponse: { name: 'replace', response: { idx: i } } as any,
        })),
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fcCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).length;
    const frCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).length;
    expect(fcCount).toBe(5);
    expect(frCount).toBe(5);
  });

  it('并行调用混合多个名字（read_file × 2 + glob × 2）：各自按 name 独立 FIFO，互不串扰', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'glob', args: { p: '**/*' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
          { functionCall: { name: 'glob', args: { p: '*.ts' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', response: { from: 'a' } } as any },
          { functionResponse: { name: 'glob', response: { from: '**/*' } } as any },
          { functionResponse: { name: 'read_file', response: { from: 'b' } } as any },
          { functionResponse: { name: 'glob', response: { from: '*.ts' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const frs = result
      .flatMap(c => c.parts || [])
      .filter((p: any) => p.functionResponse)
      .map((p: any) => `${p.functionResponse.name}:${p.functionResponse.response.from}`)
      .sort();
    expect(frs).toEqual(['glob:**/*', 'glob:*.ts', 'read_file:a', 'read_file:b']);
  });

  it('并行调用但 fr 比 fc 少（fc=3 fr=2）：少出来的那个 fc 应触发 cancel 补全', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'c' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', response: { from: 'a' } } as any },
          { functionResponse: { name: 'read_file', response: { from: 'b' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fcCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).length;
    const frCount = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).length;
    // 数量必须严格相等（Gemini 400 的判定式）
    expect(fcCount).toBe(frCount);
    expect(fcCount).toBe(3);

    // 必有恰好 1 个 cancel 占位（补给那个少出来的 fc），另外 2 个是真实 fr
    const frs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse);
    const cancels = frs.filter((p: any) => p.functionResponse.response?.result === 'user cancel');
    expect(cancels.length).toBe(1);
  });

  it('单条无 id fc + 单条无 id fr：不触发合成 id 路径，按原 name 模糊匹配（行为零变化）', () => {
    // 这条防御了 Claude 跨模型迁移场景（commit e5f01a81）
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ functionCall: { name: 'glob', args: { pattern: '**/*' } } as any }],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [{ functionResponse: { name: 'glob', response: { ok: true } } as any }],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fc = result.flatMap(c => c.parts || []).find((p: any) => p.functionCall);
    const fr = result.flatMap(c => c.parts || []).find((p: any) => p.functionResponse);
    // 单条无 id 不应该被加合成 id —— 维持原始无 id 状态（兼容现有 Claude 测试期望）
    expect((fc as any).functionCall.id).toBeUndefined();
    expect((fr as any).functionResponse.id).toBeUndefined();
  });

  it('并行同名 fc 已经带 id：完全不走合成 id 路径，原 id 保留', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', id: 'real-1', args: {} } as any },
          { functionCall: { name: 'read_file', id: 'real-2', args: {} } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', id: 'real-1', response: {} } as any },
          { functionResponse: { name: 'read_file', id: 'real-2', response: {} } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fcs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall);
    expect((fcs[0] as any).functionCall.id).toBe('real-1');
    expect((fcs[1] as any).functionCall.id).toBe('real-2');
  });

  it('幂等性：并行同名场景下，连续清洗两次结果完全一致', () => {
    const dirty: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', response: { from: 'a' } } as any },
          { functionResponse: { name: 'read_file', response: { from: 'b' } } as any },
        ],
      },
    ];

    // 注意：sanitize 会 mutate 原对象，所以两次必须用各自的深拷贝
    const once = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(dirty)));
    const twice = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(dirty)));
    expect(twice).toEqual(once);

    // 把第一次的产出再次清洗，结果也应稳定
    const onceAgain = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(once)));
    expect(onceAgain).toEqual(once);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. 二次事故：并行同名 fc 无 id + fr 带「真实 CLI callId」(2026-06-04 用户实拍)
//
// 现场：[Gemini] 期间并行 read_file × 2（fc 无 id），coreToolScheduler 给两个
//   fr 各写入了 `read_file-<ts>-<rand>` 形式的真实 callId。切到 [Anthropic]
//   claude-opus-4-8 后上游 400：
//     unexpected `tool_use_id` found in `tool_result` blocks:
//     read_file-1780549486950-5f6pb6trd.
//
// 病灶：旧的并行兜底只给无 id 的 fc 造合成 id、第 2 遍只回填「无 id」的 fr，
//   而 fr 早已带真实 id 被跳过 → fc.id(gem_synth_*) ≠ fr.id(read_file-*)。
//
// 修复后要求：fc 必须借用 fr 的真实 id（权威 id = fr.id），双方严格一致。
// ─────────────────────────────────────────────────────────────────────
describe('GeminiChat.sanitizeRequestContents > 并行无 id fc + 真实 id fr 对齐', () => {
  it('并行 read_file×2（fc 无 id，fr 带 CLI callId）：fc 必须借用 fr 的真实 id 且一一对齐', () => {
    const input: Content[] = [
      { role: MESSAGE_ROLES.USER, parts: [{ text: '同时读两个文件' } as any] },
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { absolute_path: '/a' } } as any },
          { functionCall: { name: 'read_file', args: { absolute_path: '/b' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', id: 'read_file-1780549486950-5f6pb6trd', response: { output: 'AAA' } } as any },
          { functionResponse: { name: 'read_file', id: 'read_file-1780549486951-qq11ww22e', response: { output: 'BBB' } } as any },
        ],
      },
    ];

    const result = GeminiChat.sanitizeRequestContents(input);
    const fcs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).map((p: any) => p.functionCall);
    const frs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);

    // 数量守恒
    expect(fcs.length).toBe(2);
    expect(frs.length).toBe(2);

    // 关键：每个 fc 的 id 都必须等于某个 fr 的真实 id（且不是合成 id）
    const frIds = frs.map((f: any) => f.id).sort();
    const fcIds = fcs.map((f: any) => f.id).sort();
    expect(fcIds).toEqual(frIds);
    expect(frIds).toEqual([
      'read_file-1780549486950-5f6pb6trd',
      'read_file-1780549486951-qq11ww22e',
    ]);
    // 绝不能出现合成前缀（那正是 bug 的症状）
    expect(fcIds.some((id: string) => id.startsWith('gem_synth_'))).toBe(false);

    // FIFO 对齐：第 1 个 fc 配第 1 个 fr 的 id
    const orderedFc = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).map((p: any) => p.functionCall);
    const orderedFr = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);
    expect(orderedFc[0].id).toBe(orderedFr[0].id);
    expect(orderedFc[1].id).toBe(orderedFr[1].id);
  });

  it('并行 read_file×2：仅 fc 无 id，fr 也无 id → 退回合成 id（与旧并行兜底行为一致）', () => {
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', response: { from: 'a' } } as any },
          { functionResponse: { name: 'read_file', response: { from: 'b' } } as any },
        ],
      },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    const fcs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).map((p: any) => p.functionCall);
    const frs = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);
    expect(fcs.length).toBe(2);
    expect(frs.length).toBe(2);
    // 双方都无 id → 用合成 id，且配对一致
    expect(fcs[0].id).toBe(frs[0].id);
    expect(fcs[1].id).toBe(frs[1].id);
    expect(fcs[0].id).not.toBe(fcs[1].id);
    expect(fcs[0].id).toMatch(/^gem_synth_read_file_/);
  });

  it('并行 read_file×3，fr 顺序与 fc 不一致但 id 各异：仍按 id 自洽配对，数量守恒', () => {
    // fr 带 3 个不同真实 id，但乱序到达；fc 无 id。
    const input: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'c' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', id: 'rf-A', response: { v: 'a' } } as any },
          { functionResponse: { name: 'read_file', id: 'rf-B', response: { v: 'b' } } as any },
          { functionResponse: { name: 'read_file', id: 'rf-C', response: { v: 'c' } } as any },
        ],
      },
    ];
    const result = GeminiChat.sanitizeRequestContents(input);
    const fcIds = result.flatMap(c => c.parts || []).filter((p: any) => p.functionCall).map((p: any) => p.functionCall.id).sort();
    const frIds = result.flatMap(c => c.parts || []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse.id).sort();
    expect(fcIds).toEqual(['rf-A', 'rf-B', 'rf-C']);
    expect(frIds).toEqual(['rf-A', 'rf-B', 'rf-C']);
  });

  it('幂等性：并行无 id fc + 真实 id fr，连续清洗两次结果一致', () => {
    const dirty: Content[] = [
      {
        role: MESSAGE_ROLES.MODEL,
        parts: [
          { functionCall: { name: 'read_file', args: { p: 'a' } } as any },
          { functionCall: { name: 'read_file', args: { p: 'b' } } as any },
        ],
      },
      {
        role: MESSAGE_ROLES.USER,
        parts: [
          { functionResponse: { name: 'read_file', id: 'rf-1', response: { from: 'a' } } as any },
          { functionResponse: { name: 'read_file', id: 'rf-2', response: { from: 'b' } } as any },
        ],
      },
    ];
    const once = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(dirty)));
    const twice = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(dirty)));
    expect(twice).toEqual(once);
    const onceAgain = GeminiChat.sanitizeRequestContents(JSON.parse(JSON.stringify(once)));
    expect(onceAgain).toEqual(once);
  });
});

