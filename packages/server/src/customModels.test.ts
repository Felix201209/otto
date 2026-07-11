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
  deleteCustomModel,
  loadPreferredModel,
  replaceCustomModel,
  saveCustomModel,
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

describe('deleteCustomModel', () => {
  it('按 ModelInfo id 删除命中的模型并重写文件', () => {
    const idA = saveCustomModel({ ...VALID_MODEL, displayName: 'A' }, false);
    const idB = saveCustomModel(
      { ...VALID_MODEL, displayName: 'B', modelId: 'gpt-4o-mini' },
      false,
    );
    expect(loadCustomModels()).toHaveLength(2);

    expect(deleteCustomModel(idA)).toBe(true);
    const rest = loadCustomModels();
    expect(rest).toHaveLength(1);
    expect(rest[0].displayName).toBe('B');
    // 幂等：再删同一个返回 false，文件不变。
    expect(deleteCustomModel(idA)).toBe(false);
    expect(loadCustomModels()).toHaveLength(1);
    void idB;
  });

  it('删除当前生效模型（preferredModel）时一并清除偏好', () => {
    const id = saveCustomModel({ ...VALID_MODEL, displayName: 'P' }, true);
    expect(loadPreferredModel()).toBe(id);
    expect(deleteCustomModel(id)).toBe(true);
    expect(loadPreferredModel()).toBeUndefined();
  });

  it('删除非生效模型时保留既有 preferredModel', () => {
    const keep = saveCustomModel({ ...VALID_MODEL, displayName: 'Keep' }, true);
    const drop = saveCustomModel(
      { ...VALID_MODEL, displayName: 'Drop', modelId: 'gpt-4o-mini' },
      false,
    );
    expect(deleteCustomModel(drop)).toBe(true);
    expect(loadPreferredModel()).toBe(keep);
  });
});

describe('replaceCustomModel', () => {
  it('按旧 id 原位替换全部字段，空 key 保留旧 secret 引用', () => {
    const oldId = saveCustomModel({ ...VALID_MODEL, maxTokens: 128000 }, true);
    const oldKey = loadCustomModels()[0].apiKey;

    const newId = replaceCustomModel(
      oldId,
      {
        displayName: 'Renamed GLM',
        provider: 'openai-responses',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: '',
        modelId: 'glm-5',
        maxTokens: 200000,
        enabled: false,
      },
      false,
    );

    const models = loadCustomModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      displayName: 'Renamed GLM',
      provider: 'openai-responses',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: oldKey,
      modelId: 'glm-5',
      maxTokens: 200000,
      enabled: false,
    });
    expect(newId).not.toBe(oldId);
    expect(loadPreferredModel()).toBe(newId);
  });

  it('提供新 key 时替换 secret，未知旧 id 不写盘', () => {
    const oldId = saveCustomModel(VALID_MODEL, false);
    const oldKey = loadCustomModels()[0].apiKey;
    replaceCustomModel(oldId, { ...VALID_MODEL, apiKey: 'sk-new' }, false);
    expect(loadCustomModels()[0].apiKey).toBe(oldKey);
    const secretPath = oldKey.match(/^\{file:(.+)\}$/)?.[1];
    expect(secretPath && fs.readFileSync(secretPath, 'utf-8').trim()).toBe('sk-new');
    expect(() =>
      replaceCustomModel('custom:missing', { ...VALID_MODEL, apiKey: '' }, false),
    ).toThrow(/不存在/);
    expect(loadCustomModels()).toHaveLength(1);
  });
});
