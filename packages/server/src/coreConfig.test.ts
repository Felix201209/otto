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
  it('内部测试阶段遇到旧 Otto 托管模型 id 时回退个人 BYOK', () => {
    const config = createCoreConfig({
      sessionId: 'enterprise-session',
      model: 'otto:deepseek',
      customModels: [PERSONAL_MODEL],
    });

    expect(config.getModel()).toMatch(/^custom:/);
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

  it('飞书会话把 channel context 注入 core 配置', () => {
    const config = createCoreConfig({
      sessionId: 'feishu-session',
      model: 'otto:deepseek',
      customModels: [],
      feishuMode: true,
    });

    expect(config.getFeishuMode()).toBe(true);
  });
});
