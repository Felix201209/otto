/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadSearchConfigView,
  loadSearchRuntimeConfig,
  saveSearchConfig,
  searchApiKeyFilePath,
} from './searchConfig.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-search-config-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('搜索 API 配置持久化', () => {
  it('公开配置写 settings.json，API Key 单独以 0600 保存且读取视图不泄漏', () => {
    saveSearchConfig(
      {
        provider: 'volcengine',
        apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
        model: 'doubao-seed-2-0-lite-260215',
        apiKey: 'ark-secret-key',
      },
      home,
    );

    const view = loadSearchConfigView(home);
    expect(view).toEqual({
      provider: 'volcengine',
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
      model: 'doubao-seed-2-0-lite-260215',
      hasApiKey: true,
      costPerRequestCny: undefined,
      configuredProviders: ['bing', 'volcengine', 'gemini'],
      monthlyRequestQuota: undefined,
      monthlyBudgetCny: undefined,
    });
    expect(view).not.toHaveProperty('apiKey');
    expect(loadSearchRuntimeConfig(home).apiKey).toBe('ark-secret-key');

    const secretPath = searchApiKeyFilePath('volcengine', home);
    if (process.platform !== 'win32') {
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(path.join(home, '.otto-user', 'settings.json'), 'utf8'))
      .not.toContain('ark-secret-key');
  });

  it('API Key 留空保留旧密钥；clearApiKey 才清除', () => {
    saveSearchConfig(
      { provider: 'volcengine', apiKey: 'first-key', model: 'doubao-model' },
      home,
    );
    saveSearchConfig(
      { provider: 'volcengine', apiKey: '', model: 'new-model' },
      home,
    );
    expect(loadSearchRuntimeConfig(home)).toMatchObject({
      apiKey: 'first-key',
      model: 'new-model',
    });

    saveSearchConfig(
      { provider: 'volcengine', model: 'new-model', clearApiKey: true },
      home,
    );
    expect(loadSearchConfigView(home).hasApiKey).toBe(false);
    expect(loadSearchRuntimeConfig(home).apiKey).toBeUndefined();
  });

  it('首次从旧版明文配置保存时迁移密钥并清除 settings.json 中的明文', () => {
    const settingsDir = path.join(home, '.otto-user');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        searchProvider: 'volcengine',
        searchApiKey: 'legacy-plaintext-key',
        unrelatedSetting: 'keep-me',
      }),
    );

    saveSearchConfig(
      {
        provider: 'volcengine',
        model: 'doubao-seed-2-0-lite-260215',
        apiKey: 'migrated-secret-key',
      },
      home,
    );

    const persisted = JSON.parse(
      fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('searchApiKey');
    expect(persisted.unrelatedSetting).toBe('keep-me');
    expect(loadSearchRuntimeConfig(home).apiKey).toBe('migrated-secret-key');
  });
});
