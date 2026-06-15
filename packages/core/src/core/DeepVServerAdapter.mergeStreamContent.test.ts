/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 单元测试：OttoServerAdapter.mergeStreamContent + finalizeAccumulatedToolChunk
 *
 * 这组测试守护一个关键的 bug 修复：
 *
 * 当 SSE 流式响应把一个 functionCall 拆成多个 chunk（先 name、再分批 args、
 * 最后 finishReason），如果客户端把每个 chunk 立即 yield 给 Turn.run()，
 * Turn 会把同一个工具调用 push 成多个残缺的 ToolCallRequest（甚至出现
 * args 缺失或 name 缺失），最终 finishReason=FUNCTION_CALL 但
 * functionCalls=0，工具调用被静默丢弃。
 *
 * 修复方案：在 createStreamGenerator 里累积合并 functionCall chunk，等
 * 流结束才一次性 yield 完整 chunk；mergeStreamContent + finalize 是这套
 * 累积合并的核心。
 */

import { describe, it, expect } from 'vitest';
import { OttoServerAdapter } from './OttoServerAdapter.js';

// 把 prototype 上的私有方法借出来做白盒测试
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = (OttoServerAdapter as any).prototype;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const merge = (acc: any, chunk: any) => proto.mergeStreamContent.call({}, acc, chunk);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const finalize = (chunk: any) => proto.finalizeAccumulatedToolChunk.call({}, chunk);

describe('OttoServerAdapter.mergeStreamContent', () => {
  it('returns deep-cloned chunk on first call (accumulator init)', () => {
    const original = {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'hello' }] },
        },
      ],
    };
    const acc = merge(null, original);
    // 修改 acc 不应该污染 original
    acc.candidates[0].content.parts[0].text = 'mutated';
    expect(original.candidates[0].content.parts[0].text).toBe('hello');
  });

  it('attaches a functionCalls getter that reflects current parts', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'tool_a', args: { x: 1 } } }],
          },
        },
      ],
    });
    expect(acc.functionCalls).toEqual([
      { id: 'c1', name: 'tool_a', args: { x: 1 } },
    ]);
  });

  it('appends text to the last text part to avoid fragmentation', () => {
    let acc = merge(null, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] } }],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] } }],
    });
    expect(acc.candidates[0].content.parts).toHaveLength(1);
    expect(acc.candidates[0].content.parts[0].text).toBe('Hello world');
  });

  it('accumulates string args across chunks (streamed JSON fragments)', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'local_time' } }],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { args: '{"timezo' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: 'ne":"Asia/Shanghai"}' } }],
          },
        },
      ],
    });
    const fc = acc.candidates[0].content.parts[0].functionCall;
    expect(fc.name).toBe('local_time');
    expect(fc.args).toBe('{"timezone":"Asia/Shanghai"}');
  });

  it('shallow-merges object args across chunks', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'tool_x', args: { a: 1 } } }],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: { b: 2 } } }],
          },
        },
      ],
    });
    expect(acc.candidates[0].content.parts[0].functionCall.args).toEqual({ a: 1, b: 2 });
  });

  it('merges finishReason from later chunk into accumulator', () => {
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'tool_x' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
    });
    expect(acc.candidates[0].finishReason).toBe('STOP');
  });

  it('fills missing functionCall.id with a generated id', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'tool_no_id', args: { v: 1 } } }],
          },
        },
      ],
    });
    const fc = acc.candidates[0].content.parts[0].functionCall;
    expect(fc.id).toBeDefined();
    expect(fc.id).toMatch(/^call_/);
  });

  it('handles a chunk that contains both text and functionCall parts', () => {
    const acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { text: "I'll check the time." },
              { functionCall: { id: 'c1', name: 'local_time', args: {} } },
            ],
          },
        },
      ],
    });
    const parts = acc.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("I'll check the time.");
    expect(parts[1].functionCall.name).toBe('local_time');
  });

  it('preserves parallel tool_calls arriving in separate chunks (different ids)', () => {
    // 回归守护：模型并行发出 2 个 task 调用，服务端通常分两个独立 chunk
    // 下发；过去的合并逻辑会无脑 in-place 合并末尾 functionCall，导致第二
    // 个 call 的 id/name 覆盖第一个、args 浅合并，并行调用被静默吞掉。
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'task',
                  args: { prompt: 'analyze A', description: 'A', max_turns: 5 },
                },
              },
            ],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_2',
                  name: 'task',
                  args: { prompt: 'analyze B', description: 'B', max_turns: 5 },
                },
              },
            ],
          },
        },
      ],
    });

    const parts = acc.candidates[0].content.parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].functionCall).toEqual({
      id: 'call_1',
      name: 'task',
      args: { prompt: 'analyze A', description: 'A', max_turns: 5 },
    });
    expect(parts[1].functionCall).toEqual({
      id: 'call_2',
      name: 'task',
      args: { prompt: 'analyze B', description: 'B', max_turns: 5 },
    });

    // turn.ts 看到的 functionCalls 必须是两个完整的并行调用
    expect(acc.functionCalls).toHaveLength(2);
    expect(acc.functionCalls.map((fc: { id: string }) => fc.id)).toEqual([
      'call_1',
      'call_2',
    ]);
  });

  it('still merges continuation chunks that omit id (no false split)', () => {
    // 守护反向情况：同一 call 的 args 续传分片不带 id，必须仍然合并进
    // 末尾 functionCall，而不是误判为并行调用、生成新独立 part。
    let acc = merge(null, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call_1', name: 'task' } }],
          },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: '{"prompt":"hello"}' } }],
          },
        },
      ],
    });

    const parts = acc.candidates[0].content.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall.id).toBe('call_1');
    expect(parts[0].functionCall.args).toBe('{"prompt":"hello"}');
  });
});

describe('OttoServerAdapter.finalizeAccumulatedToolChunk', () => {
  it('parses string args back into object after stream merge', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'c1',
                  name: 'local_time',
                  args: '{"timezone":"Asia/Shanghai"}',
                },
              },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toEqual({
      timezone: 'Asia/Shanghai',
    });
  });

  it('replaces empty/undefined args with empty object', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              { functionCall: { id: 'c1', name: 'local_time', args: '' } },
              { functionCall: { id: 'c2', name: 'tool2', args: undefined } },
              { functionCall: { id: 'c3', name: 'tool3', args: null } },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toEqual({});
    expect(chunk.candidates[0].content.parts[1].functionCall.args).toEqual({});
    expect(chunk.candidates[0].content.parts[2].functionCall.args).toEqual({});
  });

  it('keeps invalid JSON as raw string for downstream error reporting', () => {
    const chunk = {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'c1',
                  name: 'broken_tool',
                  args: '{invalid json',
                },
              },
            ],
          },
        },
      ],
    };
    finalize(chunk);
    // 解析失败时保留原字符串，让 SchemaValidator 能输出更准确的错误
    expect(chunk.candidates[0].content.parts[0].functionCall.args).toBe('{invalid json');
  });

  it('is a no-op for chunks without parts', () => {
    const chunk = { candidates: [{ index: 0 }] };
    expect(() => finalize(chunk)).not.toThrow();
  });
});

describe('mergeStreamContent + finalize end-to-end (streamed local_time call)', () => {
  it('reconstructs a complete functionCall from 5 fragmented chunks', () => {
    let acc: ReturnType<typeof merge> | null = null;

    // chunk 1: 模型先输出文本
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: "Sure, I'll check the time." }] },
        },
      ],
    });

    // chunk 2: functionCall name 出现
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call_1', name: 'local_time' } }],
          },
        },
      ],
    });

    // chunk 3 & 4: args 字符串增量
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ functionCall: { args: '{"timezo' } }] },
        },
      ],
    });
    acc = merge(acc, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ functionCall: { args: 'ne":"Asia/Shanghai"}' } }],
          },
        },
      ],
    });

    // chunk 5: finishReason
    acc = merge(acc, {
      candidates: [
        { index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' },
      ],
    });

    finalize(acc);

    const parts = acc!.candidates[0].content.parts;
    const textPart = parts.find((p: { text?: string }) => p.text);
    const fcPart = parts.find(
      (p: { functionCall?: { name: string; args: unknown } }) => p.functionCall,
    );

    expect(textPart?.text).toBe("Sure, I'll check the time.");
    expect(fcPart?.functionCall?.name).toBe('local_time');
    expect(fcPart?.functionCall?.args).toEqual({ timezone: 'Asia/Shanghai' });
    expect(acc!.candidates[0].finishReason).toBe('STOP');

    // 关键回归断言：经过完整合并后 functionCalls 必须能被 turn.ts 看见
    expect(acc!.functionCalls).toBeDefined();
    expect(acc!.functionCalls).toHaveLength(1);
    expect(acc!.functionCalls[0]).toEqual({
      id: 'call_1',
      name: 'local_time',
      args: { timezone: 'Asia/Shanghai' },
    });
  });
});

describe('OttoServerAdapter.cleanContents', () => {
  // cleanContents 内部会调用 this.removeOrphanedToolResponses，
  // 白盒测试需提供一个挂载了该方法的 this 上下文。
  const ctx = { removeOrphanedToolResponses: proto.removeOrphanedToolResponses };
  const cleanContents = (contents: any[]) => proto.cleanContents.call(ctx, contents);

  it('filters out empty or whitespace-only text parts within a message', () => {
    const input = [
      {
        role: 'user',
        parts: [
          { text: '  ' }, // whitespace-only text part
          { text: 'Hello' },
          { text: '' }, // empty text part
          { inlineData: { mimeType: 'image/png', data: 'abc' } }, // valid image part
        ],
      },
    ];

    const result = cleanContents(input);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts[0].text).toBe('Hello');
    expect(result[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: 'abc' });
  });

  it('completely removes a message if all parts are filtered out as invalid', () => {
    const input = [
      {
        role: 'user',
        parts: [
          { text: '   ' },
          { text: '' },
        ],
      },
      {
        role: 'user',
        parts: [
          { text: 'Keep this' },
        ],
      },
    ];

    const result = cleanContents(input);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].text).toBe('Keep this');
  });
});

/**
 * 单元测试：OttoServerAdapter.removeOrphanedToolResponses
 *
 * 守护生产 bug 修复（用户实拍 easyrouter 400）：
 *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
 *
 * 根因：上下文压缩/历史截断把 functionCall 切掉、却保留了它的 functionResponse，
 *   形成"孤儿 functionResponse"。该孤儿被客户端 sanitizeRequestContents 的
 *   "全局 name 兜底"误判为有配对而存活，发往云端转 OpenAI 格式后变成无前驱
 *   tool_calls 的 role:'tool' 消息 → 严格网关 (easyrouter) 报 400。
 *
 * 修复策略（对 Gemini / Claude / OpenAI 三家均无害）：在发往云端的出口处，
 *   按"真实配对关系 + 计数消耗"删除真孤儿——
 *     - 优先 id 精确配对（消耗，防两个 fr 抢同一个 fc）
 *     - 回退 name 计数配对（N 个同名 fc 最多配 N 个 fr，多出的才删）
 *   合法会话里 fr 数 ≤ 同名 fc 数，计数永远够，不会删任何合法配对。
 */
describe('OttoServerAdapter.removeOrphanedToolResponses', () => {
  const removeOrphans = (contents: any[]) =>
    proto.removeOrphanedToolResponses.call({}, contents);

  it('removes a truly orphaned functionResponse (its functionCall was dropped)', () => {
    // 压缩后场景：只剩下一个 functionResponse，对应的 functionCall 已被截断丢弃
    const input = [
      { role: 'user', parts: [{ text: 'do something' }] },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'read_file-123-abc', name: 'read_file', response: { ok: true } } },
        ],
      },
    ];

    const result = removeOrphans(input);

    // 孤儿 fr 被删除 → 该 user 消息只剩 0 个有效 part → 整条消息移除
    expect(result).toHaveLength(1);
    expect(result[0].parts[0].text).toBe('do something');
  });

  it('keeps a functionResponse that has a matching functionCall by id', () => {
    const input = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.ts' } } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { ok: true } } }],
      },
    ];

    const result = removeOrphans(input);

    expect(result).toHaveLength(2);
    expect(result[1].parts[0].functionResponse.id).toBe('call_1');
  });

  it('keeps a functionResponse matched by name when ids are absent (Gemini native)', () => {
    // Gemini 原生：functionCall 常无 id，functionResponse 靠 name 配对
    const input = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'SH' } } }],
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temp: 20 } } }],
      },
    ];

    const result = removeOrphans(input);

    expect(result).toHaveLength(2);
    expect(result[1].parts[0].functionResponse.name).toBe('get_weather');
  });

  it('does NOT mis-delete parallel same-name calls (N functionCalls ↔ N functionResponses)', () => {
    // 并行同名工具调用：3 个 read_file 全无 id，3 个 fr 也全无 id（或仅 name）
    const input = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
          { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
          { functionCall: { name: 'read_file', args: { path: 'c.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { c: 'A' } } },
          { functionResponse: { name: 'read_file', response: { c: 'B' } } },
          { functionResponse: { name: 'read_file', response: { c: 'C' } } },
        ],
      },
    ];

    const result = removeOrphans(input);

    // 3 个 fr 全部保留（计数 3 配 3）
    expect(result).toHaveLength(2);
    expect(result[1].parts).toHaveLength(3);
    expect(result[1].parts.every((p: any) => p.functionResponse?.name === 'read_file')).toBe(true);
  });

  it('removes only the EXCESS orphan when fr count exceeds same-name fc count', () => {
    // 2 个 fc 但 3 个 fr：保留 2 个、删除 1 个多余孤儿
    const input = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
          { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'read_file', response: { c: 'A' } } },
          { functionResponse: { name: 'read_file', response: { c: 'B' } } },
          { functionResponse: { name: 'read_file', response: { c: 'C' } } },
        ],
      },
    ];

    const result = removeOrphans(input);

    expect(result).toHaveLength(2);
    expect(result[1].parts).toHaveLength(2);
  });

  it('does not consume one functionCall for two functionResponses (id pool exhaustion)', () => {
    // 1 个 fc (id=call_1) 但 2 个 fr 都声称 id=call_1：只保留 1 个，另一个判为孤儿
    const input = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'read_file', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call_1', name: 'read_file', response: { c: 'A' } } },
          { functionResponse: { id: 'call_1', name: 'read_file', response: { c: 'B' } } },
        ],
      },
    ];

    const result = removeOrphans(input);

    expect(result).toHaveLength(2);
    expect(result[1].parts).toHaveLength(1);
  });

  it('leaves contents unchanged when there are no functionResponses', () => {
    const input = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ];

    const result = removeOrphans(input);

    expect(result).toEqual(input);
  });

  it('leaves a fully paired history untouched (idempotent on healthy data)', () => {
    const input = [
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: {} } }] },
      { role: 'model', parts: [{ text: 'answer' }] },
    ];

    const result = removeOrphans(input);

    expect(result).toEqual(input);
  });

  it('preserves non-functionResponse parts in the same message when removing an orphan', () => {
    // 同一条 user 消息里既有孤儿 fr 又有正常文本：只删 fr，保留文本
    const input = [
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'ghost-999', name: 'ghost_tool', response: {} } },
          { text: 'user follow-up text' },
        ],
      },
    ];

    const result = removeOrphans(input);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts[0].text).toBe('user follow-up text');
  });
});
