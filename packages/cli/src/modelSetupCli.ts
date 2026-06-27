/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 非交互式模型配置：`otto setup --provider <p> --model <m> --key <k>`。
 *
 * 为什么需要它：交互式向导依赖终端粘贴（bracketed/rapid-paste 检测），在部分
 * 终端 / Windows / SSH 下不稳，导致 API key 粘不进去、配置存成空 key → 401。
 * 这条命令让用户把一整行命令粘进 shell（shell 粘贴在任何系统都稳），一步写好
 * 配置并设为默认模型，完全绕开 TUI 输入。
 *
 * 抄自 opencode 的两点：
 *   1. 供应商 / 模型清单、接口地址全部来自 models.dev 目录（modelsDevCatalog）。
 *   2. API key 默认写进一个 0600 加密文件，配置里只存 {file:...} 引用，
 *      key 不落进 custom-models.json，且永远不必经过 TUI 粘贴。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, SettingScope } from './config/settings.js';
import { addOrUpdateCustomModel } from './config/customModelsStorage.js';
import {
  loadModelsDevCatalog,
  findProvider,
  type CatalogProvider,
} from './config/modelsDevCatalog.js';
import {
  generateCustomModelId,
  validateCustomModelConfig,
  type CustomModelConfig,
  type CustomModelProvider,
} from 'otto-core';

export interface NonInteractiveModelSetupOpts {
  provider?: string;
  key?: string;
  model?: string;
  name?: string;
  baseUrl?: string;
  /** --key-env VAR：key 从环境变量读，配置存 {env:VAR}。 */
  keyEnv?: string;
  /** --key-file PATH：key 从文件读，配置存 {file:PATH}。 */
  keyFile?: string;
  /** --list：列出常用供应商。 */
  list?: boolean;
  /** --models <provider>：列出某供应商的模型。 */
  listModels?: string;
  workspaceRoot?: string;
}

type SetupResult = { text: string; code: number };

const err = (text: string): SetupResult => ({ text, code: 1 });
const ok = (text: string): SetupResult => ({ text, code: 0 });

/** 把 key 写进 ~/.otto-user/secrets/<provider>（0600），返回路径。 */
function writeSecretFile(providerId: string, key: string): string {
  const dir = join(homedir(), '.otto-user', 'secrets');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = providerId.replace(/[^\w.-]/g, '_') || 'model';
  const path = join(dir, safe);
  writeFileSync(path, key.trim() + '\n', { mode: 0o600 });
  return path;
}

function listProviders(providers: CatalogProvider[]): SetupResult {
  // 优先把常用的几家排前面，其余按名称
  const PRIORITY = ['zhipuai', 'deepseek', 'moonshotai', 'siliconflow', 'openai', 'openrouter', 'anthropic'];
  const head = PRIORITY.map((id) => providers.find((p) => p.id === id)).filter(
    (p): p is CatalogProvider => !!p,
  );
  const lines = [
    `共 ${providers.length} 家供应商（来自 models.dev）。常用：`,
    ...head.map((p) => `  ${p.id.padEnd(14)} ${p.name}  (${p.models.length} 个模型)`),
    '',
    '用法：otto setup --provider <id> --model <模型> --key <你的KEY>',
    '看某家的模型：otto setup --models <id>，例如 otto setup --models zhipuai',
  ];
  return ok(lines.join('\n'));
}

function listModels(providers: CatalogProvider[], query: string): SetupResult {
  const prov = findProvider(providers, query);
  if (!prov) {
    return err(`找不到供应商「${query}」。用 otto setup --list 看清单。`);
  }
  const lines = [
    `${prov.name}（${prov.id}）的模型，接口地址 ${prov.api}：`,
    ...prov.models.map(
      (m) =>
        `  ${m.id.padEnd(28)} ${m.name}${m.reasoning ? '  [推理]' : ''}${m.toolCall ? '  [工具]' : ''}`,
    ),
    '',
    `配置：otto setup --provider ${prov.id} --model <上面的模型id> --key <你的KEY>`,
  ];
  return ok(lines.join('\n'));
}

export async function runNonInteractiveModelSetup(
  opts: NonInteractiveModelSetupOpts,
): Promise<SetupResult> {
  const providers = await loadModelsDevCatalog();

  if (opts.list) return listProviders(providers);
  if (opts.listModels) return listModels(providers, opts.listModels);

  if (!opts.provider) {
    return err('缺少 --provider <供应商>，例如 --provider zhipuai。用 otto setup --list 看清单。');
  }
  if (!opts.model) {
    return err('缺少 --model <模型>。用 otto setup --models ' + opts.provider + ' 看该供应商的可用模型。');
  }

  const prov = findProvider(providers, opts.provider);
  const baseUrl = (opts.baseUrl || prov?.api || '').replace(/\/+$/, '');
  const protocol: CustomModelProvider = (prov?.protocol ?? 'openai') as CustomModelProvider;

  if (!baseUrl) {
    return err(
      `找不到「${opts.provider}」的接口地址。用 otto setup --list 看支持的供应商，或加 --base-url <接口地址>。`,
    );
  }

  // key 来源：--key-file > --key-env > --key（写加密文件）> 供应商默认环境变量
  let apiKeyRef: string;
  let keyNote: string;
  if (opts.keyFile) {
    apiKeyRef = `{file:${opts.keyFile}}`;
    keyNote = `key 从文件读：${opts.keyFile}`;
  } else if (opts.keyEnv) {
    apiKeyRef = `{env:${opts.keyEnv}}`;
    keyNote = `key 从环境变量读：${opts.keyEnv}`;
  } else if (opts.key) {
    const secretPath = writeSecretFile(prov?.id || opts.provider, opts.key);
    apiKeyRef = `{file:${secretPath}}`;
    keyNote = `key 已写入加密文件（0600）：${secretPath}`;
  } else if (prov?.envVar) {
    apiKeyRef = `{env:${prov.envVar}}`;
    keyNote = `未给 --key，将读环境变量 ${prov.envVar}（请确保已设置，否则会 401）`;
  } else {
    return err('缺少 key：用 --key <KEY>（自动存进加密文件），或 --key-env <环境变量名>。');
  }

  const cfg: CustomModelConfig = {
    displayName: opts.name || `${prov?.name || opts.provider} ${opts.model}`,
    provider: protocol,
    baseUrl,
    apiKey: apiKeyRef,
    modelId: opts.model,
    maxTokens: 128000,
    enabled: true,
  };

  const errors = validateCustomModelConfig(cfg);
  if (errors.length > 0) {
    return err('配置无效: ' + errors.join(', '));
  }

  // 模型不在目录里只提示，不拦截（目录可能滞后于供应商上新）
  const modelKnown = prov?.models.some((m) => m.id === opts.model);
  const warn =
    prov && !modelKnown
      ? `\n   ⚠️ 「${opts.model}」不在 ${prov.id} 的已知模型清单里，已照样配置（若报错请用 otto setup --models ${prov.id} 核对模型名）。`
      : '';

  try {
    addOrUpdateCustomModel(cfg);
    const id = generateCustomModelId(cfg);
    const settings = loadSettings(opts.workspaceRoot || process.cwd());
    settings.setValue(SettingScope.User, 'preferredModel', id);
    return ok(
      [
        `✅ 已配置并设为默认模型：${cfg.displayName}`,
        `   协议 ${protocol}   接口 ${baseUrl}   模型 ${opts.model}`,
        `   ${keyNote}`,
        `   直接运行 otto 即用它（模型 id: ${id}）。${warn}`,
      ].join('\n'),
    );
  } catch (e) {
    return err('写入配置失败: ' + ((e as Error)?.message || String(e)));
  }
}
