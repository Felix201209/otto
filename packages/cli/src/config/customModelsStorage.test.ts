/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomModelConfig } from 'otto-core';

import {
  getCustomModelsFilePath,
  loadCustomModels,
  saveCustomModels,
  writeSecretFile,
} from './customModelsStorage.js';

const isWindows = process.platform === 'win32';

/** 断言文件/目录权限（Windows 上无 POSIX 权限位，跳过）。 */
function expectMode(targetPath: string, mode: number): void {
  if (isWindows) return;
  expect(fs.statSync(targetPath).mode & 0o777).toBe(mode);
}

function makeModel(overrides: Partial<CustomModelConfig> = {}): CustomModelConfig {
  return {
    displayName: 'Test GLM',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-plaintext-secret-123',
    modelId: 'glm-5.1',
    maxTokens: 128000,
    enabled: true,
    ...overrides,
  };
}

describe('customModelsStorage', () => {
  // 用 OTTO_USER_DIR 把配置目录重定向到临时目录，避免测试写到真实 ~/.otto-user。
  // 注意不要用 os.homedir() mock：vitest threads 池下 builtin mock / HOME 均不生效。
  let ottoDir: string;

  beforeEach(() => {
    ottoDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'otto-cms-test-')),
      '.otto-user',
    );
    vi.stubEnv('OTTO_USER_DIR', ottoDir);
    // 保险丝：目录重定向必须生效，否则立刻失败，绝不写真实用户目录
    if (!getCustomModelsFilePath().startsWith(ottoDir)) {
      throw new Error(
        `OTTO_USER_DIR redirection failed: ${getCustomModelsFilePath()}`,
      );
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(ottoDir), { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('writeSecretFile', () => {
    it('写入 0600 secret 文件、目录 0700，内容为 key + 换行', () => {
      const secretPath = writeSecretFile('zhipuai', '  sk-abc-123  ');

      expect(secretPath).toMatch(
        new RegExp(`^${path.join(ottoDir, 'secrets', 'zhipuai')}\\.[a-f0-9]{12}\\.[a-f0-9]{24}$`),
      );
      expect(fs.readFileSync(secretPath, 'utf-8')).toBe('sk-abc-123\n');
      expectMode(secretPath, 0o600);
      expectMode(path.dirname(secretPath), 0o700);
    });

    it('文件名里的特殊字符被替换为下划线', () => {
      const secretPath = writeSecretFile('My Model/v2', 'sk-x');
      expect(path.basename(secretPath)).toMatch(/^My_Model_v2\.[a-f0-9]{12}\.[a-f0-9]{24}$/);
    });

    it('清洗后同名的模型使用不同 secret 文件，密钥不会互相覆盖', () => {
      const slashPath = writeSecretFile('Acme/Model', 'sk-slash');
      const underscorePath = writeSecretFile('Acme_Model', 'sk-underscore');

      expect(slashPath).not.toBe(underscorePath);
      expect(fs.readFileSync(slashPath, 'utf-8').trim()).toBe('sk-slash');
      expect(fs.readFileSync(underscorePath, 'utf-8').trim()).toBe('sk-underscore');
    });

    it('同一显示名的新 key 使用不同版本路径且不覆盖旧内容', () => {
      const oldPath = writeSecretFile('Versioned', 'sk-old');
      const newPath = writeSecretFile('Versioned', 'sk-new');

      expect(newPath).not.toBe(oldPath);
      expect(fs.readFileSync(oldPath, 'utf-8').trim()).toBe('sk-old');
      expect(fs.readFileSync(newPath, 'utf-8').trim()).toBe('sk-new');
    });
  });

  describe('saveCustomModels 明文 key 收口', () => {
    it('明文 apiKey 落盘前转成 {file:...} 引用，配置文件里无明文 key', () => {
      const plaintextKey = 'sk-plaintext-secret-123';
      saveCustomModels([makeModel({ apiKey: plaintextKey })]);

      const filePath = getCustomModelsFilePath();
      const raw = fs.readFileSync(filePath, 'utf-8');

      // 配置文件里绝不出现明文 key
      expect(raw).not.toContain(plaintextKey);

      const parsed = JSON.parse(raw);
      const savedKey: string = parsed.models[0].apiKey;
      expect(savedKey).toMatch(/^\{file:.+\}$/);

      // secret 文件内容就是明文 key，且权限 0600
      const secretPath = savedKey.slice('{file:'.length, -1);
      expect(fs.readFileSync(secretPath, 'utf-8').trim()).toBe(plaintextKey);
      expectMode(secretPath, 0o600);
    });

    it('保存后 custom-models.json 为 0600、目录为 0700', () => {
      saveCustomModels([makeModel()]);

      const filePath = getCustomModelsFilePath();
      expectMode(filePath, 0o600);
      expectMode(path.dirname(filePath), 0o700);
    });

    it('已是 {env:...} / {file:...} / $VAR / ${VAR} 引用的 apiKey 原样保留', () => {
      saveCustomModels([
        makeModel({ displayName: 'env-ref', modelId: 'env-model', apiKey: '{env:ZHIPU_API_KEY}' }),
        makeModel({ displayName: 'file-ref', modelId: 'file-model', apiKey: '{file:~/.otto-user/secrets/glm}' }),
        makeModel({ displayName: 'codex', modelId: 'codex-model', apiKey: '${CODEX_OAUTH}' }),
        makeModel({ displayName: 'legacy-env', modelId: 'legacy-model', apiKey: '$LEGACY_API_KEY' }),
      ]);

      const parsed = JSON.parse(fs.readFileSync(getCustomModelsFilePath(), 'utf-8'));
      const keys = parsed.models.map((m: CustomModelConfig) => m.apiKey);
      expect(keys).toEqual([
        '{env:ZHIPU_API_KEY}',
        '{file:~/.otto-user/secrets/glm}',
        '${CODEX_OAUTH}',
        '$LEGACY_API_KEY',
      ]);
    });

    it('仅整串 $VAR 才是引用，包含 $NAME 片段的真实 key 仍迁入 secret 文件', () => {
      const plaintextKey = 'sk-live-$ABC-suffix';
      saveCustomModels([makeModel({ displayName: 'dollar-key', apiKey: plaintextKey })]);

      const parsed = JSON.parse(fs.readFileSync(getCustomModelsFilePath(), 'utf-8'));
      const savedKey: string = parsed.models[0].apiKey;
      expect(savedKey).toMatch(/^\{file:.+\}$/);
      expect(fs.readFileSync(savedKey.slice('{file:'.length, -1), 'utf-8').trim())
        .toBe(plaintextKey);
      expect(fs.readFileSync(getCustomModelsFilePath(), 'utf-8')).not.toContain(plaintextKey);
    });

    it('共享配置不允许不同显示名写成同一个协议模型 ID', () => {
      expect(() => saveCustomModels([
        makeModel({ displayName: 'Primary', apiKey: 'sk-primary' }),
        makeModel({ displayName: 'Alias', apiKey: 'sk-alias' }),
      ])).toThrow(/模型标识.*重复/);

      expect(fs.existsSync(getCustomModelsFilePath())).toBe(false);
      expect(fs.existsSync(path.join(ottoDir, 'secrets'))).toBe(false);
    });

    it('save 后 load 回来的配置 apiKey 是引用且模型信息不变', () => {
      saveCustomModels([makeModel()]);
      const loaded = loadCustomModels();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].displayName).toBe('Test GLM');
      expect(loaded[0].modelId).toBe('glm-5.1');
      expect(loaded[0].apiKey).toMatch(/^\{file:.+\}$/);
    });

    it('同名模型更新时配置写失败，不覆盖旧配置引用或旧 secret 内容', () => {
      saveCustomModels([makeModel({ displayName: 'Atomic', apiKey: 'sk-old' })]);
      const configPath = getCustomModelsFilePath();
      const before = fs.readFileSync(configPath, 'utf-8');
      const oldReference = loadCustomModels()[0].apiKey;
      const oldSecretPath = oldReference.slice('{file:'.length, -1);

      // persistCustomModels 固定先写进程级临时路径；用目录占位稳定模拟写失败。
      fs.mkdirSync(`${configPath}.tmp-${process.pid}`);

      expect(() => saveCustomModels([
        makeModel({
          displayName: 'Atomic',
          baseUrl: 'https://new.example.com/v1',
          apiKey: 'sk-new',
        }),
      ])).toThrow();
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
      expect(loadCustomModels()[0].apiKey).toBe(oldReference);
      expect(fs.readFileSync(oldSecretPath, 'utf-8').trim()).toBe('sk-old');
    });
  });

  describe('向后兼容：已存在的明文 apiKey 配置', () => {
    it('loadCustomModels 自动迁移明文 key 到 secrets 并重写为引用', () => {
      const filePath = getCustomModelsFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ models: [makeModel({ apiKey: 'sk-legacy-plain' })] }),
        { encoding: 'utf-8', mode: 0o644 },
      );

      const loaded = loadCustomModels();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].apiKey).toMatch(/^\{file:.+\}$/);
      const migratedPath = loaded[0].apiKey.slice('{file:'.length, -1);
      expect(fs.readFileSync(migratedPath, 'utf8').trim()).toBe('sk-legacy-plain');
      expect(fs.readFileSync(filePath, 'utf8')).not.toContain('sk-legacy-plain');
      expectMode(filePath, 0o600);
      expectMode(migratedPath, 0o600);
    });
  });
});
