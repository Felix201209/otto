/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * resolveLargeContextCompressionModel 的回归测试。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 背景
 * ─────────────────────────────────────────────────────────────────────────
 * tryCompressChat 与 switchModel 中存在「sessionTokenCount > 900K 时升级
 * 压缩模型」的逻辑。原实现把目标硬编码为 'x-ai/grok-4.1-fast'，这是只在
 * DeepV 云端协议下才能解析的 ID —— 自定义模型直连用户（走 EasyRouter /
 * 自有 endpoint）的 baseUrl/apiKey 不会被云端识别，必然 401/404 静默失败，
 * 触发 vscode-ui 用户反馈的「20% 自动压缩失败」。
 *
 * 修复后逻辑：
 *   - 云端协议用户 → 维持 'x-ai/grok-4.1-fast'（行为零变更）
 *   - 自定义模型用户 → 在 customModels 里找 grok 系或 gemini pro/flash 系
 *     候选；找不到则保留 SceneManager 默认值，让下游 createTemporaryChat
 *     的 isUsingCustomModel 兜底逻辑接手。
 *
 * 不能被打破的不变量：
 *   1) 云端协议用户 → 永远拿到 'x-ai/grok-4.1-fast'
 *   2) 自定义模型用户 → 永远不会拿到 'x-ai/grok-4.1-fast'（避免 401）
 *   3) 自定义模型用户存在 grok 候选时优先 grok（1M+ 上下文最稳）
 *   4) 已禁用（enabled=false）的候选不参与匹配
 *   5) 找不到候选时退化到默认 'gemini-2.5-flash'，永不 throw
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeminiClient } from './client.js';

// 用 Object.create(prototype) 跳过 constructor 的依赖（与 client.setHistory.sanitize.test.ts 同款手法）
function makeBareClient(opts: {
  currentModel: string;
  customModels?: Array<{
    modelId: string;
    displayName?: string;
    enabled?: boolean;
    provider?: string;
    baseUrl?: string;
    apiKey?: string;
  }>;
  customModelConfig?: any;
}): GeminiClient {
  const client = Object.create(GeminiClient.prototype) as GeminiClient;
  const fakeConfig = {
    getModel: vi.fn().mockReturnValue(opts.currentModel),
    getCustomModels: vi.fn().mockReturnValue(opts.customModels || []),
    // isCustomModel(currentModel) 内部需要这个 —— 但 isCustomModel 仅看 modelId 前缀，
    // 不会回头去找 config。下面如果调用 generateCustomModelId 也只用到 modelId/baseUrl 等。
    getCustomModelConfig: vi.fn().mockImplementation((id: string) => {
      const found = (opts.customModels || []).find(m => id.includes(m.modelId));
      return found ? { ...found, provider: found.provider || 'openai' } : undefined;
    }),
  };
  (client as any).config = fakeConfig;
  return client;
}

// 反射调用 private 方法
function call(client: GeminiClient, defaultModel: string | undefined): string {
  return (client as any).resolveLargeContextCompressionModel(defaultModel);
}

describe('GeminiClient.resolveLargeContextCompressionModel', () => {
  // ───────────────────────────────────────────────────────────────────────
  // 不变量 1：云端协议用户 → 永远 grok 云端 ID
  // ───────────────────────────────────────────────────────────────────────
  describe('云端协议用户（非自定义模型）', () => {
    it('当前模型是 gemini-2.5-pro：升级为 x-ai/grok-4.1-fast', () => {
      const c = makeBareClient({ currentModel: 'gemini-2.5-pro' });
      expect(call(c, 'gemini-2.5-flash')).toBe('x-ai/grok-4.1-fast');
    });

    it('当前模型是 claude-sonnet-4@20250514：仍走云端 grok（行为零变更）', () => {
      const c = makeBareClient({ currentModel: 'claude-sonnet-4@20250514' });
      expect(call(c, 'gemini-2.5-flash')).toBe('x-ai/grok-4.1-fast');
    });

    it('default model 是 undefined 也应走云端分支不报错', () => {
      const c = makeBareClient({ currentModel: 'gemini-2.5-pro' });
      expect(call(c, undefined)).toBe('x-ai/grok-4.1-fast');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 不变量 2 + 3：自定义模型用户 → 不能拿到云端 grok ID；优先匹配 grok 系
  // ───────────────────────────────────────────────────────────────────────
  describe('自定义模型用户：grok 候选优先', () => {
    it('customModels 里有 grok-4-fast 候选 → 升级为该自定义 grok', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus-via-bedrock',
        customModels: [
          { modelId: 'grok-4-fast', displayName: 'Grok 4 Fast', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
          { modelId: 'gemini-2.5-flash', displayName: 'Gemini Flash', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      // 关键不变量：绝不能是云端 ID
      expect(result).not.toBe('x-ai/grok-4.1-fast');
      // 应当是一个指向自定义 grok 的 ID
      expect(result.toLowerCase()).toContain('grok');
    });

    it('customModels 里 displayName 含 Grok（modelId 是非 grok 字面量）也能匹配', () => {
      const c = makeBareClient({
        currentModel: 'custom:foo',
        customModels: [
          { modelId: 'xai/grok-fast', displayName: 'My Grok Fast', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      expect(result).not.toBe('x-ai/grok-4.1-fast');
      expect(result.toLowerCase()).toContain('grok');
    });
  });

  describe('自定义模型用户：无 grok 时落 gemini pro/flash', () => {
    it('只有 gemini pro 候选 → 升级为该自定义 gemini pro', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [
          { modelId: 'gemini-2.5-pro', displayName: 'Gemini Pro', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      expect(result).not.toBe('x-ai/grok-4.1-fast');
      expect(result.toLowerCase()).toContain('gemini');
    });

    it('只有 gemini flash 候选（且不含 grok）→ 也算大上下文匹配', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [
          { modelId: 'gemini-1.5-flash', displayName: 'Flash', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      expect(result).not.toBe('x-ai/grok-4.1-fast');
      expect(result.toLowerCase()).toContain('gemini');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 不变量 4：disabled 候选必须忽略
  // ───────────────────────────────────────────────────────────────────────
  describe('已禁用（enabled=false）的候选必须被忽略', () => {
    it('grok 被禁用 + gemini pro 启用 → 落到 gemini pro', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [
          { modelId: 'grok-4', displayName: 'Grok 4', enabled: false, baseUrl: 'https://er.com/v1', apiKey: 'sk' },
          { modelId: 'gemini-2.5-pro', displayName: 'Gemini Pro', enabled: true, baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      expect(result).not.toBe('x-ai/grok-4.1-fast');
      expect(result.toLowerCase()).toContain('gemini');
      expect(result.toLowerCase()).not.toContain('grok');
    });

    it('所有候选都禁用 → 退回默认值', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [
          { modelId: 'grok-4', enabled: false, baseUrl: 'https://er.com/v1', apiKey: 'sk' },
          { modelId: 'gemini-2.5-pro', enabled: false, baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      expect(call(c, 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 不变量 5：找不到候选 → 永不 throw，永不返回云端 ID
  // ───────────────────────────────────────────────────────────────────────
  describe('找不到候选时的退化行为', () => {
    it('customModels 完全为空 → 退回默认 gemini-2.5-flash（绝不返回云端 grok ID）', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [],
      });
      expect(call(c, 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    });

    it('customModels 都是无关模型（claude-sonnet）→ 退回默认值', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [
          { modelId: 'claude-sonnet-4', displayName: 'Claude', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
          { modelId: 'mistral-large', displayName: 'Mistral', baseUrl: 'https://er.com/v1', apiKey: 'sk' },
        ],
      });
      const result = call(c, 'gemini-2.5-flash');
      expect(result).toBe('gemini-2.5-flash');
      expect(result).not.toBe('x-ai/grok-4.1-fast');
    });

    it('default 是 undefined 时退化为 gemini-2.5-flash 而不是 undefined/throw', () => {
      const c = makeBareClient({
        currentModel: 'custom:opus',
        customModels: [],
      });
      expect(call(c, undefined)).toBe('gemini-2.5-flash');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // sanity：getCustomModels 返回 null/undefined 时不能崩
  // ───────────────────────────────────────────────────────────────────────
  it('config.getCustomModels 返回 undefined 时不会崩', () => {
    const client = Object.create(GeminiClient.prototype) as GeminiClient;
    (client as any).config = {
      getModel: () => 'custom:opus',
      getCustomModels: () => undefined,
      getCustomModelConfig: () => undefined,
    };
    expect(call(client, 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});
