/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 跨模型迁移到 Anthropic（Claude）时的 tool_use / tool_result id 配对回归测试。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 * ─────────────────────────────────────────────────────────────────────────
 * Claude / Bedrock 严格校验：每个 `tool_result.tool_use_id` 必须能在前文找到
 * 一个完全相同 id 的 `tool_use` 块，否则直接 400：
 *
 *   ValidationException: ***.***.content.0: unexpected `tool_use_id` found in
 *   `tool_result` blocks: toolu_<name>. Each `tool_result` block must have a
 *   corresponding `tool_use` block in the previous message.
 *
 * 旧 AnthropicConverter.contentsToAnthropic 在 functionCall.id / functionResponse.id
 * 缺失时各自走不同 fallback：
 *
 *   - tool_use.id           ← `toolu_${Date.now()}_${rand}`（调用即变）
 *   - tool_result.tool_use_id ← `toolu_${name}`（按名稳定）
 *
 * 两个 fallback 永远不可能撞上，对从 Gemini 切回 Claude 的所有用户都会触发 400。
 *
 * 修复：在 contentsToAnthropic 入口做一次预扫描，给所有「无 id」的 fc 分配
 * 稳定的合成 id，并按 name 维护 FIFO 队列；再走第二遍把无 id 的 fr 与同名
 * 队列头配对。这样 fc / fr 必然得到完全相同的 id。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 6 个回归场景
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1) Gemini → Claude 单次工具调用：fc / fr 都没 id → 必须配对成同一 id
 *   2) 同名工具被连续调用两次：FIFO 配对，不能错位
 *   3) 多种不同工具混在一次 model turn 里：每个 fc / fr 独立配对
 *   4) 原始 id 已经存在 → 完全不动（零行为变化）
 *   5) 部分有 id 部分没 id 混合：只补缺失的，不影响已有的
 *   6) 用户报错复现：todo_write 跨模型回切场景，wire body 里 id 必须强一致
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callAnthropicModel } from './customModelAdapter.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';

// 公共 helper：抓 fetch body
function makeFetchSpy() {
  let captured: any;
  global.fetch = vi.fn().mockImplementation(async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  });
  return () => captured;
}

const claudeConfig = {
  provider: 'anthropic' as const,
  modelId: 'claude-opus-4-7',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-test',
  displayName: 'claude-opus-4-7',
};

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy?.mockRestore();
  consoleWarnSpy?.mockRestore();
  vi.restoreAllMocks();
});

/**
 * 工具：从 Anthropic messages 里抽出 tool_use / tool_result 的 id 对，
 * 并断言每个 tool_result.tool_use_id 都能在前文找到对应 tool_use.id。
 */
function collectToolPairs(messages: any[]) {
  const toolUses: Array<{ id: string; name: string }> = [];
  const toolResults: Array<{ tool_use_id: string }> = [];
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const b of blocks) {
      if (b.type === 'tool_use') toolUses.push({ id: b.id, name: b.name });
      if (b.type === 'tool_result') toolResults.push({ tool_use_id: b.tool_use_id });
    }
  }
  return { toolUses, toolResults };
}

function assertEveryResultHasMatchingUse(messages: any[]) {
  const { toolUses, toolResults } = collectToolPairs(messages);
  const ids = new Set(toolUses.map(u => u.id));
  for (const r of toolResults) {
    expect(
      ids.has(r.tool_use_id),
      `tool_result.tool_use_id "${r.tool_use_id}" must match a prior tool_use.id; ` +
        `available tool_use ids: [${[...ids].join(', ')}]`,
    ).toBe(true);
  }
}

describe('Anthropic tool_use/tool_result id pairing (cross-model migration)', () => {
  // ───────────────────────────────────────────────────────────────────────
  // Case 1：Gemini → Claude 单次工具调用，全程无 id
  // ───────────────────────────────────────────────────────────────────────
  it('case 1: 无 id 的单次 fc/fr 必须被分配成同一个合成 id', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '帮我写个 todo' }] },
        // Gemini 留下的 fc 没有 id
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'todo_write', args: { todos: [{ id: '1', content: 'a' }] } } },
          ],
        },
        // 对应 fr 也没有 id
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'todo_write', response: { ok: true } } },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(1);
    expect(toolResults.length).toBe(1);
    // 关键断言：id 完全一致
    expect(toolResults[0].tool_use_id).toBe(toolUses[0].id);
    // 兼容性：合成 id 不应再走旧的 toolu_${name} 分支（那是冲突源头）
    expect(toolResults[0].tool_use_id).not.toBe('todo_write');
    // 必须是稳定的字符串，不要 Date.now / Math.random
    expect(toolResults[0].tool_use_id).toMatch(/^toolu_synth_todo_write_/);
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 2：同名工具被连续调用两次（FIFO）
  // ───────────────────────────────────────────────────────────────────────
  it('case 2: 同名 fc 出现两次 → 按 FIFO 顺序与两个 fr 一一配对', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'list two dirs' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'list_directory', args: { path: '/a' } } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'list_directory', response: { entries: ['x'] } } },
          ],
        },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'list_directory', args: { path: '/b' } } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'list_directory', response: { entries: ['y'] } } },
          ],
        },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(2);
    expect(toolResults.length).toBe(2);
    // 第 1 个 fr 必须配第 1 个 fc，第 2 个 fr 必须配第 2 个 fc
    expect(toolResults[0].tool_use_id).toBe(toolUses[0].id);
    expect(toolResults[1].tool_use_id).toBe(toolUses[1].id);
    // 两条 fc 的 id 不能相同（否则等于配对失败）
    expect(toolUses[0].id).not.toBe(toolUses[1].id);
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 3：多种工具混合
  // ───────────────────────────────────────────────────────────────────────
  it('case 3: 同一 model turn 多种 fc，每个工具按 name 独立配对', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'mixed' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'todo_write', args: { todos: [] } } },
            { functionCall: { name: 'list_directory', args: { path: '/' } } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'todo_write', response: { ok: true } } },
            { functionResponse: { name: 'list_directory', response: { entries: [] } } },
          ],
        },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(2);
    expect(toolResults.length).toBe(2);
    // 按 name 拓扑配对（不是按数组下标）
    const todoUse = toolUses.find(u => u.name === 'todo_write')!;
    const lsUse = toolUses.find(u => u.name === 'list_directory')!;
    expect(todoUse).toBeTruthy();
    expect(lsUse).toBeTruthy();
    // tool_results 数组里只要每个 id 都能在 toolUses 找到对应即可
    const useIds = new Set(toolUses.map(u => u.id));
    for (const r of toolResults) {
      expect(useIds.has(r.tool_use_id)).toBe(true);
    }
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 4：原始 id 存在 → 零行为变化
  // ───────────────────────────────────────────────────────────────────────
  it('case 4: fc/fr 原本就有 id → 完全不动，原 id 透传', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'foo', args: {}, id: 'toolu_original_42' } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'foo', response: {}, id: 'toolu_original_42' } },
          ],
        },
      ],
    });
    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses[0].id).toBe('toolu_original_42');
    expect(toolResults[0].tool_use_id).toBe('toolu_original_42');
    // 不能引入合成前缀
    expect(toolUses[0].id).not.toMatch(/^toolu_synth_/);
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 5：部分有 id 部分无 id（最常见的真实历史脏状态）
  // ───────────────────────────────────────────────────────────────────────
  it('case 5: 部分 fc/fr 有原始 id，部分没有 → 各自独立配对', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'mixed-id' }] },
        // Claude 历史：fc 带 id
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'has_id', args: {}, id: 'toolu_real_1' } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'has_id', response: {}, id: 'toolu_real_1' } },
          ],
        },
        // Gemini 历史：fc / fr 都没 id
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'no_id', args: {} } }],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'no_id', response: {} } }],
        },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    // 两个 fc 各自的 id：一个是原始的，一个是合成的，两者必须不同
    const realPair = toolUses.find(u => u.name === 'has_id')!;
    const synthPair = toolUses.find(u => u.name === 'no_id')!;
    expect(realPair.id).toBe('toolu_real_1');
    expect(synthPair.id).toMatch(/^toolu_synth_no_id_/);
    expect(realPair.id).not.toBe(synthPair.id);
    // 两个 fr 必须各自找到对应的 tool_use
    const realResult = toolResults.find(r => r.tool_use_id === 'toolu_real_1');
    expect(realResult).toBeTruthy();
    const synthResult = toolResults.find(r => r.tool_use_id === synthPair.id);
    expect(synthResult).toBeTruthy();
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 6：用户报错复现 — todo_write 切回 Claude 必须不再 400
  // ───────────────────────────────────────────────────────────────────────
  it('case 6: 用户实际报错复现（toolu_todo_write 冲突）必须修复', async () => {
    const getBody = makeFetchSpy();
    // 这是从截图复现的最小用例：Gemini 期间用了 todo_write，
    // 切回 Claude 时旧实现会让 fc.id="toolu_<rand>" 与 fr.tool_use_id="toolu_todo_write"
    // 错位，触发 ValidationException。
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '规划任务' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            {
              functionCall: {
                name: 'todo_write',
                args: { todos: [{ id: 't1', content: '步骤一', status: 'pending', priority: 'high' }] },
              },
            },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'todo_write', response: { ok: true } } },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '还有什么工具没演示的吗' }] },
      ],
    });

    const body = getBody();
    const flat = JSON.stringify(body.messages);

    // 不能再出现旧 fallback 撞车的字面量
    expect(flat).not.toContain('"tool_use_id":"toolu_todo_write"');

    // 抓出 tool_use 与 tool_result：id 必须完全一致
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].tool_use_id).toBe(toolUses[0].id);
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 7：二次事故复现 — fc 无 id，fr 带「真实 CLI callId」(2026-06-04)
  //
  // 现场：[Gemini] 期间并行 read_file×2（fc 无 id），coreToolScheduler 给两个
  //   fr 各写入 `read_file-<ts>-<rand>` 真实 callId；切到 [Anthropic] 后 400：
  //     unexpected `tool_use_id` found in `tool_result` blocks:
  //     read_file-1780549486950-5f6pb6trd.
  //
  // 旧实现给 fc 造合成 id、跳过「已有 id」的 fr → tool_use.id ≠ tool_result.id。
  // 修复后：fc 必须借用 fr 的真实 id，双方严格一致。
  // ───────────────────────────────────────────────────────────────────────
  it('case 7: 并行 read_file×2，fc 无 id + fr 带真实 callId → fc 借用 fr 的真实 id 配对', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '同时读两个文件' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'read_file', args: { absolute_path: '/a' } } },
            { functionCall: { name: 'read_file', args: { absolute_path: '/b' } } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'read_file', id: 'read_file-1780549486950-5f6pb6trd', response: { output: 'AAA' } } },
            { functionResponse: { name: 'read_file', id: 'read_file-1780549486951-qq11ww22e', response: { output: 'BBB' } } },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(2);
    expect(toolResults.length).toBe(2);

    // 每个 tool_use.id 必须等于真实 CLI callId（绝不是合成前缀）
    const useIds = toolUses.map(u => u.id).sort();
    expect(useIds).toEqual([
      'read_file-1780549486950-5f6pb6trd',
      'read_file-1780549486951-qq11ww22e',
    ]);
    expect(useIds.some(id => id.startsWith('toolu_synth_'))).toBe(false);

    // 报错的字面量绝不能再出现在 wire body 里（无匹配 tool_use）
    const flat = JSON.stringify(body.messages);
    expect(flat).toContain('read_file-1780549486950-5f6pb6trd');
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 8：单次 read_file，fc 无 id + fr 带真实 callId（最常见的单工具场景）
  // ───────────────────────────────────────────────────────────────────────
  it('case 8: 单次 fc 无 id + fr 带真实 callId → tool_use 借用该真实 id', async () => {
    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '读文件' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'read_file', args: { absolute_path: '/x' } } }],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'read_file', id: 'read_file-999-abc', response: { output: 'X' } } }],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });
    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(1);
    expect(toolResults.length).toBe(1);
    expect(toolUses[0].id).toBe('read_file-999-abc');
    expect(toolResults[0].tool_use_id).toBe('read_file-999-abc');
    assertEveryResultHasMatchingUse(body.messages);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 兜底场景：彻底孤立的 fr（没有任何 fc 配对，理论上 sanitize 已过滤）
  // ───────────────────────────────────────────────────────────────────────
  it('sanity: 彻底孤立的 fr 仍然走旧 fallback，不抛异常', async () => {    const getBody = makeFetchSpy();
    await callAnthropicModel(claudeConfig as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'orphan' }] },
        // 故意没有 fc，只来一条 fr（异常历史）
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'lonely', response: { x: 1 } } },
          ],
        },
      ],
    });

    const body = getBody();
    const { toolUses, toolResults } = collectToolPairs(body.messages);
    expect(toolUses.length).toBe(0);
    expect(toolResults.length).toBe(1);
    // 兜底：退回旧 `toolu_${name}` 字面量（行为兼容）
    expect(toolResults[0].tool_use_id).toBe('toolu_lonely');
    // 这里不调用 assertEveryResultHasMatchingUse — 上层 sanitize 会过滤这种情况，
    // 我们只是确保不会抛异常并保持向后兼容。
  });
});
