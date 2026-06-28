/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BYO-key 自定义模型只读加载单测。
 *
 * 全程用临时 HOME 隔离（spy os.homedir），绝不碰真实 ~/.otto-user。
 * 覆盖：文件缺失 / 非法 JSON / models 非数组 → []；注释 JSON 被救活；
 * 逐条校验跳过非法；listModelInfos 映射与 enabled 语义。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadCustomModels,
  listModelInfos,
  customModelsFilePath,
} from './customModels.js';

let tmpHome: string;

function writeModelsFile(raw: string): void {
  const dir = path.join(tmpHome, '.otto-user');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'custom-models.json'), raw, 'utf-8');
}

const VALID_MODEL = {
  displayName: 'My GPT',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  modelId: 'gpt-4o',
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-custommodels-'));
  // os.homedir() 读 HOME（POSIX）/ USERPROFILE（Win）。ESM 下命名空间不可 spy，
  // 故用 stubEnv 隔离到临时目录，绝不碰真实 ~/.otto-user。
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('customModelsFilePath', () => {
  it('指向临时 HOME 下的 .otto-user/custom-models.json', () => {
    expect(customModelsFilePath()).toBe(
      path.join(tmpHome, '.otto-user', 'custom-models.json'),
    );
  });
});

describe('loadCustomModels', () => {
  it('文件不存在 → []', () => {
    expect(loadCustomModels()).toEqual([]);
  });

  it('非法 JSON → []', () => {
    writeModelsFile('{ this is not json');
    expect(loadCustomModels()).toEqual([]);
  });

  it('models 非数组 → []', () => {
    writeModelsFile(JSON.stringify({ models: 'oops' }));
    expect(loadCustomModels()).toEqual([]);
  });

  it('缺 models 字段 → []', () => {
    writeModelsFile(JSON.stringify({ other: 1 }));
    expect(loadCustomModels()).toEqual([]);
  });

  it('合法单条 → 返回该条', () => {
    writeModelsFile(JSON.stringify({ models: [VALID_MODEL] }));
    const models = loadCustomModels();
    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe('My GPT');
  });

  it('带注释的 JSON 被 stripJsonCommentsLoose 救活', () => {
    const raw = `{
  // 这是用户手写的注释
  "models": [
    /* 块注释 */
    ${JSON.stringify(VALID_MODEL)}
  ]
}`;
    writeModelsFile(raw);
    const models = loadCustomModels();
    expect(models).toHaveLength(1);
    expect(models[0].provider).toBe('openai');
  });

  it('逐条校验：非法条目被跳过，只留合法', () => {
    const bad = { displayName: '', provider: 'nope', baseUrl: '', apiKey: '', modelId: '' };
    writeModelsFile(JSON.stringify({ models: [VALID_MODEL, bad] }));
    const models = loadCustomModels();
    expect(models).toHaveLength(1);
    expect(models[0].displayName).toBe('My GPT');
  });
});

describe('listModelInfos', () => {
  it('映射出 id/displayName/provider/enabled', () => {
    writeModelsFile(JSON.stringify({ models: [VALID_MODEL] }));
    const infos = listModelInfos();
    expect(infos).toHaveLength(1);
    expect(infos[0].displayName).toBe('My GPT');
    expect(infos[0].provider).toBe('openai');
    expect(infos[0].id.startsWith('custom:openai:gpt-4o@')).toBe(true);
    expect(infos[0].enabled).toBe(true);
  });

  it('enabled 缺省视为 true', () => {
    writeModelsFile(JSON.stringify({ models: [VALID_MODEL] }));
    expect(listModelInfos()[0].enabled).toBe(true);
  });

  it('enabled:false 被如实映射', () => {
    writeModelsFile(
      JSON.stringify({ models: [{ ...VALID_MODEL, enabled: false }] }),
    );
    expect(listModelInfos()[0].enabled).toBe(false);
  });

  it('空文件 → []', () => {
    expect(listModelInfos()).toEqual([]);
  });
});
