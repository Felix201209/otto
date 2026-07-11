/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createCoreConfig } from './coreConfig.js';

const PERSONAL_MODEL = {
  displayName: '个人模型',
  provider: 'openai' as const,
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  modelId: 'personal-model',
  enabled: true,
};

describe('createCoreConfig v1.7 模式隔离', () => {
  it('Otto 托管模型不会被本地 BYOK preferred/首模型覆盖', () => {
    const config = createCoreConfig({
      sessionId: 'enterprise-session',
      model: 'otto:deepseek',
      customModels: [PERSONAL_MODEL],
    });

    expect(config.getModel()).toBe('otto:deepseek');
  });

  it('会话 Agent profile 进入 system userRules，个人版可排除企业工具', () => {
    const config = createCoreConfig({
      sessionId: 'profile-session',
      model: 'otto:deepseek',
      customModels: [],
      userRules: '你是会议发起 Agent。',
      excludeTools: ['multi_channel', 'feishu_project_collab'],
    });

    expect(config.getUserRules()).toContain('会议发起 Agent');
    expect(config.getExcludeTools()).toEqual(['multi_channel', 'feishu_project_collab']);
  });
});
