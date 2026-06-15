/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ⚠️ Token限制配置从云端API获取，支持客户端准确计算
 *
 * 更新说明：使用云端API的maxToken字段获取准确的模型token限制
 *
 * 🎯 解析顺序：
 *   1. 自定义模型（custom: 前缀）→ CustomModelConfig.maxTokens
 *      （EasyClaw 元数据自动填的 max_context_length；用户手填也走这里）
 *   2. 云端模型信息（CloudModelInfo.maxToken，按 name 精确匹配）
 *   3. AUTO_MODE_CONFIG.maxToken — 'auto' / 未知 / 没传 config 的兜底
 *
 * ⚠️ 这个返回值是「触发压缩的分母」（compressionTokenThreshold * tokenLimit），
 * 自定义模型必须吃到 vendor-precise 的 context window，
 * 不能跟着 'auto' 一起回到通用兜底。
 */

import type { Config } from '../config/config.js';
import { isCustomModel } from '../types/customModel.js';

type Model = string;
type TokenCount = number;

// auto模式的默认配置（与CLI中保持一致）
const AUTO_MODE_CONFIG = {
  name: 'auto',
  displayName: 'Auto',
  creditsPerRequest: 6.0,
  available: true,
  maxToken: 200000,
  highVolumeThreshold: 200000,
  highVolumeCredits: 12.0
};

/**
 * 自定义模型缺 maxTokens 时的兜底值。
 *
 * 跟 AUTO_MODE_CONFIG.maxToken 数值一样但语义不同 — 这个 200K 只为
 * 「用户手填路径漏填 maxTokens」服务（EasyRouter 路径会被 EasyClaw 元数据
 * 覆盖，不会落到这里）。选 200K 是因为现代主流模型 context window 都 ≥ 200K，
 * 比 4K/8K 之类的小默认安全得多，避免触发频繁过早压缩。
 */
const CUSTOM_MODEL_FALLBACK_MAX_TOKENS = 200_000;

/**
 * 从Config获取准确的Token限制。
 *
 * ⚠️ 自定义模型 model 字符串形如 `custom:anthropic:claude-sonnet-4@hash`，
 *    cloudModels 里永远没有，必须先走 customModels 匹配，否则 1M 上下文的
 *    Claude Sonnet 4 会被当成 200K 处理，导致 ~160K 就触发压缩丢上下文。
 */
export function tokenLimit(model: Model, config?: Config): TokenCount {
  if (config) {
    // 1. 自定义模型 — 直接读 CustomModelConfig.maxTokens
    if (isCustomModel(model)) {
      const customConfig = config.getCustomModelConfig(model);
      if (customConfig?.maxTokens && customConfig.maxTokens > 0) {
        return customConfig.maxTokens;
      }
      // 自定义模型缺 maxTokens 时兜底 — 不要落到下面的 AUTO_MODE_CONFIG，
      // 那是给 'auto'/未知模型的，跟自定义模型语义不同。
      return CUSTOM_MODEL_FALLBACK_MAX_TOKENS;
    }

    // 2. 云端模型信息
    const cloudModelInfo = config.getCloudModelInfo(model);
    if (cloudModelInfo) {
      return cloudModelInfo.maxToken;
    }
  }

  // 3. 'auto' / 未知模型 / 没传 config — 走原有 auto 配置（保持不动）
  return AUTO_MODE_CONFIG.maxToken;
}
