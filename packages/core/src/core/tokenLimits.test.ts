/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tokenLimit } from './tokenLimits.js';
import type { Config } from '../config/config.js';
import type { CustomModelConfig } from '../types/customModel.js';

/**
 * 守护「自定义模型 context window 解析」这条新加的路径。
 *
 * 这次改动之前 tokenLimit 只看 cloudModels，自定义模型一律落到 auto 兜底
 * （200K）—— 而 EasyClaw 拿到的 Claude Sonnet 4 实际是 1M 上下文，被当成
 * 200K 处理就会在 ~160K 触发压缩，丢 840K 可用上下文。
 *
 * 这套测试只覆盖**新增的自定义模型路径** + **新旧路径的优先级**，
 * 不重复测试 auto / cloudModels 的旧行为（那些不是本次改动的范围）。
 *
 * Mock 策略：只 mock Config 上 tokenLimit 实际调用的两个方法
 * （getCustomModelConfig + getCloudModelInfo），不实例化整个 Config 类。
 */

interface MockConfigOptions {
  customModels?: Record<string, Partial<CustomModelConfig>>;
  cloudModels?: Record<string, number>;
}

function makeConfig(options: MockConfigOptions = {}): Config {
  const { customModels = {}, cloudModels = {} } = options;
  return {
    getCustomModelConfig: (modelId: string) => {
      const partial = customModels[modelId];
      return partial ? (partial as CustomModelConfig) : undefined;
    },
    getCloudModelInfo: (modelName: string) => {
      const maxToken = cloudModels[modelName];
      if (maxToken === undefined) return undefined;
      return { name: modelName, maxToken } as Parameters<Config['setCloudModels']>[0][number];
    },
  } as unknown as Config;
}

describe('tokenLimit — custom model resolution', () => {
  // -------------------------------------------------------------------------
  // 主路径：自定义模型 + 命中 customModelConfig.maxTokens
  // -------------------------------------------------------------------------
  describe('custom model with maxTokens', () => {
    it('reads CustomModelConfig.maxTokens (EasyClaw 1M case)', () => {
      // 实战场景：EasyRouter 加的 Claude Sonnet 4，
      // EasyClaw metadata.max_context_length = 1_000_000 自动填进 maxTokens。
      // 必须吃到 1M，否则压缩在 ~160K 就触发，丢 840K 上下文。
      const config = makeConfig({
        customModels: {
          'custom:anthropic:claude-sonnet-4@abc123': { maxTokens: 1_000_000 },
        },
      });
      expect(tokenLimit('custom:anthropic:claude-sonnet-4@abc123', config)).toBe(1_000_000);
    });

    it('supports legacy displayName format (custom:{displayName})', () => {
      // getCustomModelConfig 内部已处理新旧格式兼容，tokenLimit 不需要关心。
      const config = makeConfig({
        customModels: {
          'custom:my-claude': { maxTokens: 200_000 },
        },
      });
      expect(tokenLimit('custom:my-claude', config)).toBe(200_000);
    });
  });

  // -------------------------------------------------------------------------
  // 兜底：自定义模型缺 maxTokens / 非法值 → 200K (CUSTOM_MODEL_FALLBACK)
  // -------------------------------------------------------------------------
  describe('custom model fallback when maxTokens missing/invalid', () => {
    it('falls back to 200K when maxTokens is undefined', () => {
      // manual wizard 路径 maxTokens 是可选的，用户可能漏填。
      // 200K 比之前若干 provider 默认的 4K/8K 安全得多。
      const config = makeConfig({
        customModels: {
          'custom:openai:gpt-4@xyz': { /* no maxTokens */ },
        },
      });
      expect(tokenLimit('custom:openai:gpt-4@xyz', config)).toBe(200_000);
    });

    it('falls back to 200K when maxTokens is 0', () => {
      const config = makeConfig({
        customModels: {
          'custom:foo:bar@hash': { maxTokens: 0 },
        },
      });
      expect(tokenLimit('custom:foo:bar@hash', config)).toBe(200_000);
    });

    it('falls back to 200K when maxTokens is negative', () => {
      const config = makeConfig({
        customModels: {
          'custom:foo:bar@hash': { maxTokens: -100 },
        },
      });
      expect(tokenLimit('custom:foo:bar@hash', config)).toBe(200_000);
    });

    it('falls back to 200K when custom: id has no matching config', () => {
      // 配置文件被外部改过 / 模型被禁用 → getCustomModelConfig 返回 undefined。
      // 不能借机回去查 cloudModels，那条路径对自定义模型语义不对。
      const config = makeConfig({
        customModels: {
          'custom:other:model@hash': { maxTokens: 500_000 },
        },
      });
      expect(tokenLimit('custom:foo:bar@notfound', config)).toBe(200_000);
    });
  });

  // -------------------------------------------------------------------------
  // 优先级回归 — custom 路径必须优先于 cloud 路径
  // -------------------------------------------------------------------------
  describe('priority: custom path takes precedence', () => {
    it('custom: prefixed id never consults cloudModels', () => {
      // 关键回归：避免曾经的 bug —— 自定义模型 id 跑去 cloudModels 找，
      // 永远找不到 → 落到 200K 兜底，而真正的 customModels.maxTokens 被忽略。
      // 这里同名注册一个 cloud 条目（不应被命中）。
      const config = makeConfig({
        customModels: {
          'custom:anthropic:claude@hash': { maxTokens: 1_000_000 },
        },
        cloudModels: {
          'custom:anthropic:claude@hash': 50_000,
        },
      });
      expect(tokenLimit('custom:anthropic:claude@hash', config)).toBe(1_000_000);
    });

    it('non-custom id never consults customModels', () => {
      // 反向验证：普通模型 id（没 custom: 前缀）不应该走 customModels 路径。
      const config = makeConfig({
        customModels: {
          // 不带 custom: 前缀的 key 不应该被当成自定义模型
          'gpt-5': { maxTokens: 1_000_000 },
        },
        cloudModels: {
          'gpt-5': 256_000,
        },
      });
      // 必须走 cloud 的 256K，不是 custom 的 1M
      expect(tokenLimit('gpt-5', config)).toBe(256_000);
    });
  });

  // -------------------------------------------------------------------------
  // 实战场景 — 完整断言压缩阈值（修复前 vs 修复后的核心差异）
  // -------------------------------------------------------------------------
  describe('realistic scenario: compression threshold math', () => {
    it('Claude Sonnet 4 (1M) gives compression threshold = 800K under 0.8 ratio', () => {
      const config = makeConfig({
        customModels: {
          'custom:anthropic:claude-sonnet-4-20250514@hash': {
            maxTokens: 1_000_000,
            maxOutputTokens: 32_000, // 不影响 tokenLimit
          },
        },
      });
      const limit = tokenLimit('custom:anthropic:claude-sonnet-4-20250514@hash', config);
      expect(limit).toBe(1_000_000);

      // 修复前：limit 被当成 200K，~160K 就压缩，丢 840K 上下文。
      // 修复后：limit = 1M，~800K 才压缩 — 这是本次改动要守护的核心契约。
      const compressionThreshold = 0.8 * limit;
      expect(compressionThreshold).toBe(800_000);
    });

    it('manual-wizard custom model without maxTokens falls back to 200K (not 4K/8K)', () => {
      // 用户从 manual wizard 加了模型，没填 maxTokens — 这种情况下 200K 兜底
      // 比落到某个 provider 4K/8K 默认安全得多。
      const config = makeConfig({
        customModels: {
          'custom:openai:my-local-llm@hash': {
            maxOutputTokens: 8_192, // 用户填了 output cap 但没填 context window
          },
        },
      });
      expect(tokenLimit('custom:openai:my-local-llm@hash', config)).toBe(200_000);
    });
  });
});
