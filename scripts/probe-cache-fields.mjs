#!/usr/bin/env node
/**
 * 探针：四种 provider 的 prompt-cache usage 字段实测
 * ----------------------------------------------------------------------
 * 背景：自定义模型在每轮对话后 UI 显示 "No cache information available"，
 * 怀疑 customModelAdapter 在解析上游 usage 时丢字段（不同厂商命名不同）。
 *
 * 本脚本绕过 adapter，直接对 EasyRouter 网关发原始 HTTP 请求，把上游
 * 返回的整个 usage 块原样 JSON 打印出来，然后对比 adapter 现在的解析
 * 逻辑，定位"丢哪个字段"。
 *
 * 设计要点：
 *   1) 每 provider 选 1 个代表模型（claude-haiku-4-5 / deepseek-v4-flash /
 *      gpt-5.4-mini / gemini-2.5-flash）
 *   2) 用一个 ~6KB 的稳定 system prompt 把 prompt token 顶到 1500+，
 *      满足 Anthropic / OpenAI 的 1024-token cache 起步阈值
 *      （Gemini 隐式 cache 阈值更高，能否触发不强求，只要看字段就够）
 *   3) 同 prompt 重复发 2 次，间隔 5 秒，给上游创建缓存的时间
 *   4) 关闭 stream，让 usage 一定出现在响应体里
 *   5) 不动 adapter；不引入任何依赖；纯 Node 20 内置 fetch
 *
 * 用法：
 *   node scripts/probe-cache-fields.mjs                # 4 个 provider 全跑
 *   node scripts/probe-cache-fields.mjs anthropic      # 只跑指定的
 *   node scripts/probe-cache-fields.mjs openai gemini  # 多个
 *
 * API key 来源：~/.deepv/custom-models.json（与 CLI 真实使用同一个）
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 配置加载
// ---------------------------------------------------------------------------

function loadCustomModels() {
  const path = join(homedir(), '.deepv', 'custom-models.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[fatal] 无法读取 ${path}: ${e.message}`);
    process.exit(1);
  }
}

function pickModel(cfg, displayName) {
  const m = cfg.models.find((x) => x.displayName === displayName && x.enabled);
  if (!m) {
    console.error(`[fatal] 在 custom-models.json 里找不到 ${displayName} (或未 enabled)`);
    process.exit(1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 长 system prompt：稳定、可被 cache、token 数 >> 1024
// 用 1 段中文重复，确保两次请求 prefix 完全一致（cache key 才会命中）
// ---------------------------------------------------------------------------

const PARAGRAPH = [
  '你是一个专业的代码审查助手。你的职责是帮助用户审查代码、发现潜在的 bug、',
  '指出性能问题、提出可读性建议。你应当遵循以下原则：(1) 永远先理解代码意图，',
  '再给出建议；(2) 优先指出严重问题（如内存泄漏、死锁、SQL 注入等），再讨论',
  '风格问题；(3) 给出建议时附带代码示例；(4) 对于不确定的地方明确说"不确定"，',
  '而不是编造答案；(5) 使用简体中文回答。',
].join('');

const SYSTEM_PROMPT = Array.from({ length: 30 }, () => PARAGRAPH).join('\n\n');
const USER_QUERY = '你好 你好 你好';

console.log(`[info] system prompt 长度 = ${SYSTEM_PROMPT.length} 字符 (≈ ${Math.round(SYSTEM_PROMPT.length / 2)} 中文 token)`);

// ---------------------------------------------------------------------------
// 工具：彩色 + 整齐打印
// ---------------------------------------------------------------------------

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function header(provider, modelId) {
  const bar = '═'.repeat(76);
  console.log(`\n${COLOR.cyan}${bar}${COLOR.reset}`);
  console.log(`${COLOR.cyan}${COLOR.bold}  PROVIDER: ${provider}    MODEL: ${modelId}${COLOR.reset}`);
  console.log(`${COLOR.cyan}${bar}${COLOR.reset}`);
}

function roundLabel(n) {
  console.log(`\n${COLOR.yellow}${COLOR.bold}── ROUND ${n} ──${COLOR.reset}`);
}

function printUsage(label, usage) {
  if (usage == null) {
    console.log(`  ${COLOR.red}${label}: <missing>${COLOR.reset}`);
    return;
  }
  console.log(`  ${COLOR.green}${label}:${COLOR.reset}`);
  for (const line of JSON.stringify(usage, null, 2).split('\n')) {
    console.log(`    ${line}`);
  }
}

function highlightCacheFields(usage, fieldHints) {
  if (!usage) return;
  console.log(`  ${COLOR.magenta}${COLOR.bold}>>> cache 相关字段抽取：${COLOR.reset}`);
  let any = false;
  for (const path of fieldHints) {
    const segs = path.split('.');
    let v = usage;
    for (const s of segs) v = v?.[s];
    const found = v !== undefined && v !== null;
    if (found) any = true;
    const status = found ? `${COLOR.green}✓${COLOR.reset}` : `${COLOR.red}✗${COLOR.reset}`;
    console.log(`    ${status}  ${path.padEnd(48)} = ${found ? JSON.stringify(v) : '(missing)'}`);
  }
  if (!any) {
    console.log(`    ${COLOR.red}⚠️  上游完全没回任何 cache 字段${COLOR.reset}`);
  }
}

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doFetch(url, init) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`fetch network error: ${e.message}`);
  }
  const elapsed = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${elapsed}ms): ${text.slice(0, 500)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (${elapsed}ms): ${text.slice(0, 200)}`);
  }
  return { json, elapsed };
}

// ---------------------------------------------------------------------------
// Provider 1: Anthropic (claude-haiku-4-5)
//   URL:    {baseUrl}/v1/messages
//   cache 字段（猜想）：
//     usage.cache_creation_input_tokens
//     usage.cache_read_input_tokens
//   要触发 cache：在 system 块或最后一条 user 块加 cache_control:{type:'ephemeral'}
// ---------------------------------------------------------------------------

async function probeAnthropic(model) {
  header('anthropic', model.modelId);
  const url = `${model.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const body = {
    model: model.modelId,
    max_tokens: 256,
    // 数组形式的 system + cache_control，与 adapter contentsToAnthropic() 输出一致
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: USER_QUERY,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  };
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': model.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  };

  for (let r = 1; r <= 2; r++) {
    roundLabel(r);
    try {
      const { json, elapsed } = await doFetch(url, init);
      console.log(`  ${COLOR.dim}elapsed: ${elapsed}ms${COLOR.reset}`);
      printUsage('raw usage', json.usage);
      highlightCacheFields(json.usage, [
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
      ]);
    } catch (e) {
      console.log(`  ${COLOR.red}ERROR: ${e.message}${COLOR.reset}`);
    }
    if (r === 1) {
      console.log(`  ${COLOR.dim}sleeping 5s before round 2 ...${COLOR.reset}`);
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider 2: OpenAI Chat Completions (deepseek-v4-flash)
//   URL:    {baseUrl}/chat/completions
//   cache 字段（OpenAI 官方）：
//     usage.prompt_tokens_details.cached_tokens
//   DeepSeek 自己的字段（与 OpenAI 不同！）：
//     usage.prompt_cache_hit_tokens
//     usage.prompt_cache_miss_tokens
// ---------------------------------------------------------------------------

async function probeOpenAIChat(model) {
  header('openai (chat completions)', model.modelId);
  const url = `${model.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: model.modelId,
    max_tokens: 256,
    stream: false,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_QUERY },
    ],
  };
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  };

  for (let r = 1; r <= 2; r++) {
    roundLabel(r);
    try {
      const { json, elapsed } = await doFetch(url, init);
      console.log(`  ${COLOR.dim}elapsed: ${elapsed}ms${COLOR.reset}`);
      printUsage('raw usage', json.usage);
      highlightCacheFields(json.usage, [
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        // OpenAI 标准字段
        'prompt_tokens_details.cached_tokens',
        'prompt_tokens_details.audio_tokens',
        'completion_tokens_details.reasoning_tokens',
        // DeepSeek 风格
        'prompt_cache_hit_tokens',
        'prompt_cache_miss_tokens',
        // Anthropic 风格（有些网关会塞过来）
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
      ]);
    } catch (e) {
      console.log(`  ${COLOR.red}ERROR: ${e.message}${COLOR.reset}`);
    }
    if (r === 1) {
      console.log(`  ${COLOR.dim}sleeping 5s before round 2 ...${COLOR.reset}`);
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider 3: OpenAI Responses API (gpt-5.4-mini)
//   URL:    {baseUrl}/responses
//   cache 字段：
//     usage.input_tokens_details.cached_tokens
// ---------------------------------------------------------------------------

async function probeOpenAIResponses(model) {
  header('openai-responses', model.modelId);
  const url = `${model.baseUrl.replace(/\/+$/, '')}/responses`;
  const body = {
    model: model.modelId,
    max_output_tokens: 256,
    stream: false,
    store: false,
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_QUERY },
    ],
  };
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
  };

  for (let r = 1; r <= 2; r++) {
    roundLabel(r);
    try {
      const { json, elapsed } = await doFetch(url, init);
      console.log(`  ${COLOR.dim}elapsed: ${elapsed}ms${COLOR.reset}`);
      printUsage('raw usage', json.usage);
      highlightCacheFields(json.usage, [
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'input_tokens_details.cached_tokens',
        'output_tokens_details.reasoning_tokens',
      ]);
    } catch (e) {
      console.log(`  ${COLOR.red}ERROR: ${e.message}${COLOR.reset}`);
    }
    if (r === 1) {
      console.log(`  ${COLOR.dim}sleeping 5s before round 2 ...${COLOR.reset}`);
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider 4: Gemini Native (gemini-2.5-flash)
//   URL:    {baseUrl}/v1beta/models/{id}:generateContent?key=...
//   cache 字段：
//     usageMetadata.cachedContentTokenCount  (隐式缓存)
//     usageMetadata.promptTokensDetails[]    (各模态 token 分布)
//   Gemini 隐式 cache 通常需要 prompt > 4096 token 才生效，所以这里可能
//   看不到 cachedContentTokenCount，但 usage 字段名结构能确认。
// ---------------------------------------------------------------------------

async function probeGemini(model) {
  header('gemini (native)', model.modelId);
  const baseRoot = model.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1beta';
  const url =
    `${baseRoot}/models/${encodeURIComponent(model.modelId)}` +
    `:generateContent?key=${encodeURIComponent(model.apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: USER_QUERY }] }],
    generationConfig: { maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } },
  };
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };

  for (let r = 1; r <= 2; r++) {
    roundLabel(r);
    try {
      const { json, elapsed } = await doFetch(url, init);
      console.log(`  ${COLOR.dim}elapsed: ${elapsed}ms${COLOR.reset}`);
      printUsage('raw usageMetadata', json.usageMetadata);
      highlightCacheFields(json.usageMetadata, [
        'promptTokenCount',
        'candidatesTokenCount',
        'totalTokenCount',
        'cachedContentTokenCount',
        'thoughtsTokenCount',
        'promptTokensDetails',
        'cacheTokensDetails',
      ]);
    } catch (e) {
      console.log(`  ${COLOR.red}ERROR: ${e.message}${COLOR.reset}`);
    }
    if (r === 1) {
      console.log(`  ${COLOR.dim}sleeping 5s before round 2 ...${COLOR.reset}`);
      await sleep(5000);
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const PROBES = {
  anthropic: { fn: probeAnthropic, model: 'claude-haiku-4-5' },
  openai: { fn: probeOpenAIChat, model: 'deepseek-v4-flash' },
  'openai-responses': { fn: probeOpenAIResponses, model: 'gpt-5.4-mini' },
  gemini: { fn: probeGemini, model: 'gemini-2.5-flash' },
};

async function main() {
  const cfg = loadCustomModels();
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = args.length > 0 ? args : Object.keys(PROBES);

  for (const t of targets) {
    const probe = PROBES[t];
    if (!probe) {
      console.error(`${COLOR.red}[skip] 未知 provider: ${t}${COLOR.reset}`);
      console.error(`       可用: ${Object.keys(PROBES).join(', ')}`);
      continue;
    }
    const model = pickModel(cfg, probe.model);
    try {
      await probe.fn(model);
    } catch (e) {
      console.error(`${COLOR.red}[provider ${t} 出错] ${e.message}${COLOR.reset}`);
    }
  }

  console.log(`\n${COLOR.cyan}${'═'.repeat(76)}${COLOR.reset}`);
  console.log(`${COLOR.cyan}${COLOR.bold}  探针结束。对比方法：${COLOR.reset}`);
  console.log(`  1. 看每个 provider 的 raw usage / usageMetadata 整体结构`);
  console.log(`  2. 看 round 2 比 round 1 多/少了哪些字段（cache hit 表现）`);
  console.log(`  3. 对照 customModelAdapter.ts 里的 cache* 解析路径，确认是否丢字段`);
  console.log(`${COLOR.cyan}${'═'.repeat(76)}${COLOR.reset}\n`);
}

main().catch((e) => {
  console.error(`[fatal] ${e.stack || e.message}`);
  process.exit(1);
});
