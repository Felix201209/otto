/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** presets 纯函数单测：复制路径（JSON / CLI 命令）不携带明文 API key。 */

import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  buildSavePayload,
  effectiveModelIds,
  buildModelsFileJson,
  vendorFromBaseUrl,
  type SetupFormState,
} from './presets.js';

const form: SetupFormState = {
  presetId: 'openai',
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-real-secret-123',
  modelId: 'gpt-5.1',
  selectedModels: [],
  displayName: '',
  maxTokens: '',
  enabled: true,
};

describe('buildModelsFileJson', () => {
  it('apiKey 用占位符，不把明文 key 写进剪贴板文本', () => {
    const json = buildModelsFileJson(buildConfig(form));
    expect(json).not.toContain('sk-real-secret-123');
    const parsed = JSON.parse(json) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models[0].apiKey).toBe('<你的API_KEY>');
  });

  it('其余字段与落盘结构契约不变', () => {
    const cfg = buildConfig(form);
    const parsed = JSON.parse(buildModelsFileJson(cfg)) as {
      models: Array<Record<string, unknown>>;
      _metadata: { version: string };
    };
    expect(parsed.models[0]).toMatchObject({
      displayName: cfg.displayName,
      provider: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-5.1',
      enabled: true,
    });
    expect(parsed._metadata.version).toBe('1.0');
  });

  it('buildConfig 本身仍保留真实 key（save_custom_model 落盘路径不受影响）', () => {
    expect(buildConfig(form).apiKey).toBe('sk-real-secret-123');
  });
});


describe('多选批量（填一次 key → 多模型）', () => {
  it('effectiveModelIds 合并已选 + 输入框待添加，去重去空', () => {
    expect(
      effectiveModelIds({ ...form, selectedModels: ['a', 'b'], modelId: 'c' }),
    ).toEqual(['a', 'b', 'c']);
    // 输入框里的重复项不再追加
    expect(
      effectiveModelIds({ ...form, selectedModels: ['a'], modelId: 'a' }),
    ).toEqual(['a']);
    // 空白输入不算
    expect(
      effectiveModelIds({ ...form, selectedModels: [], modelId: '   ' }),
    ).toEqual([]);
  });

  it('多选 → payload 带 modelIds 批量；单个不带', () => {
    const multi = buildSavePayload({
      ...form,
      selectedModels: ['glm-5.1', 'glm-5v-turbo'],
      modelId: '',
    });
    expect(multi.modelId).toBe('glm-5.1');
    expect(multi.modelIds).toEqual(['glm-5.1', 'glm-5v-turbo']);
    expect(multi.apiKey).toBe('sk-real-secret-123'); // 共用同一个 key

    const single = buildSavePayload({
      ...form,
      selectedModels: [],
      modelId: 'gpt-5.1',
    });
    expect(single.modelIds).toBeUndefined();
    expect(single.modelId).toBe('gpt-5.1');
  });
});

describe('vendorFromBaseUrl：按接入域名识别真实厂商', () => {
  it('已知域名 → 厂商名（provider 是协议名不可信）', () => {
    expect(vendorFromBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe('智谱 GLM');
    expect(vendorFromBaseUrl('https://chatgpt.com/backend-api/codex', 'openai-responses')).toBe('OpenAI');
    expect(vendorFromBaseUrl('https://api.deepseek.com/v1', 'openai')).toBe('DeepSeek');
    expect(vendorFromBaseUrl('https://dashscope.aliyuncs.com/api/v1', 'openai')).toBe('阿里通义');
  });

  it('未知域名 → 原样返回主机名，不冒充', () => {
    expect(vendorFromBaseUrl('https://llm.mycorp.internal/v1', 'openai')).toBe('llm.mycorp.internal');
  });

  it('缺 baseUrl / 非法 URL → 回退 provider', () => {
    expect(vendorFromBaseUrl(undefined, 'openai')).toBe('openai');
    expect(vendorFromBaseUrl('not-a-url', 'anthropic')).toBe('anthropic');
  });
});

describe('编辑模型 payload', () => {
  it('携带 replaceId、全部可编辑字段，并允许 key 留空', () => {
    const editing: SetupFormState = {
      ...form,
      replaceId: 'custom:openai:old@abc',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      modelId: 'claude-sonnet-4',
      displayName: 'Claude 工作模型',
      maxTokens: '200000',
      enabled: false,
    };
    expect(buildSavePayload(editing)).toMatchObject({
      replaceId: editing.replaceId,
      provider: 'anthropic',
      apiKey: '',
      modelId: 'claude-sonnet-4',
      displayName: 'Claude 工作模型',
      maxTokens: 200000,
      enabled: false,
      makeActive: false,
    });
  });
});
