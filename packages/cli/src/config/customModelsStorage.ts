/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createHash } from 'node:crypto';
import {
  generateCustomModelId,
  type CustomModelConfig,
  validateCustomModelConfig,
} from 'otto-core';
import stripJsonComments from 'strip-json-comments';

const SETTINGS_DIRECTORY_NAME = '.otto-user';
const CUSTOM_MODELS_FILE = 'custom-models.json';

/**
 * 配置根目录：默认 ~/.otto-user；
 * 可用 OTTO_USER_DIR 环境变量覆盖（测试隔离 / 沙箱重定向用）。
 */
function getSettingsDir(): string {
  return process.env.OTTO_USER_DIR || path.join(homedir(), SETTINGS_DIRECTORY_NAME);
}

/**
 * 获取自定义模型配置文件路径
 */
export function getCustomModelsFilePath(): string {
  return path.join(getSettingsDir(), CUSTOM_MODELS_FILE);
}

/**
 * 确保目录存在（0700：仅本用户可读写，配置目录可能存有 API key 相关文件）
 */
function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  } else {
    // 旧版本可能以默认 umask 建目录，读写时顺手收紧
    try {
      fs.chmodSync(dirPath, 0o700);
    } catch {
      // Windows / 只读文件系统等场景忽略
    }
  }
}

/**
 * 把 API key 写进 ~/.otto-user/secrets/<name>.<name-hash>.<key-hash>
 * （目录 0700、文件 0600），返回文件路径。
 * 配置里只存 {file:...} 引用，明文 key 不落进 custom-models.json。
 * 非交互 setup（modelSetupCli）与交互式向导的保存路径共用这一份逻辑。
 */
export function writeSecretFile(name: string, key: string): string {
  const dir = path.join(getSettingsDir(), 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 目录已存在时 mkdirSync 的 mode 不生效，chmod 兜底；失败（Windows 等）忽略
  }
  const safe = name.replace(/[^\w.-]/g, '_') || 'model';
  // 仅清洗字符会让 "Acme/Model" 与 "Acme_Model"（以及大小写不敏感
  // 文件系统上的同名变体）碰撞。key 也参与版本标识：先写新 secret、
  // 再原子切换配置引用时，即使配置提交失败也不会覆盖旧 secret。
  const nameIdentity = createHash('sha256')
    .update(name, 'utf8')
    .digest('hex')
    .slice(0, 12);
  const keyVersion = createHash('sha256')
    .update(key.trim(), 'utf8')
    .digest('hex')
    .slice(0, 24);
  const filePath = path.join(dir, `${safe}.${nameIdentity}.${keyVersion}`);
  fs.writeFileSync(filePath, key.trim() + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // 覆盖已存在文件时 writeFileSync 的 mode 不生效，chmod 兜底
  }
  return filePath;
}

/**
 * 判断 apiKey 是否已是引用而非明文：
 *   {file:...} / {env:...}（opencode 语法）、${VAR} / $VAR（旧语法，
 *   含 Codex OAuth 哨兵 '${CODEX_OAUTH}'）。这些值由 core 侧 resolveEnvVar 解析。
 */
function isApiKeyReference(value: string): boolean {
  const trimmed = (value || '').trim();
  return /^\{(file|env):[^}]+\}$/.test(trimmed)
    || /^(?:\$\{[^}]+\}|\$\w+)$/.test(trimmed);
}

/**
 * 落盘前收口：明文 apiKey 一律先写 0600 secret 文件，配置里改存 {file:...} 引用。
 * 已是引用的原样返回。文件名用 displayName + 稳定哈希，不同模型互不覆盖。
 */
function withSecuredApiKey(model: CustomModelConfig): CustomModelConfig {
  if (!model.apiKey || isApiKeyReference(model.apiKey)) {
    return model;
  }
  const secretPath = writeSecretFile(model.displayName, model.apiKey);
  return { ...model, apiKey: `{file:${secretPath}}` };
}

/**
 * 加载自定义模型配置（从独立文件）
 * 这样可以避免与settings.json的并发冲突
 */
export function loadCustomModels(): CustomModelConfig[] {
  const filePath = getCustomModelsFilePath();

  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    // 旧版本以默认 umask（0644）落盘的文件，读到时顺手收紧权限
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows / 只读文件系统等场景忽略
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(stripJsonComments(content));

    if (!Array.isArray(parsed.models)) {
      console.warn('[CustomModels] Invalid format in custom-models.json, expected { models: [...] }');
      return [];
    }

    // 验证每个模型配置
    const validModels: CustomModelConfig[] = [];
    for (const model of parsed.models) {
      const errors = validateCustomModelConfig(model);
      if (errors.length === 0) {
        validModels.push(model);
      } else {
        console.warn(`[CustomModels] Skipping invalid model "${model.displayName}":`, errors);
      }
    }

    // 旧版本允许明文 key 直接存在 JSON 里。加载时完成一次性
    // 迁移：先把 key 写入 0600 secrets，再原子重写配置。返回值也是
    // 引用，确保后续组件不会把明文再传播到日志/诊断包。
    const securedModels = validModels.map(withSecuredApiKey);
    const migrated = securedModels.some((model, index) => model.apiKey !== validModels[index].apiKey);
    if (migrated) {
      persistCustomModels(filePath, securedModels);
      console.log(`[CustomModels] Migrated plaintext API key(s) to ${path.join(getSettingsDir(), 'secrets')}`);
    }

    return securedModels;
  } catch (error) {
    console.error('[CustomModels] Failed to load custom models:', error);
    return [];
  }
}

/**
 * 保存自定义模型配置（到独立文件）
 * 使用原子写入操作，避免文件损坏
 */
export function saveCustomModels(models: CustomModelConfig[]): void {
  const filePath = getCustomModelsFilePath();
  const dirPath = path.dirname(filePath);

  try {
    // 确保目录存在
    ensureDirectoryExists(dirPath);

    // 验证所有模型配置
    for (const model of models) {
      const errors = validateCustomModelConfig(model);
      if (errors.length > 0) {
        throw new Error(`Invalid model configuration for "${model.displayName}": ${errors.join(', ')}`);
      }
    }

    // CLI 与 Desktop/Server 共用 custom-models.json，而桌面操作以协议 model ID
    // 定位条目。不同显示名若生成相同 ID，会造成切换、编辑和删除歧义。
    const identities = new Set<string>();
    for (const model of models) {
      const identity = generateCustomModelId(model);
      if (identities.has(identity)) {
        throw new Error(`模型标识 ${identity} 重复，请修改供应商、接口地址或模型 ID`);
      }
      identities.add(identity);
    }

    // 明文 key 收口：落盘前统一转成 0600 secret 文件 + {file:...} 引用，
    // custom-models.json 里不出现明文 API key（交互式向导等所有保存路径生效）。
    // 读取侧不变：旧配置里已存在的明文 apiKey 照常可用（resolveEnvVar 原样返回）。
    const securedModels = models.map(withSecuredApiKey);

    persistCustomModels(filePath, securedModels);

    console.log(`[CustomModels] Successfully saved ${models.length} custom model(s) to ${filePath}`);
  } catch (error) {
    console.error('[CustomModels] Failed to save custom models:', error);
    throw error;
  }
}

function persistCustomModels(filePath: string, models: CustomModelConfig[]): void {
  ensureDirectoryExists(path.dirname(filePath));
  const data = {
    models,
    _metadata: {
      version: '1.1',
      lastModified: new Date().toISOString(),
      apiKeyStorage: 'reference',
    },
  };
  const tempFilePath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tempFilePath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows / 只读文件系统忽略 POSIX 权限位。
  }
}

/**
 * 添加或更新自定义模型
 * 如果 displayName 已存在则更新，否则添加
 */
export function addOrUpdateCustomModel(model: CustomModelConfig): void {
  const models = loadCustomModels();
  const existingIndex = models.findIndex(m => m.displayName === model.displayName);

  if (existingIndex >= 0) {
    models[existingIndex] = model;
  } else {
    models.push(model);
  }

  saveCustomModels(models);
}

/**
 * 删除自定义模型
 * @param modelId 格式: custom:{displayName}
 */
export function deleteCustomModel(modelId: string): boolean {
  const models = loadCustomModels();
  const displayName = modelId.replace('custom:', '');
  const filteredModels = models.filter(m => m.displayName !== displayName);

  if (filteredModels.length === models.length) {
    return false; // 没有找到要删除的模型
  }

  saveCustomModels(filteredModels);
  return true;
}

/**
 * 获取单个自定义模型配置
 * @param modelId 格式: custom:{displayName}
 */
export function getCustomModel(modelId: string): CustomModelConfig | undefined {
  const models = loadCustomModels();
  const displayName = modelId.replace('custom:', '');
  return models.find(m => m.displayName === displayName);
}

/**
 * 检查自定义模型是否已存在
 * @param modelId 格式: custom:{displayName}
 */
export function customModelExists(modelId: string): boolean {
  const models = loadCustomModels();
  const displayName = modelId.replace('custom:', '');
  return models.some(m => m.displayName === displayName);
}
