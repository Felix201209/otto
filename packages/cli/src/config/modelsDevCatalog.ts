/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * models.dev 模型目录（抄自 opencode）。
 *
 * opencode 的"选供应商 → 选模型"全靠 models.dev 的公开目录
 * （https://models.dev/api.json，约 145 家供应商 / 5000+ 模型，每家带
 * 接口地址 api、鉴权环境变量名 env、SDK 包名 npm 决定协议、以及完整模型清单）。
 * 本模块负责拉取 + 本地缓存 + 解析成 Otto 需要的结构，供模型配置向导与
 * 非交互式 `otto setup` 复用 —— 这样供应商和模型清单"给全"，接口地址自动补齐。
 *
 * 离线/首次无网时回退到内置常用供应商清单（下方 BUILTIN_PROVIDERS），保证可用。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_DIR = join(homedir(), '.otto-user');
const CACHE_FILE = join(CACHE_DIR, 'models-dev-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Otto 内部使用的协议名（与 CustomModelProvider 对应）。 */
export type CatalogProtocol =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

export interface CatalogModel {
  id: string;
  name: string;
  reasoning?: boolean;
  toolCall?: boolean;
}

export interface CatalogProvider {
  /** models.dev 里的供应商 id，例如 zhipuai / deepseek / moonshotai。 */
  id: string;
  /** 展示名，例如 "Zhipu AI"。 */
  name: string;
  /** 接口地址（baseUrl），例如 https://open.bigmodel.cn/api/paas/v4。 */
  api?: string;
  /** 该供应商约定的 API key 环境变量名，例如 ZHIPU_API_KEY。 */
  envVar?: string;
  /** Otto 调用时使用的协议。 */
  protocol: CatalogProtocol;
  /** 该供应商的模型清单。 */
  models: CatalogModel[];
}

/** 由 models.dev 的 npm 字段推断 Otto 协议。 */
function protocolFromNpm(npm?: string): CatalogProtocol {
  const s = (npm || '').toLowerCase();
  if (s.includes('anthropic')) return 'anthropic';
  if (s.includes('google') || s.includes('gemini')) return 'gemini';
  // @ai-sdk/openai-compatible、@ai-sdk/openai 及绝大多数 → OpenAI Chat 兼容协议。
  return 'openai';
}

/**
 * 内置兜底供应商（离线/首次无网时用）。仅含最常用的几家，接口地址均已实测。
 * 有网时会被 models.dev 的完整清单覆盖。
 */
const BUILTIN_PROVIDERS: CatalogProvider[] = [
  {
    id: 'zhipuai',
    name: 'Zhipu AI / 智谱 GLM',
    api: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    protocol: 'openai',
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1', reasoning: true, toolCall: true },
      { id: 'glm-5', name: 'GLM-5', toolCall: true },
      { id: 'glm-4.6', name: 'GLM-4.6', toolCall: true },
      { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash', toolCall: true },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'https://api.deepseek.com',
    envVar: 'DEEPSEEK_API_KEY',
    protocol: 'openai',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', toolCall: true },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true },
    ],
  },
  {
    id: 'moonshotai',
    name: 'Moonshot / Kimi',
    api: 'https://api.moonshot.cn/v1',
    envVar: 'MOONSHOT_API_KEY',
    protocol: 'openai',
    models: [{ id: 'kimi-k2', name: 'Kimi K2', toolCall: true }],
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    api: 'https://api.siliconflow.cn/v1',
    envVar: 'SILICONFLOW_API_KEY',
    protocol: 'openai',
    models: [{ id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek-V3', toolCall: true }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    api: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    protocol: 'openai',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', toolCall: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', toolCall: true },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    api: 'https://openrouter.ai/api/v1',
    envVar: 'OPENROUTER_API_KEY',
    protocol: 'openai',
    models: [{ id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)', toolCall: true }],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    api: 'https://api.anthropic.com/v1',
    envVar: 'ANTHROPIC_API_KEY',
    protocol: 'anthropic',
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reasoning: true, toolCall: true },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', toolCall: true },
    ],
  },
];

/** 把 models.dev 原始 JSON 解析成 CatalogProvider[]。 */
function parseCatalog(raw: Record<string, unknown>): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  for (const value of Object.values(raw)) {
    const p = value as Record<string, unknown>;
    if (!p || typeof p !== 'object') continue;
    const id = typeof p['id'] === 'string' ? (p['id'] as string) : undefined;
    const api = typeof p['api'] === 'string' ? (p['api'] as string) : undefined;
    const modelsRaw = p['models'] as Record<string, unknown> | undefined;
    if (!id || !api || !modelsRaw) continue;

    const models: CatalogModel[] = Object.values(modelsRaw)
      .map((mv) => {
        const m = mv as Record<string, unknown>;
        const mid = typeof m['id'] === 'string' ? (m['id'] as string) : undefined;
        if (!mid) return undefined;
        return {
          id: mid,
          name: typeof m['name'] === 'string' ? (m['name'] as string) : mid,
          reasoning: m['reasoning'] === true,
          toolCall: m['tool_call'] === true,
        } as CatalogModel;
      })
      .filter((m): m is CatalogModel => !!m)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (models.length === 0) continue;

    const env = p['env'];
    out.push({
      id,
      name: typeof p['name'] === 'string' ? (p['name'] as string) : id,
      api,
      envVar: Array.isArray(env) && typeof env[0] === 'string' ? (env[0] as string) : undefined,
      protocol: protocolFromNpm(typeof p['npm'] === 'string' ? (p['npm'] as string) : undefined),
      models,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readCache(): { fresh: boolean; raw: Record<string, unknown> } | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const age = Date.now() - statSync(CACHE_FILE).mtimeMs;
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, unknown>;
    return { fresh: age < CACHE_TTL_MS, raw };
  } catch {
    return null;
  }
}

function writeCache(raw: unknown): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_FILE, JSON.stringify(raw), { mode: 0o600 });
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

async function fetchRaw(timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 加载 models.dev 目录。优先用新鲜缓存，否则联网拉取并写缓存；
 * 拉取失败时回退到陈旧缓存，再不行回退到内置常用供应商。
 */
export async function loadModelsDevCatalog(
  opts: { forceRefresh?: boolean } = {},
): Promise<CatalogProvider[]> {
  const cached = readCache();
  if (!opts.forceRefresh && cached?.fresh) {
    const parsed = parseCatalog(cached.raw);
    if (parsed.length > 0) return parsed;
  }

  const fetched = await fetchRaw();
  if (fetched) {
    writeCache(fetched);
    const parsed = parseCatalog(fetched);
    if (parsed.length > 0) return parsed;
  }

  // 联网失败：用任何可用的（即使陈旧）缓存
  if (cached) {
    const parsed = parseCatalog(cached.raw);
    if (parsed.length > 0) return parsed;
  }

  // 彻底无网无缓存：内置兜底
  return BUILTIN_PROVIDERS;
}

/** 在目录里按 id / 名称 / 别名模糊查供应商（用于非交互式 --provider）。 */
export function findProvider(
  providers: CatalogProvider[],
  query: string,
): CatalogProvider | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;

  // 常见别名 → models.dev id
  const ALIAS: Record<string, string> = {
    glm: 'zhipuai',
    zhipu: 'zhipuai',
    智谱: 'zhipuai',
    kimi: 'moonshotai',
    moonshot: 'moonshotai',
    硅基流动: 'siliconflow',
    qwen: 'alibaba',
    通义千问: 'alibaba',
    claude: 'anthropic',
  };
  const resolved = ALIAS[q] || q;

  return (
    providers.find((p) => p.id.toLowerCase() === resolved) ||
    providers.find((p) => p.id.toLowerCase() === q) ||
    providers.find((p) => p.name.toLowerCase() === q) ||
    providers.find((p) => p.id.toLowerCase().includes(resolved)) ||
    providers.find((p) => p.name.toLowerCase().includes(q))
  );
}

export { BUILTIN_PROVIDERS };
