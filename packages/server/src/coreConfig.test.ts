/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createCoreConfig } from './coreConfig.js';
import { ApprovalMode } from 'otto-core';

const PERSONAL_MODEL = {
  displayName: '个人模型',
  provider: 'openai' as const,
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  modelId: 'personal-model',
  enabled: true,
};

describe('createCoreConfig v1.7 模式隔离', () => {
  it('服务端默认使用安全审批模式，不默认开启 YOLO', () => {
    const config = createCoreConfig({
      sessionId: 'safe-default-session',
      customModels: [],
    });

    expect(config.getApprovalMode()).toBe(ApprovalMode.DEFAULT);
  });

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

  it('tool-free 会话把禁用 MCP 发现下沉到真实 Core Config', () => {
    const config = createCoreConfig({
      sessionId: 'a2a-tool-free',
      customModels: [],
      disableMcpDiscovery: true,
      disableEnvironmentContext: true,
      disableTools: true,
    });

    expect(config.getMcpDiscoveryDisabled()).toBe(true);
    expect(config.getEnvironmentContextDisabled()).toBe(true);
    expect(config.getToolsDisabled()).toBe(true);
  });

  it('把桌面搜索 API 配置装配进 Core，并支持运行时读取', () => {
    const config = createCoreConfig({
      sessionId: 'search-config-session',
      customModels: [],
      searchConfig: {
        provider: 'volcengine',
        apiKey: 'ark-key',
        apiUrl: 'https://ark.example.com/api/v3/responses',
        model: 'doubao-search-model',
      },
    });

    expect(config.getSearchProvider()).toBe('volcengine');
    expect(config.getSearchApiKey()).toBe('ark-key');
    expect(config.getSearchApiUrl()).toBe(
      'https://ark.example.com/api/v3/responses',
    );
    expect(config.getSearchModel()).toBe('doubao-search-model');
  });

  it('把服务端受信文档署名身份装配进 Core', () => {
    const config = createCoreConfig({
      sessionId: 'document-identity-session',
      customModels: [],
      documentIdentity: {
        name: '林一',
        department: '产品与研发部',
      },
    });

    expect(config.getDocumentIdentity()).toEqual({
      name: '林一',
      department: '产品与研发部',
    });
  });
});
