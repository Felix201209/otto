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
import type { SearchProviderRuntimeConfig, WebSearchProvider } from 'otto-core';
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
  costPerRequestCny?: number;
  configuredProviders: WebSearchProvider[];
  monthlyRequestQuota?: number;
  monthlyBudgetCny?: number;
}

export interface SaveSearchConfigInput {
  provider: WebSearchProvider;
  apiUrl?: string;
  model?: string;
  /** 空字符串表示保留已有密钥。 */
  apiKey?: string;
  clearApiKey?: boolean;
  costPerRequestCny?: number;
  monthlyRequestQuota?: number;
  monthlyBudgetCny?: number;
}

export interface SearchRuntimeConfig {
  provider: WebSearchProvider;
  apiUrl?: string;
  model?: string;
  apiKey?: string;
  providerConfigs: Partial<
    Record<WebSearchProvider, SearchProviderRuntimeConfig>
  >;
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
  const bochaApiKey =
    readSecret('bocha', homeDir) ?? process.env.OTTO_BOCHA_API_KEY;
  const volcengineApiKey =
    readSecret('volcengine', homeDir) ?? process.env.ARK_API_KEY;
  const volcengineApiUrl =
    settings.searchApiUrl ?? DEFAULT_VOLCENGINE_SEARCH_API_URL;
  const volcengineModel =
    settings.searchModel ??
    process.env.OTTO_SEARCH_MODEL ??
    DEFAULT_VOLCENGINE_SEARCH_MODEL;
  const providerConfigs: SearchRuntimeConfig['providerConfigs'] = {
    bing: {
      costPerRequestCny: settings.searchProviderCostsCny?.bing,
    },
    gemini: {
      costPerRequestCny: settings.searchProviderCostsCny?.gemini,
    },
    bocha: {
      apiKey: bochaApiKey,
      costPerRequestCny: settings.searchProviderCostsCny?.bocha,
    },
    volcengine: {
      apiKey: volcengineApiKey,
      apiUrl: volcengineApiUrl,
      model: volcengineModel,
      costPerRequestCny: settings.searchProviderCostsCny?.volcengine,
    },
  };
  return {
    provider,
    apiUrl:
      provider === 'volcengine' ? volcengineApiUrl : settings.searchApiUrl,
    model: provider === 'volcengine' ? volcengineModel : settings.searchModel,
    apiKey:
      providerConfigs[provider]?.apiKey ?? settings.searchApiKey ?? undefined,
    providerConfigs,
  };
}

export function loadSearchConfigView(homeDir = os.homedir()): SearchConfigView {
  const runtime = loadSearchRuntimeConfig(homeDir);
  return {
    provider: runtime.provider,
    apiUrl:
      runtime.apiUrl ??
      (runtime.provider === 'volcengine'
        ? DEFAULT_VOLCENGINE_SEARCH_API_URL
        : ''),
    model:
      runtime.model ??
      (runtime.provider === 'volcengine'
        ? DEFAULT_VOLCENGINE_SEARCH_MODEL
        : ''),
    hasApiKey: Boolean(runtime.apiKey),
    costPerRequestCny:
      runtime.providerConfigs[runtime.provider]?.costPerRequestCny,
    configuredProviders: (
      ['bing', 'bocha', 'volcengine', 'gemini'] as WebSearchProvider[]
    ).filter(
      (provider) =>
        provider === 'bing' ||
        provider === 'gemini' ||
        Boolean(runtime.providerConfigs[provider]?.apiKey),
    ),
    monthlyRequestQuota:
      loadUserSettingsSubset(homeDir).searchMonthlyRequestQuota,
    monthlyBudgetCny: loadUserSettingsSubset(homeDir).searchMonthlyBudgetCny,
  };
}

export function saveSearchConfig(
  input: SaveSearchConfigInput,
  homeDir = os.homedir(),
): SearchConfigView {
  const apiUrl = input.apiUrl?.trim() || undefined;
  const model = input.model?.trim() || undefined;
  const current = loadUserSettingsSubset(homeDir);
  const costs = { ...(current.searchProviderCostsCny ?? {}) };
  if (
    typeof input.costPerRequestCny === 'number' &&
    Number.isFinite(input.costPerRequestCny) &&
    input.costPerRequestCny >= 0
  ) {
    costs[input.provider] = input.costPerRequestCny;
  }
  patchUserSettings(
    {
      searchProvider: input.provider,
      // 火山的接入点配置在切到其它 provider 后仍保留，供自动故障切换使用。
      searchApiUrl:
        input.provider === 'volcengine' ? apiUrl : current.searchApiUrl,
      searchModel:
        input.provider === 'volcengine' ? model : current.searchModel,
      searchProviderCostsCny: costs,
      searchMonthlyRequestQuota:
        typeof input.monthlyRequestQuota === 'number' &&
        Number.isFinite(input.monthlyRequestQuota) &&
        input.monthlyRequestQuota >= 0
          ? Math.floor(input.monthlyRequestQuota)
          : current.searchMonthlyRequestQuota,
      searchMonthlyBudgetCny:
        typeof input.monthlyBudgetCny === 'number' &&
        Number.isFinite(input.monthlyBudgetCny) &&
        input.monthlyBudgetCny >= 0
          ? input.monthlyBudgetCny
          : current.searchMonthlyBudgetCny,
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
