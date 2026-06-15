/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 非交互式模型配置：`otto setup --provider <p> --key <k> --model <m>`。
 *
 * 存在的意义：交互式向导依赖终端粘贴（bracketed/rapid-paste 检测），在部分
 * 终端 / Windows / SSH 下不稳，导致 API key 粘不进去、配置存成空 key → 401。
 * 这条命令让用户把一整行命令粘进 shell（shell 粘贴在任何系统都稳），一步写好
 * 配置并设为默认模型，完全绕开 TUI 输入。
 */
import { loadSettings, SettingScope } from './config/settings.js';
import { addOrUpdateCustomModel } from './config/customModelsStorage.js';
import {
  generateCustomModelId,
  validateCustomModelConfig,
  type CustomModelConfig,
  type CustomModelProvider,
} from 'otto-core';

interface Preset {
  protocol: CustomModelProvider;
  baseUrl: string;
}

/** 已知供应商预设：选了就自动用对应接口地址与协议（与向导里的预设一致）。 */
const PRESETS: Record<string, Preset> = {
  glm: { protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  zhipu: { protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  deepseek: { protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  moonshot: { protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  kimi: { protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  siliconflow: { protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  openai: { protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  openrouter: { protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
};

export interface NonInteractiveModelSetupOpts {
  provider?: string;
  key?: string;
  model?: string;
  name?: string;
  baseUrl?: string;
  workspaceRoot?: string;
}

export function runNonInteractiveModelSetup(
  opts: NonInteractiveModelSetupOpts,
): { text: string; code: number } {
  const { provider, key, model, name, baseUrl: baseUrlArg } = opts;

  if (!key) {
    return { text: '❌ 缺少 --key <API_KEY>', code: 1 };
  }
  if (!model) {
    return { text: '❌ 缺少 --model <模型名，例如 glm-5.1>', code: 1 };
  }

  const preset = provider ? PRESETS[provider.toLowerCase()] : undefined;
  const baseUrl = (baseUrlArg || preset?.baseUrl || '').replace(/\/+$/, '');
  const protocol: CustomModelProvider = preset?.protocol ?? 'openai';

  if (!baseUrl) {
    return {
      text:
        `❌ 需要 --base-url <接口地址>，或用一个已知的 --provider：` +
        `${Object.keys(PRESETS).join(' / ')}`,
      code: 1,
    };
  }

  const cfg: CustomModelConfig = {
    displayName: name || model,
    provider: protocol,
    baseUrl,
    apiKey: key,
    modelId: model,
    maxTokens: 128000,
    enabled: true,
  };

  const errors = validateCustomModelConfig(cfg);
  if (errors.length > 0) {
    return { text: '❌ 配置无效: ' + errors.join(', '), code: 1 };
  }

  try {
    addOrUpdateCustomModel(cfg);
    const id = generateCustomModelId(cfg);
    const settings = loadSettings(opts.workspaceRoot || process.cwd());
    settings.setValue(SettingScope.User, 'preferredModel', id);
    return {
      text: [
        `✅ 已配置模型并设为默认：${cfg.displayName}`,
        `   provider: ${protocol}   baseUrl: ${baseUrl}   model: ${model}`,
        `   直接运行 otto 即用它（模型 id: ${id}）。`,
      ].join('\n'),
      code: 0,
    };
  } catch (e) {
    return { text: '❌ 写入配置失败: ' + ((e as Error)?.message || String(e)), code: 1 };
  }
}
