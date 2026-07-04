/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYO-key setup 向导的「品牌供应商预设」与配置构造。
 *
 * 设计取舍（Issue #7）：
 *   - 渲染层 **只能** import type otto-server / otto-core（纯类型），不得引运行时值，
 *     否则会把 core 运行时打进 renderer bundle（nodeIntegration:false 下崩）。
 *     因此这里 **复刻** core 的 `CustomModelConfig` 形状与 `generateCustomModelId`
 *     算法（与 packages/core/src/types/customModel.ts 完全同算法），不 import 它们。
 *   - provider 与落盘格式必须与 CLI/server 完全一致：
 *     文件 `~/.otto-user/custom-models.json`，结构 `{ models: CustomModelConfig[], _metadata }`。
 *     校验逻辑也复刻 core 的 `validateCustomModelConfig`（保持错误等价）。
 *
 * 预设端点是公开稳定事实（各家官方 API base）。custom 供应商让用户自填 baseUrl。
 */

import type { SaveCustomModelMsg } from 'otto-server';

/** 与 core CustomModelProvider 同构（协议适配器键）。 */
export type CustomModelProvider =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

/**
 * `save_custom_model` 帧的 payload（结构化字段，契约见 protocol.ts SaveCustomModelMsg）。
 * 注意：**不含** id —— id 由 server 用 generateCustomModelId 统一生成，避免双源漂移。
 */
export type SaveCustomModelPayload = SaveCustomModelMsg['payload'];

/** 与 core CustomModelConfig 同构（落盘条目）。仅复刻向导用得到的字段。 */
export interface CustomModelConfig {
  displayName: string;
  provider: CustomModelProvider;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  maxTokens?: number;
  enabled?: boolean;
}

/**
 * 向导里可选的「品牌供应商」预设。
 * - `id`：UI 下拉的稳定键（非落盘）。
 * - `provider`：落盘到 CustomModelConfig.provider 的协议适配器键。
 * - `baseUrl`：官方 API base（custom 留空让用户填）。
 * - `keyHint` / `modelHint`：输入框占位与示例，降低 BYO-key 门槛。
 * - `keyConsoleUrl`：去哪儿拿 key（用系统浏览器打开）。
 */
export interface ProviderPreset {
  id: string;
  label: string;
  provider: CustomModelProvider;
  baseUrl: string;
  /** baseUrl 是否锁定（false=custom，用户自填）。 */
  baseUrlLocked: boolean;
  keyHint: string;
  keyPrefix?: string;
  modelHint: string;
  exampleModels: string[];
  keyConsoleUrl?: string;
  note?: string;
}

/**
 * 预设清单。openai / anthropic / gemini 为一等公民；外加几家常见 OpenAI 兼容
 * 供应商（端点稳定、公开）；最后 custom 兜底任意自建/代理端点。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlLocked: true,
    keyHint: 'sk-...',
    keyPrefix: 'sk-',
    modelHint: '例如 gpt-5.1 / gpt-4o',
    exampleModels: ['gpt-5.1', 'gpt-4o', 'o4-mini'],
    keyConsoleUrl: 'https://platform.openai.com/api-keys',
    note: 'GPT / o 系列走 OpenAI Responses 协议。',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    baseUrlLocked: true,
    keyHint: 'sk-ant-...',
    keyPrefix: 'sk-ant-',
    modelHint: '例如 claude-opus-4 / claude-sonnet-4',
    exampleModels: ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4'],
    keyConsoleUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Claude 4.6+ 自动走 adaptive thinking。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlLocked: true,
    keyHint: 'AIza...',
    modelHint: '例如 gemini-2.5-pro / gemini-2.5-flash',
    exampleModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    keyConsoleUrl: 'https://aistudio.google.com/app/apikey',
    note: 'Gemini 走原生 GenAI 协议，完整支持 thinking。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    baseUrlLocked: true,
    keyHint: 'sk-...',
    modelHint: '例如 deepseek-chat / deepseek-reasoner',
    exampleModels: ['deepseek-chat', 'deepseek-reasoner'],
    keyConsoleUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    provider: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    baseUrlLocked: true,
    keyHint: 'sk-...',
    modelHint: '例如 kimi-k2 / moonshot-v1-128k',
    exampleModels: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
    keyConsoleUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    provider: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    baseUrlLocked: true,
    keyHint: '你的 API Key',
    modelHint: '例如 glm-5v-turbo / glm-4.6',
    exampleModels: ['glm-5v-turbo', 'glm-5.1', 'glm-4.6', 'glm-4-plus'],
    keyConsoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'custom',
    label: '自定义 / 兼容端点',
    provider: 'openai',
    // key 必填（与 server/core 校验对齐）；本地代理无需真实 key 时填任意占位（如 sk-local）。
    keyHint: '你的 API Key（本地代理可填任意占位，如 sk-local）',
    baseUrl: '',
    baseUrlLocked: false,
    modelHint: '传给接口的实际模型 id',
    exampleModels: [],
    note: '任意 OpenAI / Anthropic 兼容端点或本地代理。可自选协议。本地代理也请在 key 处填任意占位。',
  },
];

/** 协议选项（custom 预设下让用户挑）。 */
export const PROVIDER_OPTIONS: Array<{
  value: CustomModelProvider;
  label: string;
}> =
  [
    { value: 'openai', label: 'OpenAI 兼容 (Chat Completions)' },
    { value: 'openai-responses', label: 'OpenAI Responses (/responses)' },
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'gemini', label: 'Google GenAI (Gemini)' },
  ];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

// ── 落盘配置构造 + 校验（与 core 完全同算法，复刻而非 import）──────────────

/** 向导表单的中间态。 */
export interface SetupFormState {
  presetId: string;
  /** custom 预设时用户选的协议；非 custom 时取预设 provider。 */
  provider: CustomModelProvider;
  baseUrl: string;
  apiKey: string;
  /** 「添加模型」输入框的当前值（点添加/回车后并入 selectedModels）。 */
  modelId: string;
  /** 已勾选 / 添加的模型 id 集合——填一次 key 批量落盘的核心。 */
  selectedModels: string[];
  /** 仅当最终恰好 1 个模型时用作显示名；批量（多个）时忽略，每条取其 modelId。 */
  displayName: string;
}

/**
 * 本次要落盘的模型 id 列表 = 已勾选集合 + 输入框里尚未点「添加」的那个（若非空），去重去空。
 * 让用户输入到一半直接点「完成」也不丢那个模型。
 */
export function effectiveModelIds(form: SetupFormState): string[] {
  const pending = form.modelId.trim();
  const all = [...form.selectedModels, ...(pending ? [pending] : [])].map((s) =>
    s.trim(),
  );
  return Array.from(new Set(all.filter(Boolean)));
}

/**
 * 复刻 core `generateCustomModelId`：`custom:{provider}:{modelId}@{baseUrlHash}`。
 * 算法逐字符与 packages/core/src/types/customModel.ts 对齐，保证 desktop 生成的 id
 * 与 server `listModelInfos()` 出来的 id 一致（选中后 set_model 能命中）。
 */
export function generateCustomModelId(cfg: {
  provider: string;
  baseUrl: string;
  modelId: string;
}): string {
  const hashString = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substring(0, 6);
  };
  const baseUrlHash = hashString(cfg.baseUrl);
  return `custom:${cfg.provider}:${cfg.modelId}@${baseUrlHash}`;
}

/** 把表单构造成落盘 CustomModelConfig（去掉末尾斜杠，与 CLI 行为一致）。 */
export function buildConfig(form: SetupFormState): CustomModelConfig {
  const baseUrl = form.baseUrl.trim().replace(/\/+$/, '');
  const ids = effectiveModelIds(form);
  const modelId = ids[0] ?? '';
  const displayName =
    (ids.length <= 1 ? form.displayName.trim() : '') ||
    `${findPreset(form.presetId)?.label ?? form.provider} ${modelId}`;
  return {
    displayName,
    provider: form.provider,
    baseUrl,
    apiKey: form.apiKey.trim(),
    modelId,
    enabled: true,
  };
}

/**
 * 把表单构造成 `save_custom_model` 帧的 payload（结构化字段，字节对齐契约）。
 * 不传 id（server 端用 generateCustomModelId 统一生成）。displayName 为空时也省略，
 * 让 server 用 modelId 兜底（与 protocol 注释一致）。
 */
export function buildSavePayload(form: SetupFormState): SaveCustomModelPayload {
  const cfg = buildConfig(form);
  const ids = effectiveModelIds(form);
  const userNamed = form.displayName.trim();
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    // 主 modelId 取第一个（向后兼容单条校验）；多个时附 modelIds 批量落盘。
    modelId: ids[0] ?? '',
    ...(ids.length > 1 ? { modelIds: ids } : {}),
    // 显示名仅在恰好 1 个模型时有意义；批量每条取其 modelId。
    ...(ids.length === 1 && userNamed ? { displayName: userNamed } : {}),
    enabled: true,
    makeActive: true,
  };
}

/**
 * 本地校验（复刻 core `validateCustomModelConfig` 的必填规则 + baseUrl 形态）。
 * 返回字段级错误 map，空 map = 通过。
 */
export function validateForm(form: SetupFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  const cfg = buildConfig(form);
  const ids = effectiveModelIds(form);

  if (ids.length === 0) {
    errors.modelId = '请至少勾选或填写一个模型 id';
  }
  if (!cfg.baseUrl) {
    errors.baseUrl = '请填写接口地址 base URL';
  } else if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    errors.baseUrl = 'base URL 需以 http:// 或 https:// 开头';
  } else {
    try {
      const parsed = new URL(cfg.baseUrl);
      void parsed;
    } catch {
      errors.baseUrl = 'base URL 格式不合法';
    }
  }
  if (!cfg.apiKey) {
    // 大多数端点必填；custom 代理可能不需要，但 core 校验把 apiKey 列为必填，
    // 这里与之对齐（用户用本地代理时可随便填一个占位）。
    errors.apiKey = '请粘贴 API key（本地代理可填任意占位）';
  }
  // 显示名只在单个模型时相关；批量每条取 modelId，无需显示名。
  if (ids.length === 1 && !cfg.displayName) {
    errors.displayName = '显示名不能为空';
  }
  return errors;
}

/**
 * 生成与 CLI/server 完全一致的 `~/.otto-user/custom-models.json` 文本片段。
 * 落盘端点未实装时，把这段交给用户复制 / CLI 写入（见 SetupPanel 的「写入端点待补」）。
 * apiKey 与 buildCliCommand 一致用占位符——明文 key 不进剪贴板，粘贴后用户自行填入。
 */
export function buildModelsFileJson(cfg: CustomModelConfig): string {
  const data = {
    models: [{ ...cfg, apiKey: '<你的API_KEY>' }],
    _metadata: {
      version: '1.0',
      lastModified: new Date().toISOString(),
    },
  };
  return JSON.stringify(data, null, 2);
}

/** 生成等价的 CLI 命令（非交互式 `otto setup`，与 modelSetupCli 对齐）。 */
export function buildCliCommand(form: SetupFormState): string {
  const cfg = buildConfig(form);
  const preset = findPreset(form.presetId);
  const providerArg = preset && preset.id !== 'custom' ? preset.id : form.provider;
  const parts = [
    'otto setup',
    `--provider ${shellQuote(providerArg)}`,
    `--model ${shellQuote(cfg.modelId)}`,
    '--key <你的API_KEY>',
  ];
  if (!preset || !preset.baseUrlLocked) {
    parts.push(`--base-url ${shellQuote(cfg.baseUrl)}`);
  }
  return parts.join(' ');
}

function shellQuote(s: string): string {
  if (/^[\w./:@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
