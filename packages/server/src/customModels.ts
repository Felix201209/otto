/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYO-key 自定义模型读取（server 端自包含副本）。
 *
 * 落盘格式与 CLI/TUI 完全一致：`~/.otto-user/custom-models.json`，
 * 结构 `{ models: CustomModelConfig[] }`。CLI 侧的读写 API 在
 * `packages/cli/src/config/customModelsStorage.ts`，但那是 CLI 包内文件，
 * server **不能反向依赖 otto-cli**（会牵入 Ink，破 TUI 回归门 Issue #10）。
 *
 * 因此这里在 server 包内复刻「只读」路径：仅依赖 otto-core 的
 * `CustomModelConfig` / `validateCustomModelConfig` / `generateCustomModelId`，
 * 不引第三方 strip-json-comments（用一个保守的注释剥离兜底自给自足）。
 *
 * 写入：setup GUI（Issue #7）经 `save_custom_model` 帧落盘，由本文件的
 * `saveCustomModel` 处理 —— 复刻 CLI `customModelsStorage.ts` 的**原子写**
 * （.tmp → rename）+ 按 displayName 去重 + `{ models, _metadata }` 结构，
 * 字节级对齐 CLI 格式；依赖仍只有 otto-core，**不**反向依赖 otto-cli，守住
 * Issue #10（TUI 回归门不被 Ink 牵连）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateCustomModelId,
  validateCustomModelConfig,
  type CustomModelConfig,
} from 'otto-core';
import type { ModelInfo } from './protocol.js';

const SETTINGS_DIR_NAME = '.otto-user';
const CUSTOM_MODELS_FILE = 'custom-models.json';
const SECRETS_DIR_NAME = 'secrets';

/** 自定义模型配置文件路径（与 CLI 同一约定）。 */
export function customModelsFilePath(): string {
  return path.join(os.homedir(), SETTINGS_DIR_NAME, CUSTOM_MODELS_FILE);
}

/** 已是 `{file:...}` / `{env:...}` 引用形态的 key（无需二次写文件，原样透传）。 */
function isKeyReference(key: string): boolean {
  const t = key.trim();
  return /^\{file:[^}]+\}$/.test(t) || /^\{env:[^}]+\}$/.test(t);
}

/**
 * 把明文 API key 写进 `~/.otto-user/secrets/<safe-name>`（0600，目录 0700），
 * 返回 `{file:绝对路径}` 引用 —— 对齐 CLI 的 0600 secret 文件 + {file:} 安全模型，
 * 让明文 key 永不落进 world-readable 的 custom-models.json。
 *
 * 文件名由 **displayName**（saveCustomModel 的去重键）派生并安全化：
 * 不能按 provider（协议名 openai/anthropic…）命名，否则两个都走 openai 协议的
 * 不同真实供应商会写到同一 secret 文件互相覆盖 key。覆盖同名模型时复用同一路径。
 */
function writeApiKeySecret(displayName: string, key: string): string {
  const dir = path.join(os.homedir(), SETTINGS_DIR_NAME, SECRETS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = displayName.replace(/[^\w.-]/g, '_') || 'model';
  const secretPath = path.join(dir, safe);
  fs.writeFileSync(secretPath, key.trim() + '\n', { mode: 0o600 });
  return `{file:${secretPath}}`;
}

/**
 * 极简 JSON 注释剥离：去掉整行 `//` 注释与 `/* *\/` 块注释。
 *
 * 仅用于容忍用户手写配置里的注释，不追求完备（字符串内出现 `//` 等
 * 边角不处理）——配置文件由向导生成时本就是干净 JSON，这里是健壮性兜底。
 * 若剥离后解析仍失败，调用方会回退到「原样 JSON.parse」再失败即返回空。
 */
function stripJsonCommentsLoose(input: string): string {
  // 块注释
  let out = input.replace(/\/\*[\s\S]*?\*\//g, '');
  // 整行行注释（行首可有空白；避免误伤 URL 里的 `://`，只处理行首到 // 的情况）
  out = out
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//')) return '';
      return line;
    })
    .join('\n');
  return out;
}

/** custom-models.json 的解析形态（models + 可选 _metadata）。 */
interface ModelsFileShape {
  models?: unknown;
  _metadata?: { preferredModel?: unknown };
}

/** 解析 custom-models.json 文本，宽容注释。失败返回 undefined。 */
function parseModelsFile(raw: string): ModelsFileShape | undefined {
  try {
    return JSON.parse(raw) as ModelsFileShape;
  } catch {
    // 兜底：剥离注释再试一次。
    try {
      return JSON.parse(stripJsonCommentsLoose(raw)) as ModelsFileShape;
    } catch {
      return undefined;
    }
  }
}

/**
 * 读取「当前生效模型」id（makeActive 写入的 `_metadata.preferredModel`）。
 * 文件不存在 / 无该字段 / 损坏时返回 undefined。这是 server 端单一事实源：
 * createCoreConfig 优先用它（而非死取 enabled[0]），models_list 用它填 current。
 */
export function loadPreferredModel(): string | undefined {
  const filePath = customModelsFilePath();
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = parseModelsFile(fs.readFileSync(filePath, 'utf-8'));
    const pref = parsed?._metadata?.preferredModel;
    return typeof pref === 'string' && pref.length > 0 ? pref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 加载自定义模型配置（只读）。
 * 文件不存在 / 格式非法 / 校验失败的条目都会被安全跳过，返回干净列表。
 */
export function loadCustomModels(): CustomModelConfig[] {
  const filePath = customModelsFilePath();
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return [];
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const parsed = parseModelsFile(raw);
  if (!parsed || !Array.isArray(parsed.models)) {
    return [];
  }

  const valid: CustomModelConfig[] = [];
  for (const candidate of parsed.models) {
    // 逐条校验：复用 core 的 validateCustomModelConfig（与 CLI 同源）。
    const errors = validateCustomModelConfig(candidate as CustomModelConfig);
    if (errors.length === 0) {
      valid.push(candidate as CustomModelConfig);
    }
  }
  return valid;
}

/** 确保配置目录存在（与 CLI ensureDirectoryExists 同义）。 */
function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 原子写回整份自定义模型列表（复刻 CLI saveCustomModels）。
 *
 * - 写前逐条 `validateCustomModelConfig`，任一非法即抛（调用方转 error 帧）。
 * - 结构 `{ models, _metadata: { version, lastModified } }`，与 CLI 字节级一致，
 *   保证 CLI/TUI 与 GUI 读到同一份、互不破坏格式。
 * - 原子写：先写 `.tmp` 再 `rename`，避免半截文件。
 */
export function saveCustomModels(
  models: CustomModelConfig[],
  preferredModel?: string,
): void {
  const filePath = customModelsFilePath();
  ensureDirectoryExists(path.dirname(filePath));

  for (const model of models) {
    const errors = validateCustomModelConfig(model);
    if (errors.length > 0) {
      throw new Error(
        `Invalid model configuration for "${model.displayName}": ${errors.join(', ')}`,
      );
    }
  }

  const data = {
    models,
    _metadata: {
      version: '1.0',
      lastModified: new Date().toISOString(),
      // 「当前生效模型」单一事实源；undefined 时不写该键，保持向后兼容。
      ...(preferredModel ? { preferredModel } : {}),
    },
  };
  const jsonContent = JSON.stringify(data, null, 2);
  const tempFilePath = filePath + '.tmp';
  fs.writeFileSync(tempFilePath, jsonContent, 'utf-8');
  fs.renameSync(tempFilePath, filePath);
}

/**
 * 添加或更新单个自定义模型（按 displayName 去重，复刻 CLI addOrUpdateCustomModel）。
 *
 * displayName 已存在 → 覆盖该条；否则追加。写盘成功后返回该模型的统一 id
 * （`generateCustomModelId`，与 listModelInfos / core 解析同源），供上层广播/选中。
 * 入参非法（缺 baseUrl/apiKey/modelId 等）会在 saveCustomModels 内抛出。
 */
export function saveCustomModel(
  model: CustomModelConfig,
  makeActive = false,
): string {
  // 先单独校验，给出比「整批写」更早、更聚焦的失败点。
  const errors = validateCustomModelConfig(model);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  // 安全：把明文 API key 提取成 0600 secret 文件，config 里只存 {file:} 引用，
  // 让明文 key 永不落进 world-readable 的 custom-models.json（对齐 CLI 安全模型）。
  // 用户若本就粘的是 {file:}/{env:} 引用，则原样透传，不二次写文件。
  const toSave: CustomModelConfig = isKeyReference(model.apiKey)
    ? model
    : {
        ...model,
        apiKey: writeApiKeySecret(model.displayName, model.apiKey),
      };

  const models = loadCustomModels();
  const existingIndex = models.findIndex(
    (m) => m.displayName === toSave.displayName,
  );
  const next =
    existingIndex >= 0
      ? models.map((m, i) => (i === existingIndex ? toSave : m))
      : [...models, toSave];

  const id = generateCustomModelId(toSave);
  // makeActive → 把该模型设为「当前生效模型」（单一事实源，createCoreConfig 优先用）；
  // 否则保留既有 preferredModel（非激活式保存不应抹掉用户已选的生效模型）。
  const preferred = makeActive ? id : loadPreferredModel();
  saveCustomModels(next, preferred);
  return id;
}

/**
 * 把自定义模型映射成协议的 ModelInfo[]（供 /models 与 get_models 回包）。
 * `id` 用与 core 一致的 `generateCustomModelId`，desktop 选中后回传 set_model
 * 即可命中 core 的 getCustomModelConfig 解析。
 */
export function listModelInfos(): ModelInfo[] {
  return loadCustomModels().map((m) => ({
    id: generateCustomModelId(m),
    displayName: m.displayName,
    provider: m.provider,
    enabled: m.enabled !== false,
  }));
}
