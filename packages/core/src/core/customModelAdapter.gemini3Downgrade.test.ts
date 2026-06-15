/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 跨模型迁移到 Gemini 3.x 时的「裸 functionCall 降级」回归测试。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 * ─────────────────────────────────────────────────────────────────────────
 * `thoughtSignature` 是 Gemini 服务端签发的不透明加密 token，客户端无法
 * 伪造也无法补签。当用户使用 Opus / GPT / Gemini 2.5 累积了一段历史，再切换
 * 到 Gemini 3.x（thinking on）继续对话时，历史里的 functionCall 必然没有
 * Gemini 3.x 认可的签名，下一次请求会被服务器拒绝：
 *
 *     HTTP 400: Function call is missing a thought_signature in functionCall parts
 *
 * 不能伪造签名，唯一可行的修复是：在 customModelAdapter 出网前，把所有
 * 「裸 functionCall」+「对应 functionResponse」配对改写为 text 摘要 part。
 * 语义信息以散文形式继续提供给模型，`functionCall` 不再出现在 wire body 里，
 * 协议约束自然消失。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 6 个回归场景（命中上一次提交未覆盖的盲区）
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1) Opus → Gemini 3.5：历史里的裸 fc + fr 必须改写为 text 摘要
 *   2) Gemini 2.5 → Gemini 3.5：同样命中降级路径（2.5 不强制签名 → 切 3.x 后裸）
 *   3) 同 Gemini 3.5 全程：functionCall + 签名原样保留（不误伤）
 *   4) 混合 turn 守护：同一 model 消息里既有签名 fc 又有裸 fc，按"无签名"降级
 *   5) 配对降级：裸 fc 对应的 fr 即便晚到（下下一条），也必须一起改写
 *   6) 切到 Gemini 2.5（非 3.x）：整个降级路径不触发，行为与历史一致
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callGeminiNativeModel } from './customModelAdapter.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';

// 公共 helper：抓 fetch body
function makeFetchSpy() {
  let captured: any;
  global.fetch = vi.fn().mockImplementation(async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { role: MESSAGE_ROLES.MODEL, parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
    };
  });
  return () => captured;
}

const gemini35Config = {
  provider: 'gemini' as const,
  modelId: 'gemini-3.5-flash',
  baseUrl: 'https://llm-endpoint.net/v1',
  apiKey: 'sk-test',
  displayName: 'gemini-3.5-flash',
};

const gemini25Config = {
  provider: 'gemini' as const,
  modelId: 'gemini-2.5-flash',
  baseUrl: 'https://llm-endpoint.net/v1',
  apiKey: 'sk-test',
  displayName: 'gemini-2.5-flash',
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

describe('Gemini 3.x naked functionCall downgrade', () => {
  // ───────────────────────────────────────────────────────────────────────
  // Case 1：Opus → Gemini 3.5
  // ───────────────────────────────────────────────────────────────────────
  it('case 1: Opus 历史 + 切 gemini-3.5 → 裸 functionCall 改写为 text 摘要', async () => {
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '帮我看下时间' }] },
        // 模拟 Opus 留下的裸 functionCall（Anthropic 协议根本没这个字段）
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            {
              functionCall: {
                name: 'local_time',
                args: { tz: 'Asia/Shanghai' },
                id: 'toolu_01abc',
              },
            },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            {
              functionResponse: {
                name: 'local_time',
                response: { time: '2026-06-04 09:14' },
                id: 'toolu_01abc',
              },
            },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });

    const body = getBody();
    // wire body 中不应再出现 functionCall / functionResponse part
    const flatJson = JSON.stringify(body.contents);
    expect(flatJson).not.toContain('"functionCall"');
    expect(flatJson).not.toContain('"functionResponse"');

    // 应替换成 text 摘要并保留语义关键字
    expect(flatJson).toContain('[Previous tool call]');
    expect(flatJson).toContain('local_time');
    expect(flatJson).toContain('Asia/Shanghai');
    expect(flatJson).toContain('[Previous tool result]');
    expect(flatJson).toContain('2026-06-04 09:14');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 2：Gemini 2.5 → Gemini 3.5
  // ───────────────────────────────────────────────────────────────────────
  it('case 2: Gemini 2.5 历史 + 切 gemini-3.5 → 裸 fc 同样改写（2.5 也不强制签名）', async () => {
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'list dir' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            // Gemini 2.5 thinking off 时不发 thoughtSignature → 升 3.x 算裸的
            { functionCall: { name: 'list_directory', args: { path: '/tmp' } } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'list_directory', response: { entries: ['a', 'b'] } } },
          ],
        },
      ],
    });
    const body = getBody();
    const flatJson = JSON.stringify(body.contents);
    expect(flatJson).not.toContain('"functionCall"');
    expect(flatJson).not.toContain('"functionResponse"');
    expect(flatJson).toContain('[Previous tool call] list_directory');
    expect(flatJson).toContain('[Previous tool result] list_directory');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 3：同 Gemini 3.5 全程
  // ───────────────────────────────────────────────────────────────────────
  it('case 3: 同 Gemini 3.5 全程，functionCall + thoughtSignature 必须原样保留', async () => {
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '查时间' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            {
              functionCall: { name: 'local_time', args: { tz: 'UTC' }, id: 'fc-1' },
              thoughtSignature: 'sig-from-gemini-3',
            },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            {
              functionResponse: { name: 'local_time', response: { time: '12:00' }, id: 'fc-1' },
            },
          ],
        },
      ],
    });

    const body = getBody();
    // model turn 里 functionCall 应当原样保留并带签名
    const modelTurn = body.contents[1];
    expect(modelTurn.role).toBe(MESSAGE_ROLES.MODEL);
    expect(modelTurn.parts[0]).toEqual({
      functionCall: { name: 'local_time', args: { tz: 'UTC' }, id: 'fc-1' },
      thoughtSignature: 'sig-from-gemini-3',
    });
    // functionResponse 也应保留原样（不被降级）
    expect(body.contents[2].parts[0]).toEqual({
      functionResponse: { name: 'local_time', response: { time: '12:00' }, id: 'fc-1' },
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 4：混合 turn 守护
  // ───────────────────────────────────────────────────────────────────────
  it('case 4: 同一 model turn 里既有签名 fc 又有裸 fc → 各自独立处理', async () => {
    // 期望策略：签名 fc 保留；裸 fc 单独降级为 text。
    // 这是「保守降级」：信息保留最大化，不会一棍子打翻整条 turn。
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'mixed' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            {
              functionCall: { name: 'signed_tool', args: { x: 1 }, id: 'fc-signed' },
              thoughtSignature: 'sig-good',
            },
            // 裸 fc（无签名）
            { functionCall: { name: 'naked_tool', args: { y: 2 }, id: 'fc-naked' } },
          ],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'signed_tool', response: { ok: true }, id: 'fc-signed' } },
            { functionResponse: { name: 'naked_tool', response: { ok: false }, id: 'fc-naked' } },
          ],
        },
      ],
    });

    const body = getBody();
    const modelParts = body.contents[1].parts;

    // 签名的那条仍是 functionCall
    expect(modelParts.find((p: any) => p.functionCall?.name === 'signed_tool')).toEqual({
      functionCall: { name: 'signed_tool', args: { x: 1 }, id: 'fc-signed' },
      thoughtSignature: 'sig-good',
    });
    // 裸的那条变成 text
    const nakedAsText = modelParts.find(
      (p: any) => typeof p.text === 'string' && p.text.includes('[Previous tool call] naked_tool'),
    );
    expect(nakedAsText).toBeTruthy();
    expect(nakedAsText.text).toContain('"y":2');
    // 这条 model turn 不应再含 naked_tool 的 functionCall
    expect(
      modelParts.some((p: any) => p.functionCall?.name === 'naked_tool'),
    ).toBe(false);

    const userParts = body.contents[2].parts;
    // signed_tool 的 fr 保留为 functionResponse
    expect(userParts.find((p: any) => p.functionResponse?.name === 'signed_tool')).toEqual({
      functionResponse: { name: 'signed_tool', response: { ok: true }, id: 'fc-signed' },
    });
    // naked_tool 的 fr 降级为 text
    expect(
      userParts.some((p: any) => p.functionResponse?.name === 'naked_tool'),
    ).toBe(false);
    expect(
      userParts.some(
        (p: any) =>
          typeof p.text === 'string' && p.text.includes('[Previous tool result] naked_tool'),
      ),
    ).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 5：裸 fc 与 fr 跨多条消息配对（压缩残留 / 流被打断）
  // ───────────────────────────────────────────────────────────────────────
  it('case 5: 裸 fc 与 fr 中间隔了若干消息，仍要正确配对降级', async () => {
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'go' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'slow_op', args: { n: 7 }, id: 'fc-slow' } }],
        },
        // 中间塞一条用户的中间消息（罕见但真实出现过）
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'are you done?' }] },
        // fr 终于到达
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'slow_op', response: { result: 42 }, id: 'fc-slow' } },
          ],
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] },
      ],
    });

    const body = getBody();
    const flatJson = JSON.stringify(body.contents);
    expect(flatJson).not.toContain('"functionCall"');
    expect(flatJson).not.toContain('"functionResponse"');
    expect(flatJson).toContain('[Previous tool call] slow_op');
    expect(flatJson).toContain('[Previous tool result] slow_op');
    // 注意：args/response 在摘要 text 里已被 JSON.stringify 一次，外层 toString
    // 又会转义一次，所以匹配转义后的字面量。
    expect(flatJson).toContain('\\"n\\":7');
    expect(flatJson).toContain('\\"result\\":42');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Case 6：切到 Gemini 2.5 不应触发降级
  // ───────────────────────────────────────────────────────────────────────
  it('case 6: 目标是 gemini-2.5（非 3.x），裸 fc 必须按原协议透传', async () => {
    const getBody = makeFetchSpy();
    await callGeminiNativeModel(gemini25Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'hi' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'foo', args: { a: 1 } } }],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'foo', response: { ok: true } } }],
        },
      ],
    });

    const body = getBody();
    // gemini-2.5 不强制签名 → 协议照原样传递
    expect(body.contents[1].parts[0]).toEqual({
      functionCall: { name: 'foo', args: { a: 1 } },
    });
    expect(body.contents[2].parts[0]).toEqual({
      functionResponse: { name: 'foo', response: { ok: true } },
    });
    // 不应出现降级摘要
    const flatJson = JSON.stringify(body.contents);
    expect(flatJson).not.toContain('[Previous tool call]');
    expect(flatJson).not.toContain('[Previous tool result]');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 额外 sanity：fr 体积过大时摘要会截断而不是炸上下文
  // ───────────────────────────────────────────────────────────────────────
  it('sanity: 巨大 fr response 在摘要中被截断到合理长度', async () => {
    const getBody = makeFetchSpy();
    const huge = 'x'.repeat(5000);
    await callGeminiNativeModel(gemini35Config as any, {
      contents: [
        { role: MESSAGE_ROLES.USER, parts: [{ text: 'go' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'big_op', args: {} } }],
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'big_op', response: { blob: huge } } }],
        },
      ],
    });

    const body = getBody();
    const flatJson = JSON.stringify(body.contents);
    expect(flatJson).toContain('truncated');
    // 没有 functionResponse 字段名残留
    expect(flatJson).not.toContain('"functionResponse"');
  });
});
