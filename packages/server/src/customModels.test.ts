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

  it('读取旧版明文 key 时就地迁移到 0600 secret，配置仅留引用且也是 0600', () => {
    writeModelsFile(JSON.stringify({
      models: [{ ...VALID_MODEL, apiKey: 'legacy-plain-secret' }],
      _metadata: { preferredModel: 'custom:openai:gpt-4o@https://api.openai.com/v1' },
    }));
    const configPath = customModelsFilePath();
    fs.chmodSync(configPath, 0o644);

    const models = loadCustomModels();
    const secretPath = models[0].apiKey.match(/^\{file:(.+)\}$/)?.[1];

    expect(secretPath).toBeTruthy();
    expect(fs.readFileSync(secretPath!, 'utf-8').trim()).toBe('legacy-plain-secret');
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('legacy-plain-secret');
    expect(fs.statSync(secretPath!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(loadPreferredModel()).toBe(
      'custom:openai:gpt-4o@https://api.openai.com/v1',
    );
  });

  it('已经使用 key 引用的旧松散权限配置，读取时也收紧到 0600', () => {
    writeModelsFile(JSON.stringify({
      models: [{ ...VALID_MODEL, apiKey: '{env:OTTO_API_KEY}' }],
    }));
    fs.chmodSync(customModelsFilePath(), 0o666);

    expect(loadCustomModels()).toHaveLength(1);
    expect(fs.statSync(customModelsFilePath()).mode & 0o777).toBe(0o600);
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

describe('saveCustomModel Codex OAuth', () => {
  it('OAuth 哨兵不是密钥，保存时原样保留而不包装成 secret 文件引用', () => {
    saveCustomModel({
      displayName: 'Codex (ChatGPT OAuth)',
      provider: 'openai-responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: '${CODEX_OAUTH}',
      modelId: 'gpt-5.6-sol',
    });

    expect(loadCustomModels()[0].apiKey).toBe('${CODEX_OAUTH}');
    expect(fs.existsSync(path.join(tmpHome, '.otto-user', 'secrets'))).toBe(false);
  });

  it('旧式 $VAR 引用原样保留，不被当成明文写入 secret 文件', () => {
    saveCustomModel({ ...VALID_MODEL, displayName: 'Legacy env', apiKey: '$OTTO_API_KEY' });

    expect(loadCustomModels()[0].apiKey).toBe('$OTTO_API_KEY');
    expect(fs.existsSync(path.join(tmpHome, '.otto-user', 'secrets'))).toBe(false);
  });

  it('仅整串 $VAR 才是引用，包含 $NAME 片段的真实 key 仍迁入 secret 文件', () => {
    const plaintextKey = 'sk-live-$ABC-suffix';
    saveCustomModel({ ...VALID_MODEL, displayName: 'Dollar key', apiKey: plaintextKey });

    const savedKey = loadCustomModels()[0].apiKey;
    const secretPath = savedKey.match(/^\{file:(.+)\}$/)?.[1];
    expect(secretPath).toBeTruthy();
    expect(fs.readFileSync(secretPath!, 'utf-8').trim()).toBe(plaintextKey);
    expect(fs.readFileSync(customModelsFilePath(), 'utf-8')).not.toContain(plaintextKey);
  });

  it('清洗后同名的模型使用不同 secret 文件，密钥不会互相覆盖', () => {
    saveCustomModel({
      ...VALID_MODEL,
      displayName: 'Acme/Model',
      modelId: 'slash-model',
      apiKey: 'sk-slash',
    });
    saveCustomModel({
      ...VALID_MODEL,
      displayName: 'Acme_Model',
      modelId: 'underscore-model',
      apiKey: 'sk-underscore',
    });

    const [slash, underscore] = loadCustomModels();
    const slashPath = slash.apiKey.match(/^\{file:(.+)\}$/)?.[1];
    const underscorePath = underscore.apiKey.match(/^\{file:(.+)\}$/)?.[1];
    expect(slashPath).toBeTruthy();
    expect(underscorePath).toBeTruthy();
    expect(slashPath).not.toBe(underscorePath);
    expect(fs.readFileSync(slashPath!, 'utf-8').trim()).toBe('sk-slash');
    expect(fs.readFileSync(underscorePath!, 'utf-8').trim()).toBe('sk-underscore');
  });

  it('不同显示名不能保存成同一个协议模型 ID，失败前不写第二份密钥', () => {
    const id = saveCustomModel({ ...VALID_MODEL, displayName: 'Primary', apiKey: 'sk-primary' });
    const primaryPath = loadCustomModels()[0].apiKey.match(/^\{file:(.+)\}$/)?.[1];

    expect(() => saveCustomModel({
      ...VALID_MODEL,
      displayName: 'Alias',
      apiKey: 'sk-alias',
    })).toThrow(/模型标识.*已存在/);
    expect(loadCustomModels()).toHaveLength(1);
    expect(loadCustomModels()[0].displayName).toBe('Primary');
    expect(fs.readFileSync(primaryPath!, 'utf-8').trim()).toBe('sk-primary');
    expect(listModelInfos().map((model) => model.id)).toEqual([id]);
  });

  it('同名模型更新时配置写失败，不覆盖旧配置引用或旧 secret 内容', () => {
    saveCustomModel({ ...VALID_MODEL, displayName: 'Atomic', apiKey: 'sk-old' });
    const configPath = customModelsFilePath();
    const before = fs.readFileSync(configPath, 'utf-8');
    const oldReference = loadCustomModels()[0].apiKey;
    const oldSecretPath = oldReference.match(/^\{file:(.+)\}$/)?.[1];
    expect(oldSecretPath).toBeTruthy();

    // saveCustomModels 固定先写 <config>.tmp；用目录占位，稳定模拟磁盘/权限写失败。
    fs.mkdirSync(configPath + '.tmp');

    expect(() => saveCustomModel({
      ...VALID_MODEL,
      displayName: 'Atomic',
      baseUrl: 'https://new.example.com/v1',
      apiKey: 'sk-new',
    })).toThrow();
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(loadCustomModels()[0].apiKey).toBe(oldReference);
    expect(fs.readFileSync(oldSecretPath!, 'utf-8').trim()).toBe('sk-old');
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

  it('旧配置若存在重复协议模型 ID，删除操作 fail closed 而不会一次删多条', () => {
    writeModelsFile(JSON.stringify({
      models: [
        { ...VALID_MODEL, displayName: 'Legacy A', apiKey: '{env:KEY_A}' },
        { ...VALID_MODEL, displayName: 'Legacy B', apiKey: '{env:KEY_B}' },
      ],
    }));
    const before = fs.readFileSync(customModelsFilePath(), 'utf-8');
    const duplicateId = listModelInfos()[0].id;

    expect(() => deleteCustomModel(duplicateId)).toThrow(/模型标识冲突/);
    expect(fs.readFileSync(customModelsFilePath(), 'utf-8')).toBe(before);
    expect(loadCustomModels()).toHaveLength(2);
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
    const newKey = loadCustomModels()[0].apiKey;
    expect(newKey).not.toBe(oldKey);
    const oldSecretPath = oldKey.match(/^\{file:(.+)\}$/)?.[1];
    const newSecretPath = newKey.match(/^\{file:(.+)\}$/)?.[1];
    expect(oldSecretPath && fs.readFileSync(oldSecretPath, 'utf-8').trim()).toBe('sk-test');
    expect(newSecretPath && fs.readFileSync(newSecretPath, 'utf-8').trim()).toBe('sk-new');
    expect(() =>
      replaceCustomModel('custom:missing', { ...VALID_MODEL, apiKey: '' }, false),
    ).toThrow(/不存在/);
    expect(loadCustomModels()).toHaveLength(1);
  });

  it('改名或模型身份撞到另一条时在写密钥前 fail closed', () => {
    const firstId = saveCustomModel({
      ...VALID_MODEL,
      displayName: 'First',
      modelId: 'first-model',
      apiKey: 'sk-first',
    });
    saveCustomModel({
      ...VALID_MODEL,
      displayName: 'Second',
      modelId: 'second-model',
      apiKey: 'sk-second',
    });
    const before = loadCustomModels();
    const secondSecret = before[1].apiKey.match(/^\{file:(.+)\}$/)?.[1];

    expect(() => replaceCustomModel(firstId, {
      ...VALID_MODEL,
      displayName: 'Second',
      modelId: 'second-model',
      apiKey: 'sk-attacker',
    })).toThrow(/显示名称.*已存在|模型标识.*已存在/);
    expect(fs.readFileSync(secondSecret!, 'utf-8').trim()).toBe('sk-second');
    expect(loadCustomModels().map((model) => model.displayName)).toEqual(['First', 'Second']);
  });
});
