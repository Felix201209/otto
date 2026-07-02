/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** presets 纯函数单测：复制路径（JSON / CLI 命令）不携带明文 API key。 */

import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  buildModelsFileJson,
  buildCliCommand,
  type SetupFormState,
} from './presets.js';

const form: SetupFormState = {
  presetId: 'openai',
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-real-secret-123',
  modelId: 'gpt-5.1',
  displayName: '',
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

describe('buildCliCommand', () => {
  it('--key 一直是占位符，不含明文 key', () => {
    const cmd = buildCliCommand(form);
    expect(cmd).toContain('--key <你的API_KEY>');
    expect(cmd).not.toContain('sk-real-secret-123');
  });
});
