/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 桌面端搜索 API 配置：公开字段进 ~/.otto-user/settings.json，API Key 按
 * provider 拆到 0600 secret 文件。对 renderer 只暴露 hasApiKey，绝不回传原文。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSearchProvider } from 'otto-core';
import { loadUserSettingsSubset, patchUserSettings } from './userSettings.js';

export const DEFAULT_VOLCENGINE_SEARCH_API_URL =
  'https://ark.cn-beijing.volces.com/api/v3/responses';
export const DEFAULT_VOLCENGINE_SEARCH_MODEL =
  'doubao-seed-2-0-lite-260215';

export interface SearchConfigView {
  provider: WebSearchProvider;
  apiUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface SaveSearchConfigInput {
  provider: WebSearchProvider;
  apiUrl?: string;
  model?: string;
  /** 空字符串表示保留已有密钥。 */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface SearchRuntimeConfig {
  provider: WebSearchProvider;
  apiUrl?: string;
  model?: string;
  apiKey?: string;
}

function secretsDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.otto-user', 'secrets');
}

export function searchApiKeyFilePath(
  provider: WebSearchProvider,
  homeDir = os.homedir(),
): string {
  return path.join(secretsDir(homeDir), `search-${provider}-api-key`);
}

function readSecret(provider: WebSearchProvider, homeDir: string): string | undefined {
  try {
    const value = fs.readFileSync(searchApiKeyFilePath(provider, homeDir), 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeSecret(
  provider: WebSearchProvider,
  value: string,
  homeDir: string,
): void {
  const dir = secretsDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = searchApiKeyFilePath(provider, homeDir);
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function loadSearchRuntimeConfig(
  homeDir = os.homedir(),
): SearchRuntimeConfig {
  const settings = loadUserSettingsSubset(homeDir);
  const provider = settings.searchProvider ?? 'bing';
  return {
    provider,
    apiUrl: settings.searchApiUrl,
    model: settings.searchModel,
    apiKey:
      readSecret(provider, homeDir) ??
      settings.searchApiKey ??
      (provider === 'volcengine'
        ? process.env.ARK_API_KEY
        : provider === 'bocha'
          ? process.env.OTTO_BOCHA_API_KEY
          : undefined),
  };
}

export function loadSearchConfigView(homeDir = os.homedir()): SearchConfigView {
  const runtime = loadSearchRuntimeConfig(homeDir);
  return {
    provider: runtime.provider,
    apiUrl:
      runtime.apiUrl ??
      (runtime.provider === 'volcengine' ? DEFAULT_VOLCENGINE_SEARCH_API_URL : ''),
    model:
      runtime.model ??
      (runtime.provider === 'volcengine' ? DEFAULT_VOLCENGINE_SEARCH_MODEL : ''),
    hasApiKey: Boolean(runtime.apiKey),
  };
}

export function saveSearchConfig(
  input: SaveSearchConfigInput,
  homeDir = os.homedir(),
): SearchConfigView {
  const apiUrl = input.apiUrl?.trim() || undefined;
  const model = input.model?.trim() || undefined;
  patchUserSettings(
    {
      searchProvider: input.provider,
      searchApiUrl: apiUrl,
      searchModel: model,
      // 旧版 CLI 曾允许明文落盘；一旦经新入口保存就完成迁移并删掉旧字段。
      searchApiKey: undefined,
    },
    homeDir,
  );

  const secretPath = searchApiKeyFilePath(input.provider, homeDir);
  if (input.clearApiKey) {
    try {
      fs.rmSync(secretPath);
    } catch {
      // 本来就没有密钥时清除仍视为成功。
    }
  } else if (input.apiKey?.trim()) {
    writeSecret(input.provider, input.apiKey.trim(), homeDir);
  }
  return loadSearchConfigView(homeDir);
}
