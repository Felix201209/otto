/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYO-key 自定义模型读取（server 端自包含副本）。
 *
 * 落盘格式与 桌面 完全一致：`~/.otto-user/custom-models.json`，
 * 结构 `{ models: CustomModelConfig[] }`。CLI 侧的读写 API 在
 * 历史 CLI 设置格式；server 不能反向依赖任何 UI 包。
 *
 * 因此这里在 server 包内复刻「只读」路径：仅依赖 otto-core 的
 * `CustomModelConfig` / `validateCustomModelConfig` / `generateCustomModelId`，
 * 不引第三方 strip-json-comments（用一个保守的注释剥离兜底自给自足）。
 *
 * 写入：setup GUI（Issue #7）经 `save_custom_model` 帧落盘，由本文件的
 * `saveCustomModel` 处理 —— 复刻 CLI `customModelsStorage.ts` 的**原子写**
 * （.tmp → rename）+ 按 displayName 去重 + `{ models, _metadata }` 结构，
 * 字节级对齐 CLI 格式；依赖仍只有 otto-core，**不**反向依赖 UI 包。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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

/** 已是 `{file:...}` / `{env:...}` / `$VAR` / `${VAR}` 引用形态的 key。 */
function isKeyReference(key: string): boolean {
  const t = key.trim();
  return /^\{(file|env):[^}]+\}$/.test(t)
    || /^(?:\$\{[^}]+\}|\$\w+)$/.test(t);
}

/**
 * 把明文 API key 写进 `~/.otto-user/secrets/<safe-name>.<name-hash>.<key-hash>`（0600，目录 0700），
 * 返回 `{file:绝对路径}` 引用 —— 对齐 CLI 的 0600 secret 文件 + {file:} 安全模型，
 * 让明文 key 永不落进 world-readable 的 custom-models.json。
 *
 * 文件名由 **displayName + key 内容** 派生、安全化并加稳定哈希：
 * 不能按 provider（协议名 openai/anthropic…）命名，否则两个都走 openai 协议的
 * 不同真实供应商或清洗后同名的模型会互相覆盖。key 也必须参与版本标识，确保先写
 * 新 secret、再原子切换配置引用时，即使配置提交失败也绝不污染旧引用指向的内容。
 */
function writeApiKeySecret(displayName: string, key: string): string {
  const dir = path.join(os.homedir(), SETTINGS_DIR_NAME, SECRETS_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mode 选项只对新建文件/目录生效；旧版若已以 0755/0644 存在，
  // 必须显式 chmod 才能真正收紧。
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows/只读卷上 best effort */ }
  const safe = displayName.replace(/[^\w.-]/g, '_') || 'model';
  // 防止不同 displayName 清洗后落到同一路径，也让同一模型的不同 key
  // 各自拥有不可变版本；配置原子提交前不会触碰旧引用。
  const nameIdentity = createHash('sha256')
    .update(displayName, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const keyVersion = createHash('sha256')
    .update(key.trim(), 'utf8')
    .digest('hex')
    .slice(0, 24);
  const secretPath = path.join(dir, `${safe}.${nameIdentity}.${keyVersion}`);
  fs.writeFileSync(secretPath, key.trim() + '\n', { mode: 0o600 });
  fs.chmodSync(secretPath, 0o600);
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
    try { fs.chmodSync(filePath, 0o600); } catch { /* 读取仍可继续 */ }
    const parsed = parseModelsFile(fs.readFileSync(filePath, 'utf-8'));
    const pref = parsed?._metadata?.preferredModel;
    return typeof pref === 'string' && pref.length > 0 ? pref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 仅更新 `_metadata.preferredModel`，不修改模型列表。
 * 用于运行时模型切换（set_model 帧）的持久化。
 */
export function savePreferredModel(modelId: string): void {
  const models = loadCustomModels();
  saveCustomModels(models, modelId);
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
    // 即使文件已经没有明文 key，也要修复旧版留下的宽权限。
    try { fs.chmodSync(filePath, 0o600); } catch { /* 校验/读取继续 */ }
  } catch {
    return [];
  }

  const parsed = parseModelsFile(raw);
  if (!parsed || !Array.isArray(parsed.models)) {
    return [];
  }

  const valid: CustomModelConfig[] = [];
  let migratedPlaintext = false;
  for (const candidate of parsed.models) {
    // 逐条校验：复用 core 的 validateCustomModelConfig（与 CLI 同源）。
    const errors = validateCustomModelConfig(candidate as CustomModelConfig);
    if (errors.length === 0) {
      const model = candidate as CustomModelConfig;
      if (isKeyReference(model.apiKey)) {
        valid.push(model);
      } else {
        // 旧版 desktop/server 会把 key 直接写进 custom-models.json。
        // 加载时立即迁移：先写 0600 secret，再原子重写配置为 {file:}。
        valid.push({
          ...model,
          apiKey: writeApiKeySecret(model.displayName, model.apiKey),
        });
        migratedPlaintext = true;
      }
    }
  }
  if (migratedPlaintext) {
    const preferred = parsed._metadata?.preferredModel;
    saveCustomModels(
      valid,
      typeof preferred === 'string' && preferred ? preferred : undefined,
    );
  }
  return valid;
}

/** 确保配置目录存在（与 CLI ensureDirectoryExists 同义）。 */
function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(dirPath, 0o700); } catch { /* Windows/只读卷上 best effort */ }
}

/**
 * 原子写回整份自定义模型列表（复刻 CLI saveCustomModels）。
 *
 * - 写前逐条 `validateCustomModelConfig`，任一非法即抛（调用方转 error 帧）。
 * - 结构 `{ models, _metadata: { version, lastModified } }`，与 CLI 字节级一致，
 *   保证 桌面 与 GUI 读到同一份、互不破坏格式。
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
  fs.writeFileSync(tempFilePath, jsonContent, { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(tempFilePath, 0o600);
  fs.renameSync(tempFilePath, filePath);
  fs.chmodSync(filePath, 0o600);
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

  const models = loadCustomModels();
  const sameNameIndexes = models
    .map((candidate, index) => candidate.displayName === model.displayName ? index : -1)
    .filter((index) => index >= 0);
  if (sameNameIndexes.length > 1) {
    throw new Error('自定义模型显示名称冲突，请先修复重复配置');
  }
  const existingIndex = sameNameIndexes[0] ?? -1;
  const id = generateCustomModelId(model);
  const identityConflict = models.findIndex(
    (candidate, index) => index !== existingIndex && generateCustomModelId(candidate) === id,
  );
  if (identityConflict >= 0) {
    throw new Error(`模型标识 ${id} 已存在，请修改供应商、接口地址或模型 ID`);
  }

  // 所有冲突校验必须先于 secret 写入，避免失败的保存请求覆盖另一模型密钥。
  const toSave: CustomModelConfig = isKeyReference(model.apiKey)
    ? model
    : {
        ...model,
        apiKey: writeApiKeySecret(model.displayName, model.apiKey),
      };
  const next =
    existingIndex >= 0
      ? models.map((m, i) => (i === existingIndex ? toSave : m))
      : [...models, toSave];

  // makeActive → 把该模型设为「当前生效模型」（单一事实源，createCoreConfig 优先用）；
  // 否则保留既有 preferredModel（非激活式保存不应抹掉用户已选的生效模型）。
  const preferred = makeActive ? id : loadPreferredModel();
  saveCustomModels(next, preferred);
  return id;
}

/** 按旧 ModelInfo.id 原子替换；编辑态空 key 表示沿用旧 secret 引用。 */
export function replaceCustomModel(
  replaceId: string,
  nextModel: CustomModelConfig,
  makeActive = false,
): string {
  const models = loadCustomModels();
  const matchingIndexes = models
    .map((model, index) => generateCustomModelId(model) === replaceId ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length === 0) throw new Error('要编辑的模型不存在（可能已被删除）');
  if (matchingIndexes.length > 1) {
    throw new Error('模型标识冲突，无法安全确定要编辑的配置');
  }
  const index = matchingIndexes[0]!;

  const previous = models[index];
  const merged: CustomModelConfig = {
    ...nextModel,
    apiKey: nextModel.apiKey.trim() ? nextModel.apiKey : previous.apiKey,
  };
  const errors = validateCustomModelConfig(merged);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const displayNameConflict = models.findIndex(
    (candidate, candidateIndex) => (
      candidateIndex !== index && candidate.displayName === merged.displayName
    ),
  );
  if (displayNameConflict >= 0) {
    throw new Error(`显示名称 ${merged.displayName} 已存在`);
  }
  const newId = generateCustomModelId(merged);
  const identityConflict = models.findIndex(
    (candidate, candidateIndex) => (
      candidateIndex !== index && generateCustomModelId(candidate) === newId
    ),
  );
  if (identityConflict >= 0) {
    throw new Error(`模型标识 ${newId} 已存在，请修改供应商、接口地址或模型 ID`);
  }
  // 冲突校验完成后才允许写 secret，失败编辑绝不能覆盖另一模型的凭证。
  const toSave: CustomModelConfig = isKeyReference(merged.apiKey)
    ? merged
    : { ...merged, apiKey: writeApiKeySecret(merged.displayName, merged.apiKey) };
  const preferred = loadPreferredModel();
  saveCustomModels(
    models.map((m, i) => (i === index ? toSave : m)),
    makeActive || preferred === replaceId ? newId : preferred,
  );
  return newId;
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
    // 带上 baseUrl 让 UI 能按接入域名识别真实厂商：provider 只是协议名，
    // OpenAI 兼容接入的智谱/通义/DeepSeek 全叫 'openai'，直接展示会误导。
    baseUrl: m.baseUrl,
    modelId: m.modelId,
    source: 'byok',
    managed: false,
    ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    enabled: m.enabled !== false,
  }));
}

/**
 * 删除一个自定义模型（按 ModelInfo id 匹配，即 generateCustomModelId 结果）。
 * 命中则原子重写配置；若被删的正是当前生效模型（preferredModel），一并清除
 * （下次解析回退默认顺序）。返回是否真的删掉了。
 */
export function deleteCustomModel(infoId: string): boolean {
  const models = loadCustomModels();
  const matchingIndexes = models
    .map((model, index) => generateCustomModelId(model) === infoId ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length === 0) return false;
  if (matchingIndexes.length > 1) {
    throw new Error('模型标识冲突，删除已停止；请先修复重复配置');
  }
  const rest = models.filter((_model, index) => index !== matchingIndexes[0]);
  const preferred = loadPreferredModel();
  saveCustomModels(rest, preferred === infoId ? undefined : preferred);
  return true;
}
