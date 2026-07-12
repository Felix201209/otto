/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  FinishReason,
} from '@google/genai';
import { CustomModelConfig, resolveThinkingConfig, effortToAnthropicBudget, effortToOpenAIEffort, effortToAnthropicEffort, effortToGeminiLevel, effortToGeminiBudget, isAdaptiveThinkingClaude, applyAnthropicAdaptiveThinking, applyOpenAIChatThinking } from '../types/customModel.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { OttoChat } from './ottoChat.js';
import { retryWithBackoff, getErrorStatus } from '../utils/retry.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

/**
 * 为对象添加 functionCalls getter，兼容不同的结构
 * - GenerateContentResponse 结构: response.candidates[0].content.parts
 * - Content 结构: content.parts
 */
function addFunctionCallsGetter(obj: any) {
  if (!obj) return;

  // 检查是否已经有该属性或 getter
  const descriptor = Object.getOwnPropertyDescriptor(obj, 'functionCalls');
  if (descriptor) return;

  Object.defineProperty(obj, 'functionCalls', {
    get: function() {
      // 优先尝试 GenerateContentResponse 结构
      const partsFromResponse = this.candidates?.[0]?.content?.parts;
      // 如果不是 GenerateContentResponse，尝试 Content 结构
      const parts = partsFromResponse || this.parts;

      if (!parts || !Array.isArray(parts)) return undefined;

      const calls = parts
        .filter((p: any) => p && p.functionCall)
        .map((p: any) => p.functionCall);

      return calls.length > 0 ? calls : undefined;
    },
    enumerable: false,
    configurable: true
  });
}

/**
 * ⏱️ 流空闲/读取超时保护（BYO-key 自定义模型流共用）。
 *
 * 直连 BYO-key provider 时，fetch 的 signal 只覆盖连接建立阶段，无法发现
 * 「响应头已到、流中途卡死」（half-open TCP / provider 挂起 / 代理握住 socket
 * 不发 RST）——这种情况 reader.read() 既不 resolve 也不 reject，整个 agent turn
 * 会无限挂起到用户手动 abort。这里给每个 read() 包一层空闲超时，镜像
 * OttoServerAdapter.withTimeout 的代理路径模式，保持两条路径行为一致：
 * 超时即 cancel reader 并抛出可重试的 stream-interrupt 错误，让 turn 快速失败带指引。
 *
 * 每来一个数据块计时器就重置（下一次 read() 新建定时器），所以只防单块卡顿，
 * 不对总时长设限——长推理同样不受影响。
 */
const STREAM_READ_IDLE_TIMEOUT_MS = 300000;

async function readStreamWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number = STREAM_READ_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      // 中断卡死的连接，并抛出带标记的可重试错误（与代理路径一致）
      reader.cancel().catch(() => undefined);
      const err = new Error(
        `[Custom Model] Stream read timeout after ${Math.round(timeoutMs / 1000)}s ` +
          `(no data received in this chunk). The upstream connection appears stalled. ` +
          `Please retry your request.`,
      );
      (err as { isStreamInterrupt?: boolean }).isStreamInterrupt = true;
      (err as { isRetryable?: boolean }).isRetryable = true;
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    // 🔑 关键清理：read() 先完成时务必清掉定时器，否则形成幽灵定时器
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/** 展开开头的 ~ 到用户主目录（跨平台）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return resolvePath(homedir(), p.slice(2));
  }
  return p;
}

/**
 * 解析配置值（apiKey / baseUrl）中的引用。支持三种语法 —— 其中 {file:} / {env:}
 * 抄自 opencode：让 API key 不必经过终端 TUI 粘贴（部分终端 / Windows / SSH 下
 * bracketed-paste 不稳，表现为「key 粘不进去」）。把 key 放进一个文件或环境变量
 * （在普通编辑器 / shell 里粘贴永远可靠），再用引用指向它即可：
 *
 *   {file:~/.otto-user/secrets/glm}   读取该文件内容（去首尾空白）—— 推荐，最稳
 *   {env:ZHIPU_API_KEY}               读取环境变量
 *   ${VAR} / $VAR                     读取环境变量（旧语法，向后兼容）
 *
 * 解析失败（文件不存在 / 变量未设）时原样返回，由上层报「缺 key」而非崩溃。
 */
function resolveEnvVar(value: string): string {
  if (!value) return value;
  const trimmed = value.trim();

  // {file:PATH} —— 整个值是一处文件引用
  const fileMatch = trimmed.match(/^\{file:([^}]+)\}$/);
  if (fileMatch) {
    try {
      return readFileSync(expandHome(fileMatch[1].trim()), 'utf8').trim();
    } catch {
      return value;
    }
  }

  // {env:VAR} —— 整个值是一处环境变量引用（opencode 语法）
  const envRefMatch = trimmed.match(/^\{env:([^}]+)\}$/);
  if (envRefMatch) {
    return process.env[envRefMatch[1].trim()] || value;
  }

  // ${VAR} / $VAR 内联替换（旧语法，向后兼容）
  const envVarRegex = /\$\{([^}]+)\}|\$(\w+)/g;
  return value.replace(envVarRegex, (match, varName1, varName2) => {
    const varName = varName1 || varName2;
    return process.env[varName] || match;
  });
}

/**
 * Codex OAuth 哨兵:在 custom-models.json 里把 apiKey 设为该值,即改用本机
 * Codex CLI 凭证(~/.codex/auth.json)调用 —— 支持 ChatGPT 订阅 OAuth 或 API Key。
 * 实测:Codex 走 provider='openai-responses' + baseUrl='https://chatgpt.com/backend-api/codex'。
 */
export const CODEX_OAUTH_SENTINEL = '${CODEX_OAUTH}';

function isCodexAuth(
  modelConfig: CustomModelConfig,
  resolvedApiKey = resolveEnvVar(modelConfig.apiKey || ''),
): boolean {
  return (
    (modelConfig.apiKey || '').trim() === CODEX_OAUTH_SENTINEL ||
    resolvedApiKey.trim() === CODEX_OAUTH_SENTINEL
  );
}

/**
 * 统一鉴权头解析(单一事实源)。
 * - Codex 哨兵 → 本机 Codex 凭证(OAuth: Bearer + chatgpt-account-id;或 API Key)。
 * - 否则 → 沿用 Bearer <resolvedApiKey>,行为与改造前一致。
 */
async function resolveAuthHeaders(
  modelConfig: CustomModelConfig,
  resolvedApiKey: string,
): Promise<Record<string, string>> {
  if (isCodexAuth(modelConfig, resolvedApiKey)) {
    const { CodexAuthManager } = await import('./codexAuth.js');
    const h = await CodexAuthManager.getInstance().getAuthHeaders();
    const out: Record<string, string> = { Authorization: h.Authorization };
    if (h['chatgpt-account-id']) out['chatgpt-account-id'] = h['chatgpt-account-id'];
    return out;
  }
  return { Authorization: `Bearer ${resolvedApiKey}` };
}

/** 从请求里抽取 system 文本(Codex /responses 要求 instructions 非空)。 */
function extractSystemText(request: any): string {
  const si = request?.config?.systemInstruction;
  if (!si) return '';
  if (typeof si === 'string') return si.trim();
  if (typeof si?.text === 'string') return si.text.trim();
  if (Array.isArray(si?.parts)) {
    return si.parts.map((p: any) => p?.text || '').join('\n').trim();
  }
  return '';
}

// ============================================================================
// max_tokens 解析（output cap, 不是 context window）
// ----------------------------------------------------------------------------
// 历史包袱：CustomModelConfig.maxTokens 在向导里描述为"上下文窗口大小"
// （EasyClaw 自动填充时也写入 max_context_length，量级 100K~1M），
// 但在适配器里曾被直接当作 Anthropic 的 max_tokens 发出去——这等于把
// 1M 的上下文当成单次输出上限发给 API，后果：
//   - Anthropic 直接返回 400 "max_tokens too high for this model"
//   - 即使没 400，也会让 prompt-budget 计算/重试逻辑彻底乱套
//
// 修复方式：新增独立字段 maxOutputTokens（output cap，4K~64K 量级），
// 适配器一律用 resolveOutputTokens() 取值，maxTokens 留作上下文窗口
// 语义不变。这个 helper 是单一事实源——所有 provider 走它。
// ============================================================================

/**
 * 各 provider 的 max_tokens / max_output_tokens 兜底默认值。
 *
 * 设计取舍：写死 32K 作为统一默认。理由：
 *   - 主流模型（Claude 4.5/4.7、GPT-4o、Gemini 2.5 Pro 等）输出上限都至少 32K
 *   - 思考型模型（Claude extended thinking、o-series reasoning）需要更大的
 *     输出 budget 才能装下 thinking + 文字回复
 *   - EasyClaw 元数据填充时会用 max_output_length 覆盖（见 buildEasyRouterModelConfig），
 *     用户用 EasyRouter 加的模型都会拿到 vendor-precise 的值
 *   - 真正想自己改的高级用户可以编辑 ~/.otto/custom-models.json
 *
 * 为什么不再分 provider 给保守默认（8K/4K）：实操中 4K 经常导致工具调用响应被
 * 截断 + thinking 模型直接 budget 用完没空间出文字。32K 对绝大多数现代模型都安全，
 * 旧模型若不支持会被 vendor 自己截到上限——比报 400 友好。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * 解析单次响应的 max output tokens。
 *
 * 优先级（高到低）：
 *   1. modelConfig.maxOutputTokens（EasyClaw max_output_length 自动填充）
 *   2. DEFAULT_MAX_OUTPUT_TOKENS（32K 统一兜底）
 *
 * ⚠️ 不要回退到 modelConfig.maxTokens —— 那是上下文窗口，量级和 output
 * cap 差几个数量级，回退会把 bug 带回来。
 */
function resolveOutputTokens(
  modelConfig: CustomModelConfig,
  thinkingMinimum?: number,
): number {
  const explicit =
    typeof modelConfig.maxOutputTokens === 'number' && modelConfig.maxOutputTokens > 0
      ? modelConfig.maxOutputTokens
      : undefined;
  const base = explicit ?? DEFAULT_MAX_OUTPUT_TOKENS;
  // 思考型模型需要为思考预留 budget；如果 thinking budget 比当前 base 大，
  // 把 max_tokens 抬到至少 thinking budget + 一个余量，否则模型会把
  // 思考 budget 用完后没空间出文字。
  if (thinkingMinimum !== undefined && thinkingMinimum > 0 && thinkingMinimum >= base) {
    return thinkingMinimum + 1024;
  }
  return base;
}

/**
 * 安全解析 JSON - 增强版
 * 专门针对流式工具调用场景优化，处理各种不完整或格式异常的 JSON
 *
 * 常见问题场景：
 * 1. 流式传输中 JSON 被截断：{"pattern": "TO  (缺少结尾)
 * 2. 模型返回空字符串或 undefined
 * 3. 模型返回非标准格式（如带有多余空格、换行）
 * 4. 嵌套 JSON 字符串（需要二次解析）
 */
function parseJSONSafe(jsonStr: string): any {
  // 处理空值
  if (!jsonStr || jsonStr === 'null' || jsonStr === 'undefined') {
    return {};
  }

  // 如果已经是对象，直接返回
  if (typeof jsonStr === 'object') {
    return jsonStr;
  }

  // 清理字符串
  let cleanStr = jsonStr.trim();

  // 处理空对象字符串
  if (cleanStr === '{}' || cleanStr === '') {
    return {};
  }

  // 第一次尝试：直接解析
  try {
    return JSON.parse(cleanStr);
  } catch (firstError) {
    // 继续尝试修复
  }

  // 修复策略 1：处理不完整的 JSON 对象
  if (cleanStr.startsWith('{') && !cleanStr.endsWith('}')) {
    const repaired = repairIncompleteJSON(cleanStr);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试其他方法
      }
    }
  }

  // 修复策略 2：处理不完整的 JSON 数组
  if (cleanStr.startsWith('[') && !cleanStr.endsWith(']')) {
    // 尝试找到最后一个完整的元素
    const lastCompleteComma = cleanStr.lastIndexOf(',');
    if (lastCompleteComma > 0) {
      const repaired = cleanStr.substring(0, lastCompleteComma) + ']';
      try {
        return JSON.parse(repaired);
      } catch {
        // 继续尝试
      }
    }
    // 尝试直接补全
    try {
      return JSON.parse(cleanStr + ']');
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 3：移除尾部可能的垃圾字符
  // 有时模型会在 JSON 后附加额外内容
  const jsonEndMatch = cleanStr.match(/^(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonEndMatch) {
    try {
      return JSON.parse(jsonEndMatch[1]);
    } catch {
      // 继续尝试
    }
  }

  // 修复策略 4：处理转义问题
  // 有时 JSON 字符串中的引号没有正确转义
  try {
    // 尝试修复常见的转义问题
    const fixedEscape = cleanStr
      .replace(/([^\\])\\([^"\\/bfnrtu])/g, '$1\\\\$2')  // 修复无效转义
      .replace(/\t/g, '\\t')  // 替换实际的 tab
      .replace(/\n/g, '\\n')  // 替换实际的换行
      .replace(/\r/g, '\\r'); // 替换实际的回车
    return JSON.parse(fixedEscape);
  } catch {
    // 继续尝试
  }

  // 所有修复尝试都失败，记录错误并返回带标记的对象
  console.error(`[CustomModel] Failed to parse tool arguments after all repair attempts`);
  console.error(`[CustomModel] Original string (first 500 chars): ${jsonStr.substring(0, 500)}`);

  // 返回一个标记了解析错误的对象
  // 使用 __parseError 前缀避免与正常工具参数冲突
  return {
    __parseError: true,
    __rawArgs: jsonStr,
    __errorMessage: `Failed to parse tool arguments as JSON. Raw value: ${jsonStr.substring(0, 200)}${jsonStr.length > 200 ? '...' : ''}`
  };
}

/**
 * 尝试修复不完整的 JSON 对象
 * 使用括号匹配和引号状态追踪来找到可以安全截断的位置
 */
function repairIncompleteJSON(jsonStr: string): string | null {
  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let escapeNext = false;
  let lastSafePosition = -1;
  let lastKeyValueEnd = -1;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    switch (char) {
      case '{':
        braceCount++;
        break;
      case '}':
        braceCount--;
        if (braceCount === 0) {
          lastSafePosition = i;
        }
        break;
      case '[':
        bracketCount++;
        break;
      case ']':
        bracketCount--;
        break;
      case ',':
        // 逗号后面可能是安全的截断点（如果不在嵌套结构中）
        if (braceCount === 1 && bracketCount === 0) {
          lastKeyValueEnd = i;
        }
        break;
    }
  }

  // 如果找到了完整的 JSON，直接返回
  if (lastSafePosition > 0 && braceCount === 0) {
    return jsonStr.substring(0, lastSafePosition + 1);
  }

  // 尝试在最后一个逗号处截断并补全
  if (lastKeyValueEnd > 0) {
    const truncated = jsonStr.substring(0, lastKeyValueEnd);
    // 补全缺失的括号
    let result = truncated;
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    for (let i = 0; i < bracketCount; i++) {
      result += ']';
    }
    return result;
  }

  // 尝试找到最后一个完整的键值对（以 " 结尾的值）
  // 例如: {"pattern": "TODO", "path": "/src  -> 截断到 "TODO"
  const patterns = [
    /^(.*"[^"]*"\s*:\s*"[^"]*")\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到上一个完整的字符串值
    /^(.*"[^"]*"\s*:\s*\d+)\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,       // 截断到上一个完整的数字值
    /^(.*"[^"]*"\s*:\s*(?:true|false|null))\s*,?\s*"[^"]*"\s*:\s*"?[^"}]*$/,  // 截断到布尔/null值
  ];

  for (const pattern of patterns) {
    const match = jsonStr.match(pattern);
    if (match && match[1]) {
      return match[1] + '}';
    }
  }

  // 最后的尝试：直接补全括号
  if (braceCount > 0) {
    let result = jsonStr;
    // 如果在字符串中间被截断，先补全引号
    if (inString) {
      result += '"';
    }
    // 补全括号
    for (let i = 0; i < braceCount; i++) {
      result += '}';
    }
    return result;
  }

  return null;
}

/**
 * 创建带状态码的错误对象，便于重试逻辑判断
 */
function createHttpError(status: number, message: string, response?: Response): Error & { status: number; response?: { headers: Record<string, string> } } {
  const error = new Error(message) as Error & { status: number; response?: { headers: Record<string, string> } };
  error.status = status;

  // 尝试解析 Retry-After 头，传递给重试逻辑
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      error.response = {
        headers: { 'retry-after': retryAfter }
      };
    }
  }

  return error;
}

/**
 * 判断是否应该重试自定义模型请求
 * 重试条件：429 限流 或 5xx 服务器错误
 */
function shouldRetryCustomModel(error: Error): boolean {
  const status = getErrorStatus(error);

  // ✅ 429 限流 - 重试
  if (status === 429) {
    console.warn(`[CustomModel] Rate limited (429), will retry with backoff...`);
    return true;
  }

  // ✅ 5xx 服务器错误 - 重试
  if (status && status >= 500 && status < 600) {
    console.warn(`[CustomModel] Server error (${status}), will retry...`);
    return true;
  }

  // ✅ 检查错误消息中的 429
  if (error.message.includes('429')) {
    console.warn(`[CustomModel] Rate limit detected in message, will retry...`);
    return true;
  }

  // ❌ 其他错误（如 4xx 客户端错误）不重试
  return false;
}



/**
 * 跨协议通用的「tool_call ↔ tool_result id 配对」预扫描器。
 *
 * 三家上游（Anthropic / OpenAI Chat / OpenAI Responses）都强制要求：
 *   工具结果块（tool_result / role:'tool' / function_call_output）携带的 id
 *   必须能在前文找到一个完全相同 id 的工具调用块（tool_use / tool_calls /
 *   function_call）。否则一律 400（Anthropic: invalid_request_error；OpenAI:
 *   "tool_call_id did not have a matching tool_calls"）。
 *
 * 但 Gemini 原生历史里 functionCall 通常无 id，functionResponse 又被
 * coreToolScheduler 强制写入了 `${name}-${ts}-${rand}` 形式的 callId。直接转换
 * 会导致两侧 id 错位。本函数统一在转换前把同名 fc/fr 按 FIFO 配对，给每一对
 * 选出唯一「权威 id」（优先 fc 原始 id，其次 fr 原始 id，最后确定性合成 id），
 * 并返回一个 part → 权威 id 的 WeakMap，供各转换器在产出 id 时优先采用。
 *
 * @param contents          Gemini 格式历史
 * @param synthPrefix       合成 id 前缀（Anthropic 用 'toolu_synth'，OpenAI 用 'call_synth'）
 * @returns WeakMap<part, canonicalId>
 */
function pairToolCallIds(
  contents: any[],
  synthPrefix: string,
): WeakMap<object, string> {
  const idByPart = new WeakMap<object, string>();
  let synthCounter = 0;
  const hasId = (x: any) => x && typeof x.id === 'string' && x.id.length > 0;

  const callPartsByName: Map<string, Array<{ part: any; fc: any }>> = new Map();
  const respPartsByName: Map<string, Array<{ part: any; fr: any }>> = new Map();
  for (const content of contents || []) {
    const parts = content?.parts || [];
    if (content?.role === MESSAGE_ROLES.MODEL) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const fc = part.functionCall;
        if (!fc || typeof fc !== 'object') continue;
        const name = typeof fc.name === 'string' ? fc.name : 'unknown';
        if (!callPartsByName.has(name)) callPartsByName.set(name, []);
        callPartsByName.get(name)!.push({ part, fc });
      }
    } else if (content?.role === MESSAGE_ROLES.USER) {
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const fr = part.functionResponse;
        if (!fr || typeof fr !== 'object') continue;
        const name = typeof fr.name === 'string' ? fr.name : 'unknown';
        if (!respPartsByName.has(name)) respPartsByName.set(name, []);
        respPartsByName.get(name)!.push({ part, fr });
      }
    }
  }

  const allNames = new Set<string>([
    ...callPartsByName.keys(),
    ...respPartsByName.keys(),
  ]);
  for (const name of allNames) {
    const calls = callPartsByName.get(name) ?? [];
    const resps = respPartsByName.get(name) ?? [];

    // 步骤 A：剔除「fc.id === fr.id」的自洽配对，避免 FIFO 误配。
    const usedResp = new Set<number>();
    const pendingCalls: Array<{ part: any; fc: any }> = [];
    for (const c of calls) {
      if (hasId(c.fc)) {
        const matchIdx = resps.findIndex(
          (r, i) => !usedResp.has(i) && hasId(r.fr) && r.fr.id === c.fc.id,
        );
        if (matchIdx >= 0) {
          usedResp.add(matchIdx);
          continue;
        }
      }
      pendingCalls.push(c);
    }
    const pendingResps = resps.filter((_, i) => !usedResp.has(i));

    // 步骤 B：剩余 fc·fr 按 FIFO 一一配对，共享权威 id（fc.id > fr.id > 合成 id）
    const n = Math.max(pendingCalls.length, pendingResps.length);
    for (let k = 0; k < n; k++) {
      const c = pendingCalls[k];
      const r = pendingResps[k];
      let canonical: string;
      if (c && hasId(c.fc)) canonical = c.fc.id;
      else if (r && hasId(r.fr)) canonical = r.fr.id;
      else if (c) canonical = `${synthPrefix}_${name}_${++synthCounter}`;
      else continue; // 多出来的孤立 fr：交给调用方各自的 fallback 处理
      if (c) idByPart.set(c.part, canonical);
      if (r) idByPart.set(r.part, canonical);
    }
  }

  return idByPart;
}

/**
 * OpenAI 格式转换工具
 */
const OpenAIConverter = {
  /**
   * 将单个 part 转换为 OpenAI content 格式
   * 支持 text 和 inlineData (图片)
   */
  partToOpenAIContent(part: any): any | null {
    if (part.text) {
      return { type: 'text', text: part.text };
    }
    if (part.inlineData) {
      // 转换 Gemini inlineData 格式为 OpenAI image_url 格式
      const { mimeType, data } = part.inlineData;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`,
        },
      };
    }
    return null;
  },

  contentsToMessages(contents: any[]): any[] {
    const messages: any[] = [];
    let pendingReasoning = '';

    // 🆕 与 Anthropic 路径一致：先做一次 tool_call ↔ tool_result 的 id 配对。
    // OpenAI Chat 同样强制 role:'tool' 的 tool_call_id 必须能在前文 assistant
    // 消息的 tool_calls[].id 里找到对应项，否则 400
    // ("tool_call_id did not have a matching tool_calls")。Gemini 原生历史里
    // functionCall 多半无 id，而 functionResponse 带 CLI callId，直接转换会错位。
    const idByPart = pairToolCallIds(contents, 'call_synth');

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';

      // 1. 检查是否为纯思考消息：
      // 在历史中，我们把流式输出的多个 reasoning 块通过 appendReasoningToOutput 聚合成纯 reasoning Content。
      // 它通常只有 parts 且都是带 reasoning 字段的对象。
      const isPureReasoning = role === 'assistant' && parts.length > 0 && parts.every((p: any) => p.reasoning !== undefined);
      if (isPureReasoning) {
        pendingReasoning += parts.map((p: any) => p.reasoning).join('');
        continue; // 过滤纯思考消息，使其不作为独立对话发送（避免 API 报错）
      }

      // 如果遇到用户消息，说明当前助手回合结束。如果还没用掉 pendingReasoning，则清空（未调用工具时不拼接）
      if (role === 'user') {
        pendingReasoning = '';
      }

      // 2. 处理包含工具调用的消息
      if (parts.some((p: any) => p.functionCall)) {
        const msg: any = {
          role,
          content: null,
          tool_calls: parts
            .filter((p: any) => p.functionCall)
            .map((p: any, idx: number) => ({
              // 权威配对 id 优先（保证与下游 tool 消息的 tool_call_id 严格一致）
              id: idByPart.get(p) || p.functionCall.id || `call_${Date.now()}_${idx}`,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: typeof p.functionCall.args === 'string'
                  ? p.functionCall.args
                  : JSON.stringify(p.functionCall.args || {}),
              },
            })),
        };

        // DeepSeek 思考模式规则：在进行了工具调用的轮次中，reasoning_content 必须随 assistant 消息回传。
        if (pendingReasoning) {
          msg.reasoning_content = pendingReasoning;
          pendingReasoning = ''; // 消费后清除
        }

        messages.push(msg);
        continue;
      }

      // 3. 处理工具执行结果消息
      if (parts.some((p: any) => p.functionResponse)) {
        const functionResponseParts = parts.filter((p: any) => p.functionResponse);
        const toolMessages = functionResponseParts.map((p: any) => ({
          role: 'tool',
          tool_call_id: idByPart.get(p) || p.functionResponse.id || `call_${p.functionResponse.name}`,
          content: typeof p.functionResponse.response === 'string'
            ? p.functionResponse.response
            : JSON.stringify(p.functionResponse.response || {}),
        }));
        messages.push(...toolMessages);
        continue;
      }

      // 4. 检查是否包含图片内容
      const hasImageContent = parts.some((p: any) => p.inlineData);

      if (hasImageContent) {
        const contentParts = parts
          .map((part: any) => OpenAIConverter.partToOpenAIContent(part))
          .filter(Boolean);

        const msg: any = {
          role,
          content: contentParts,
        };
        messages.push(msg);
        continue;
      }

      // 5. 纯文本内容
      const textContent = parts.map((part: any) => part.text || '').join('\n');
      const msg: any = {
        role,
        content: textContent,
      };
      messages.push(msg);
    }

    // 🔧 Post-merge: consolidate consecutive assistant messages into one.
    // When reasoning, text, and tool_calls arrive as separate content entries
    // (e.g., from OpenAI-compatible streaming), contentsToMessages produces
    // multiple consecutive assistant messages. Models like Kimi K2.6 require
    // a single assistant message with reasoning_content, content, and tool_calls
    // combined for the same turn. Without this merge, tools calls may be rejected
    // because reasoning_content is missing from the tool-call message.
    const merged: any[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === 'assistant' && msg.role === 'assistant') {
        // Merge reasoning_content: later message may carry it from pendingReasoning
        if (msg.reasoning_content && !last.reasoning_content) {
          last.reasoning_content = msg.reasoning_content;
        }
        // Merge text content: prefer non-null/non-empty; don't overwrite with null
        if (msg.content && !last.content) {
          last.content = msg.content;
        } else if (msg.content && last.content) {
          last.content = last.content + '\n' + msg.content;
        }
        // Merge tool_calls from the later message into the previous one
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (!last.tool_calls) {
            last.tool_calls = msg.tool_calls;
          } else {
            last.tool_calls.push(...msg.tool_calls);
          }
        }
      } else {
        merged.push(msg);
      }
    }
    return merged;
  },

  toolsToOpenAITools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool: any) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd: any) => ({
          type: 'function',
          function: {
            name: fd.name,
            description: fd.description,
            // 🔧 与 Responses API 共用：把 Google GenAI 的大写 type
            // ("STRING" / "BOOLEAN" / ...) 转小写，并强转 integer 关键字。
            // 严格的 OpenAI 兼容网关（DeepSeek 等）会按 JSON Schema 校验，
            // 收到 "BOOLEAN" 直接 400 报错。
            parameters: OpenAIResponsesConverter.cleanSchema(fd.parameters),
          },
        }));
      }
      return [{
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: OpenAIResponsesConverter.cleanSchema(tool.parameters),
        },
      }];
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'stop': return FinishReason.STOP;
      case 'length': return FinishReason.MAX_TOKENS;
      case 'content_filter': return FinishReason.SAFETY;
      case 'tool_calls': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * Anthropic 格式转换工具
 * 完整支持 Anthropic Messages API 格式，包括：
 * - system 数组格式（带 cache_control）
 * - extended thinking 配置
 * - 完整的 input_schema（含 additionalProperties）
 * @see https://docs.anthropic.com/en/api/messages
 */
const AnthropicConverter = {
  /**
   * 将 Gemini 格式内容转换为 Anthropic 格式
   * 自动添加 cache_control 以利用 Anthropic prompt caching：
   * - 所有 system 消息块添加 cache_control: { type: 'ephemeral' }
   * - 用户消息的最后一个文本块添加 cache_control: { type: 'ephemeral' }
   * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   */
  contentsToAnthropic(contents: any[]): { messages: any[], system?: any[] } {
    const messages: any[] = [];
    const systemBlocks: any[] = [];

    // 🆕 跨模型迁移 → Anthropic：tool_use / tool_result 必须 id 严格一致
    //
    // Gemini 原生历史里的 functionCall / functionResponse 大多是「无 id」的
    // （Gemini 协议本身不强制要求 callId）。如果直接把这种历史塞给 Claude，
    // 旧实现里：
    //
    //   - functionCall.id  缺失 → tool_use.id  退化成 `toolu_${Date.now()}_${rand}`
    //   - functionResponse.id 缺失 → tool_result.tool_use_id 退化成 `toolu_${name}`
    //
    // 两个 fallback 各自独立、永不可能相等 → Bedrock / Anthropic 直接 400：
    //   ValidationException: unexpected `tool_use_id` found in `tool_result`
    //   blocks: toolu_<name>. Each `tool_result` block must have a corresponding
    //   `tool_use` block in the previous message.
    //
    // 修复策略：在生成 anthropic 协议之前，先做一次「FIFO id 配对」预扫描——
    // 把同名的 functionCall / functionResponse 按出现顺序一一配对，让每一对
    // 共享同一个「权威 id」，从根上保证 tool_use.id === tool_result.tool_use_id。
    //
    // 🐛 二次修复（2026-06-04）：旧实现只给「无 id」的 fc/fr 造合成 id 并配对，
    //   却把「fc 无 id 但 fr 带真实 id」这种最常见的脏状态漏掉了：
    //   functionResponse 的 id 由 coreToolScheduler 用 `${name}-${ts}-${rand}`
    //   强制写入（见 createFunctionResponsePart），几乎总是存在；而 Gemini 原生
    //   functionCall 通常无 id。旧逻辑给 fc 造了 `toolu_synth_read_file_1`、却
    //   因为 fr「已有 id」而跳过它，于是：
    //     tool_use.id = toolu_synth_read_file_1
    //     tool_result.tool_use_id = read_file-<ts>-<rand>
    //   两侧永不相等 → Bedrock/Anthropic 400:
    //     unexpected `tool_use_id` found in `tool_result` blocks.
    //
    //   现在改为：每对 fc·fr 的权威 id 优先级 = fc 原始 id > fr 原始 id（CLI callId）
    //   > 确定性合成 id；解析出来后同时写回 fc 和 fr 对应的 part，严格一致。
    //
    // 设计要点：
    //   - 已自洽（fc.id === fr.id）的配对先剔除，绝不被 FIFO 误配。
    //   - 队列按 name 分桶 → 一条 model turn 里多个同名 fc 也能正确配对。
    //   - 合成 id 仅在 fc/fr 双方都无 id 时才用，且基于稳定 counter（幂等，不依赖
    //     Date.now()/Math.random()，避免 retry 路径产生不同 id）。
    //   - 兜底：完全孤立的 fr（无任何同名 fc）仍退回原 `toolu_${name}` 行为；
    //     这种情况通常已被上游 sanitizeRequestContents 过滤，这里只是最后一道保险。
    const synthIdByPart = pairToolCallIds(contents, 'toolu_synth');

    for (const content of contents) {
      const parts = content.parts || [];

      if (content.role === 'system') {
        // 转换为 Anthropic system 数组格式
        for (const p of parts) {
          if (p.text && p.text.trim() !== '') {
            const block: any = { type: 'text', text: p.text };
            // 🆕 自动添加 cache_control（与 Claude Code 行为一致）
            block.cache_control = p.cache_control || { type: 'ephemeral' };
            systemBlocks.push(block);
          }
        }
        continue;
      }

      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant' : 'user';
      const anthropicParts: any[] = [];

      for (const part of parts) {
        if (part.text && part.text.trim() !== '') {
          const textBlock: any = { type: 'text', text: part.text };
          // 透传已有的 cache_control（后续会为最后一个文本块自动添加）
          if (part.cache_control) {
            textBlock.cache_control = part.cache_control;
          }
          anthropicParts.push(textBlock);
        }
        if (part.inlineData) {
          // 转换 Gemini inlineData 格式为 Anthropic image 格式
          anthropicParts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data,
            },
          });
        }
        if (part.functionCall) {
          // id 解析优先级：配对预扫描算出的「权威 id」> 原始 id > 退化随机 id
          // （权威 id 优先，是为了让一对 fc/fr 即便原始 id 不一致也强制对齐到同一个）
          const synth = synthIdByPart.get(part);
          const resolvedId =
            synth ||
            ((typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0)
              ? part.functionCall.id
              : `toolu_${Date.now()}_${Math.random().toString(36).slice(2)}`);
          anthropicParts.push({
            type: 'tool_use',
            id: resolvedId,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        }
        if (part.functionResponse) {
          // tool_use_id 解析优先级：配对预扫描算出的「权威 id」> 原始 id > 退化 `toolu_${name}`
          const synth = synthIdByPart.get(part);
          const resolvedToolUseId =
            synth ||
            ((typeof part.functionResponse.id === 'string' && part.functionResponse.id.length > 0)
              ? part.functionResponse.id
              : `toolu_${part.functionResponse.name}`);
          anthropicParts.push({
            type: 'tool_result',
            tool_use_id: resolvedToolUseId,
            content: typeof part.functionResponse.response === 'string'
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response || {}),
          });
        }
      }

      if (anthropicParts.length > 0) {
        messages.push({ role, content: anthropicParts });
      }
    }

    if (messages.length > 0 && messages[0].role === 'assistant') {
      messages.unshift({ role: 'user', content: '...' });
    }

    const merged: any[] = [];
    for (const msg of messages) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === msg.role) {
        const prevContent = Array.isArray(prev.content) ? prev.content : [{type:'text', text: prev.content}];
        const msgContent = Array.isArray(msg.content) ? msg.content : [{type:'text', text: msg.content}];
        prev.content = [...prevContent, ...msgContent];
      } else {
        merged.push(msg);
      }
    }

    // 🆕 为最后一条用户消息的最后一个块添加 cache_control
    // 与 Claude Code 行为一致，利用 prompt caching 减少 token 消耗
    // 优先寻找非空/非空白文本块，若无，则寻找其他有效内容块（如 image 或 tool_result），彻底杜绝空 text 块的注入
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].role === 'user' && Array.isArray(merged[i].content)) {
        const content = merged[i].content;
        let targetBlock = null;

        // 1. 优先寻找最后一个非空非空白的文本块
        for (let j = content.length - 1; j >= 0; j--) {
          const block = content[j];
          if (
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim() !== '' &&
            !block.cache_control
          ) {
            targetBlock = block;
            break;
          }
        }

        // 2. 如果没找到符合条件的文本块，则附加到最后一个任意类型的有效块上（如 image 或 tool_result）
        if (!targetBlock) {
          for (let j = content.length - 1; j >= 0; j--) {
            const block = content[j];
            if (block && !block.cache_control) {
              targetBlock = block;
              break;
            }
          }
        }

        // 3. 注入 cache_control
        if (targetBlock) {
          targetBlock.cache_control = { type: 'ephemeral' };
        }
        break; // 只处理最后一条用户消息
      }
    }

    return {
      messages: merged,
      system: systemBlocks.length > 0 ? systemBlocks : undefined
    };
  },

  /**
   * 将工具定义转换为 Anthropic 格式
   * 完整支持 input_schema（含 additionalProperties: false）
   */
  toolsToAnthropicTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const cleanSchema = (schema: any, isRoot: boolean = false): any => {
      if (!schema || typeof schema !== 'object') return schema;
      const cleaned: any = {};
      const validFields = ['type', 'properties', 'required', 'items', 'enum', 'description', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not'];
      for (const key of validFields) {
        if (schema[key] !== undefined) {
          if (key === 'type' && typeof schema[key] === 'string') cleaned[key] = schema[key].toLowerCase();
          else if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) {
            const val = parseFloat(schema[key]);
            if (!isNaN(val)) cleaned[key] = val;
          }
          else if (key === 'properties' && typeof schema[key] === 'object') {
            cleaned[key] = {};
            for (const k in schema[key]) cleaned[key][k] = cleanSchema(schema[key][k], false);
          } else if (key === 'items') cleaned[key] = cleanSchema(schema[key], false);
          else cleaned[key] = schema[key];
        }
      }
      return cleaned;
    };

    return tools.flatMap((tool: any) => {
      const decls = tool.functionDeclarations || [tool];
      return decls.map((fd: any) => {
        const cleaned = cleanSchema(fd.parameters || {}, true);
        return {
          name: fd.name,
          description: fd.description || '',
          input_schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: cleaned.properties || {},
            ...(cleaned.required && { required: cleaned.required }),
            // 🔧 关键：添加 additionalProperties: false 以匹配 Claude Code 的行为
            additionalProperties: false,
          },
        };
      });
    });
  },

  mapFinishReason(reason: string): FinishReason {
    switch (reason) {
      case 'end_turn': return FinishReason.STOP;
      case 'max_tokens': return FinishReason.MAX_TOKENS;
      case 'tool_use': return FinishReason.STOP;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * OpenAI 兼容模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAICompatibleModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/chat/completions`;

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const messages = OpenAIConverter.contentsToMessages(request.contents);
  const systemText = extractSystemText(request);
  if (systemText) {
    messages.unshift({ role: 'system', content: systemText });
  }
  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: OpenAIConverter.toolsToOpenAITools(request.config?.tools),
    stream: false,
    // 🟢 max_tokens：output cap，32K 统一兜底；EasyClaw 元数据填充时会更精确。
    // 详见 resolveOutputTokens 文档。
    max_tokens: resolveOutputTokens(modelConfig),
  };

  // Vendor-aware thinking dispatch — mirrors OttoServerAdapter so direct &
  // proxied paths produce identical upstream requests.
  // Unknown vendors (DeepSeek / Kimi / Grok / MiniMax / MiMo) intentionally
  // emit no thinking field to avoid HTTP 400 from strict OpenAI-compat layers.
  applyOpenAIChatThinking(requestBody, modelConfig.modelId, thinkingConfig);

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `OpenAI API error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const choice = data.choices[0];
      const message = choice.message;

      const parts: any[] = [];
      if (message.reasoning_content) {
        parts.push({ reasoning: message.reasoning_content });
      }
      if (message.content) parts.push({ text: message.content });
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          if (tc.type === 'function') {
            parts.push({
              functionCall: {
                name: tc.function.name?.trim() || tc.function.name,
                args: parseJSONSafe(tc.function.arguments),
                id: tc.id,
              },
            });
          }
        }
      }

      // 🔧 OpenAI prompt caching：缓存信息在 usage.prompt_tokens_details.cached_tokens
      // 参考：https://platform.openai.com/docs/guides/prompt-caching
      const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens || 0;
      const promptTokens = data.usage?.prompt_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: OpenAIConverter.mapFinishReason(choice.finish_reason),
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: data.usage?.completion_tokens || 0,
          totalTokenCount: data.usage?.total_tokens || 0,
          // 🔧 OpenAI prompt caching support
          // OpenAI 使用 prompt_tokens_details.cached_tokens 表示缓存命中的 token
          // 映射到我们的字段名以保持与 geminiChat.ts 兼容
          ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
          // OpenAI 不区分 cache creation，只有 cache read
          // uncachedInputTokens = promptTokens - cachedTokens
          uncachedInputTokens: promptTokens - cachedTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI Responses API 格式转换工具
 * Responses API 使用 input/output 而非 messages/choices
 * @see https://platform.openai.com/docs/api-reference/responses
 */
const OpenAIResponsesConverter = {
  /**
   * 将内部内容格式转换为 Responses API 的 input 格式
   * Responses API 使用扁平化的 items 数组，与 Chat Completions 的 messages 格式不同：
   * - 文本消息: { role: "user"|"assistant"|"system", content: "..." }
   * - 函数调用: { type: "function_call", call_id: "...", name: "...", arguments: "..." }
   * - 函数输出: { type: "function_call_output", call_id: "...", output: "..." }
   */
  contentsToInput(contents: any[]): any[] {
    const items: any[] = [];

    // 🆕 与 Anthropic / Chat 路径一致：先做 tool_call ↔ tool_result 的 id 配对。
    // Responses API 同样强制 function_call_output.call_id 必须能在前文的
    // function_call.call_id 里找到对应项，否则 400。
    const idByPart = pairToolCallIds(contents, 'call_synth');

    for (const content of contents) {
      const parts = content.parts || [];
      const role = content.role === MESSAGE_ROLES.MODEL ? 'assistant'
                 : content.role === 'system' ? 'system'
                 : 'user';

      // 收集当前 content 的各类部分（保留 part 引用以便查权威配对 id）
      const textParts: string[] = [];
      const functionCalls: Array<{ part: any; fc: any }> = [];
      const functionResponses: Array<{ part: any; fr: any }> = [];
      const imageParts: any[] = [];

      for (const part of parts) {
        if (part.functionCall) {
          functionCalls.push({ part, fc: part.functionCall });
        } else if (part.functionResponse) {
          functionResponses.push({ part, fr: part.functionResponse });
        } else if (part.text) {
          textParts.push(part.text);
        } else if (part.inlineData) {
          imageParts.push(part.inlineData);
        }
      }

      // 如果有文本或图片，先输出文本消息
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          // 混合内容：文本 + 图片
          const contentParts: any[] = [];
          for (const text of textParts) {
            contentParts.push({ type: 'input_text', text });
          }
          for (const img of imageParts) {
            contentParts.push({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            });
          }
          items.push({ role, content: contentParts });
        } else {
          items.push({ role, content: textParts.join('\n') });
        }
      }

      // 函数调用作为独立的 function_call items（不包裹在 message 中）
      for (const { part, fc } of functionCalls) {
        items.push({
          type: 'function_call',
          call_id: idByPart.get(part) || fc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          name: fc.name,
          arguments: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args || {}),
        });
      }

      // 函数响应作为独立的 function_call_output items
      for (const { part, fr } of functionResponses) {
        items.push({
          type: 'function_call_output',
          call_id: idByPart.get(part) || fr.id || `call_${fr.name}`,
          output: typeof fr.response === 'string'
            ? fr.response
            : JSON.stringify(fr.response || {}),
        });
      }
    }

    return items;
  },

  /**
   * JSON Schema 中必须为整数的关键字集合
   * OpenAI Responses API 严格校验这些字段的类型，不接受字符串形式的数字
   */
  INTEGER_SCHEMA_KEYWORDS: new Set([
    'minLength', 'maxLength', 'minItems', 'maxItems',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
    'minProperties', 'maxProperties', 'multipleOf',
  ]),

  /**
   * 清理 JSON Schema，使其兼容 OpenAI Responses API 的严格校验：
   * 1. 将 Google GenAI 的大写类型（如 "BOOLEAN", "STRING"）转为小写（"boolean", "string"）
   * 2. 将数值型 Schema 关键字（如 minLength, minItems）从字符串强制转为数字
   *    （例如 minLength: '1' → minLength: 1）
   * 3. 移除 Responses API 不支持的非标准 Schema 字段（如 $schema）
   */
  cleanSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map((item: any) => OpenAIResponsesConverter.cleanSchema(item));

    const cleaned: any = {};
    for (const key of Object.keys(schema)) {
      if (key === 'type' && typeof schema[key] === 'string') {
        // 大写类型转小写: "STRING" → "string", "BOOLEAN" → "boolean"
        cleaned[key] = schema[key].toLowerCase();
      } else if (OpenAIResponsesConverter.INTEGER_SCHEMA_KEYWORDS.has(key)) {
        // 数值型关键字强制转为数字: '1' → 1
        const numVal = Number(schema[key]);
        if (!isNaN(numVal)) {
          cleaned[key] = numVal;
        }
        // 如果无法转为数字则丢弃该字段，避免 API 报错
      } else if (key === 'properties' && typeof schema[key] === 'object') {
        cleaned[key] = {};
        for (const k of Object.keys(schema[key])) {
          cleaned[key][k] = OpenAIResponsesConverter.cleanSchema(schema[key][k]);
        }
      } else if (key === 'items') {
        cleaned[key] = OpenAIResponsesConverter.cleanSchema(schema[key]);
      } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(schema[key])) {
        cleaned[key] = schema[key].map((item: any) => OpenAIResponsesConverter.cleanSchema(item));
      } else if (key === 'default') {
        // default 值根据 type 做基本类型转换
        cleaned[key] = schema[key];
      } else {
        cleaned[key] = schema[key];
      }
    }
    return cleaned;
  },

  /**
   * 将工具定义转换为 Responses API 格式
   * Responses API 使用 type: "function" 包装，内部标记 (internally-tagged)
   * 注意：Responses API 的 schema 校验比 Chat Completions 更严格，
   * 必须将 Google GenAI 的大写类型转为小写
   */
  toolsToResponsesTools(tools: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.flatMap((tool: any) => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        return tool.functionDeclarations.map((fd: any) => ({
          type: 'function',
          name: fd.name,
          description: fd.description,
          parameters: OpenAIResponsesConverter.cleanSchema(fd.parameters),
          strict: false, // Responses API defaults to strict: true, set false for compatibility
        }));
      }
      return [{
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: OpenAIResponsesConverter.cleanSchema(tool.parameters),
        strict: false,
      }];
    });
  },

  /**
   * 从 Responses API 的 output items 中提取 parts
   *
   * 项目类型对照：
   * - reasoning  → 含 summary[] 数组（gpt-5.x 思考摘要），映射为 { reasoning } parts
   * - message    → 内含 content[] 含 output_text，映射为 { text } parts
   * - function_call → 直接映射为 { functionCall } part
   */
  outputToParts(output: any[]): any[] {
    const parts: any[] = [];
    if (!output || !Array.isArray(output)) return parts;

    for (const item of output) {
      if (item.type === 'reasoning') {
        // Reasoning items hold one or more summary blocks: { type:'summary_text', text:'…' }
        if (Array.isArray(item.summary)) {
          for (const s of item.summary) {
            if (s?.type === 'summary_text' && typeof s.text === 'string' && s.text) {
              parts.push({ reasoning: s.text });
            }
          }
        }
      } else if (item.type === 'message') {
        // message item contains content array
        if (item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text') {
              parts.push({ text: c.text });
            }
          }
        }
      } else if (item.type === 'function_call') {
        parts.push({
          functionCall: {
            name: item.name?.trim() || item.name,
            args: parseJSONSafe(item.arguments || '{}'),
            id: item.call_id || item.id,
          },
        });
      }
    }
    return parts;
  },

  mapFinishReason(status: string): FinishReason {
    switch (status) {
      case 'completed': return FinishReason.STOP;
      case 'incomplete': return FinishReason.MAX_TOKENS;
      case 'failed': return FinishReason.OTHER;
      default: return FinishReason.OTHER;
    }
  }
};

/**
 * OpenAI Responses API 单次调用
 * 使用 POST /responses 端点
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAIResponsesModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/responses`;

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(request.contents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(request.config?.tools),
    store: false, // Don't store responses on the server
    // 🟢 max_output_tokens：output cap，32K 统一兜底；EasyClaw 元数据填充时会更精确。
    // 详见 resolveOutputTokens 文档。
    max_output_tokens: resolveOutputTokens(modelConfig),
  };

  // OpenAI Responses API expects `reasoning.effort`; the value mirrors what
  // we'd send as Chat Completions' `reasoning_effort`.
  // - mode='off'  → effort='low' to keep tokens minimal (Responses API rejects 'none' for some models).
  // - mode!='off' → effort from user (auto → 'medium' so gpt-5.x actually thinks).
  //
  // 🚨 EasyRouter gateway quirk (probe-confirmed 2026-05-26):
  //   The default `summary='auto'` does NOT actually emit reasoning summary
  //   chunks for gpt-5.x via llm-endpoint.net. Only `summary='detailed'`
  //   produces `response.reasoning_summary_text.delta` events. Without this,
  //   the client receives 0 reasoning bytes even with effort='high'.
  //   See scripts/probe-gpt55-thinking.mjs.
  if (thinkingConfig.mode === 'off') {
    requestBody.reasoning = { effort: 'low', summary: 'detailed' };
  } else {
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort) ?? 'medium';
    requestBody.reasoning = { effort: openaiEffort, summary: 'detailed' };
  }

  const systemText = extractSystemText(request);
  if (systemText) {
    requestBody.instructions = systemText;
  }

  // GUI 会把凭证安全保存成 {file:...}。Codex OAuth 的判定必须基于解析后的
  // 值，否则会把字面量 ${CODEX_OAUTH} 当 Bearer key 发出去。
  if (isCodexAuth(modelConfig, apiKey)) {
    requestBody.instructions =
      extractSystemText(request) || 'You are a helpful assistant.';
    delete requestBody.max_output_tokens;
  }

  return retryWithBackoff(
    async () => {
      const authHeaders = await resolveAuthHeaders(modelConfig, apiKey);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `OpenAI Responses API error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const parts = OpenAIResponsesConverter.outputToParts(data.output);

      const cachedTokens = data.usage?.input_tokens_details?.cached_tokens || 0;
      const promptTokens = data.usage?.input_tokens || 0;
      const outputTokens = data.usage?.output_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: OpenAIResponsesConverter.mapFinishReason(data.status),
          index: 0,
        }],
        usageMetadata: {
          promptTokenCount: promptTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: (promptTokens + outputTokens) || data.usage?.total_tokens || 0,
          ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
          uncachedInputTokens: promptTokens - cachedTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI Responses API 流式调用
 * 使用 POST /responses 端点 + stream: true
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAIResponsesModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const requestBody: any = {
    model: modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(request.contents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(request.config?.tools),
    stream: true,
    store: false,
    // 🟢 max_output_tokens：output cap，32K 统一兜底；同 callOpenAIResponsesModel。
    max_output_tokens: resolveOutputTokens(modelConfig),
  };

  // Same routing as the non-stream Responses path — see callOpenAIResponsesModel.
  // EasyRouter gateway requires summary='detailed' to actually emit reasoning
  // chunks; 'auto' silently drops them.
  if (thinkingConfig.mode === 'off') {
    requestBody.reasoning = { effort: 'low', summary: 'detailed' };
  } else {
    const openaiEffort = effortToOpenAIEffort(thinkingConfig.effort) ?? 'medium';
    requestBody.reasoning = { effort: openaiEffort, summary: 'detailed' };
  }

  const systemText = extractSystemText(request);
  if (systemText) {
    requestBody.instructions = systemText;
  }

  // Codex(ChatGPT 后端 /responses)强制要求 instructions 字段非空。
  if (isCodexAuth(modelConfig, apiKey)) {
    requestBody.instructions =
      extractSystemText(request) || 'You are a helpful assistant.';
    // Codex(ChatGPT 后端)不支持 max_output_tokens,带上会 400 Unsupported parameter。
    delete requestBody.max_output_tokens;
  }

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await resolveAuthHeaders(modelConfig, apiKey)),
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `OpenAI Responses Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Aggregate function call arguments across deltas
  const aggregatedFunctionCalls: Map<string, { callId: string, name: string, args: string }> = new Map();

  const flushFunctionCalls = function* (): Generator<GenerateContentResponse> {
    if (aggregatedFunctionCalls.size === 0) return;
    const toolParts = Array.from(aggregatedFunctionCalls.values()).map(fc => ({
      functionCall: {
        name: fc.name || 'unknown_tool',
        args: parseJSONSafe(fc.args),
        id: fc.callId || `call_${Date.now()}`
      }
    }));
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [{
        content,
        finishReason: FinishReason.STOP,
        index: 0
      }]
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedFunctionCalls.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          yield* flushFunctionCalls();
          isDone = true;
          break;
        }

        try {
          const event = JSON.parse(dataStr);

          // response.reasoning_summary_text.delta - reasoning summary streaming
          // gpt-5.x emits these only when reasoning.summary='detailed' is set
          // (EasyRouter gateway never honors 'auto'). The delta string is
          // a chunk of natural-language summary; map it to a `reasoning` part
          // so the UI thinking-block renderer picks it up.
          if (event.type === 'response.reasoning_summary_text.delta') {
            const reasoning = event.delta || '';
            if (reasoning) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any as GenerateContentResponse;
            }
          }

          // response.output_text.delta - text content streaming
          if (event.type === 'response.output_text.delta') {
            const text = event.delta || '';
            if (text) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
            }
          }

          // response.function_call_arguments.delta - function call argument streaming
          if (event.type === 'response.function_call_arguments.delta') {
            const itemId = event.item_id || 'default';
            let fc = aggregatedFunctionCalls.get(itemId);
            if (!fc) {
              fc = { callId: '', name: '', args: '' };
              aggregatedFunctionCalls.set(itemId, fc);
            }
            if (event.delta) fc.args += event.delta;
          }

          // response.output_item.added - track new function call items
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const itemId = event.item.id || 'default';
            aggregatedFunctionCalls.set(itemId, {
              callId: event.item.call_id || event.item.id || `call_${Date.now()}`,
              name: event.item.name?.trim() || '',
              args: ''
            });
          }

          // response.function_call_arguments.done - function call complete
          if (event.type === 'response.function_call_arguments.done') {
            const itemId = event.item_id || 'default';
            const fc = aggregatedFunctionCalls.get(itemId);
            if (fc) {
              // Use the final arguments if provided
              if (event.arguments) {
                fc.args = event.arguments;
              }
              // Yield completed function call
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: fc.name, args: parseJSONSafe(fc.args), id: fc.callId } }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedFunctionCalls.delete(itemId);
            }
          }

          // response.completed - final event with usage
          if (event.type === 'response.completed' && event.response) {
            const usage = event.response.usage;
            if (usage) {
              const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
              const promptTokens = usage.input_tokens || 0;

              yield {
                candidates: [],
                usageMetadata: {
                  promptTokenCount: promptTokens,
                  candidatesTokenCount: usage.output_tokens || 0,
                  totalTokenCount: (promptTokens + (usage.output_tokens || 0)) || usage.total_tokens || 0,
                  ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
                  uncachedInputTokens: promptTokens - cachedTokens,
                }
              } as any;
            }
          }
        } catch (e) {}
      }

      if (isDone) {
        yield* flushFunctionCalls();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 检查是否应该启用 Extended Thinking
 * 对于 Anthropic 协议，默认启用 thinking（让服务端决定是否支持）
 * 不支持的模型会忽略此参数，因此统一启用更简单通用
 * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
function shouldEnableThinkingByDefault(): boolean {
  // 对于所有 Anthropic 协议的模型，默认启用 thinking
  // 如果模型不支持，服务端会自动忽略此参数
  return true;
}

/**
 * Anthropic 模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function callAnthropicModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const { messages, system } = AnthropicConverter.contentsToAnthropic(request.contents);
  const systemText = extractSystemText(request);
  const systemBlocks = system ? [...system] : [];
  if (systemText && !systemBlocks.some((block) => block.text === systemText)) {
    systemBlocks.unshift({
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' },
    });
  }

  // ⚠️ 注意：max_tokens 走 resolveOutputTokens()（output cap），不是
  // modelConfig.maxTokens（context window）。详见 resolveOutputTokens 文档。
  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: AnthropicConverter.toolsToAnthropicTools(request.config?.tools),
    max_tokens: resolveOutputTokens(modelConfig),
  };

  // 添加 system（数组格式，带 cache_control 支持）
  if (systemBlocks.length > 0) {
    requestBody.system = systemBlocks;
  }

  // 🆕 Extended Thinking 智能启用与力度调控策略：
  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const isHaiku = modelConfig.modelId.toLowerCase().includes('haiku');
  const isThinkingEnabled = !isHaiku && (thinkingConfig.mode === 'on' ||
    (thinkingConfig.mode === 'auto' && shouldEnableThinkingByDefault()));

  if (isThinkingEnabled) {
    // 如果是现代的 Claude 4.6 / 4.7+ 系列，或者用户显式指定了特定的 effort，
    // 我们采用官方推荐且唯一的自适应思考 (adaptive) + 强度 (effort) 模式，彻底防范 400 报错
    const isAdaptiveModel = isAdaptiveThinkingClaude(modelConfig.modelId) ||
      (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');

    if (isAdaptiveModel && thinkingConfig.budgetTokens === undefined) {
      const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high'; // 默认为 high
      applyAnthropicAdaptiveThinking(requestBody, effort);
      // adaptive 模式下 budget 由 effort 决定，max_tokens 用 output cap 即可。
    } else {
      // 否则回退到传统的 "enabled" + budget_tokens（支持 Sonnet 3.7 / Sonnet 3.5 兼容等）
      const budgetTokens = thinkingConfig.budgetTokens !== undefined
        ? thinkingConfig.budgetTokens
        : effortToAnthropicBudget(thinkingConfig.effort);

      // 抬高 max_tokens 以容纳 thinking budget + 至少 1024 输出余量。
      // 旧逻辑直接用 maxTokens（=context window）覆盖 max_tokens，会触发 400。
      const adjustedMax = resolveOutputTokens(modelConfig, budgetTokens);
      requestBody.max_tokens = adjustedMax;
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(adjustedMax - 1, budgetTokens),
      };
    }
  }

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `Anthropic error (${response.status}): ${errorText}`, response);
      }

      const data = await response.json();
      const parts = data.content.map((c: any) => {
        if (c.type === 'text') return { text: c.text };
        if (c.type === 'tool_use') return { functionCall: { name: c.name?.trim() || c.name, args: c.input, id: c.id } };
        // 🆕 支持 thinking 内容块 - 映射为 reasoning 格式以便 UI 显示
        // Anthropic 的 thinking 块包含模型的内部推理过程，类似于 Gemini 的 reasoning 字段
        if (c.type === 'thinking') return { reasoning: c.thinking };
        return null;
      }).filter(Boolean);

      // 🔧 计算真正的总输入 token：
      // Anthropic 的 input_tokens 只是非缓存的直接输入，实际总输入需要加上缓存 token
      // Note: Anthropic's `input_tokens` field represents ONLY the uncached (direct) input portion.
      // It does NOT include cache_creation_input_tokens or cache_read_input_tokens.
      const directInputTokens = data.usage?.input_tokens || 0;
      const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
      const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
      const actualPromptTokens = directInputTokens + cacheCreationTokens + cacheReadTokens;
      const outputTokens = data.usage?.output_tokens || 0;

      const result = {
        candidates: [{
          content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
          finishReason: AnthropicConverter.mapFinishReason(data.stop_reason),
          index: 0,
        }],
        usageMetadata: {
          // promptTokenCount 应该反映实际处理的总输入 token（包括缓存）
          promptTokenCount: actualPromptTokens,
          candidatesTokenCount: outputTokens,
          totalTokenCount: actualPromptTokens + outputTokens,
          // 🔧 Claude prompt caching 详细信息
          // 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
          // - cacheCreationInputTokens: 本次写入缓存的 token（1.25x 价格）
          //   同时设置 cacheWriteInputTokens 别名，供 telemetry 等下游兼容读取
          // - cacheReadInputTokens: 从缓存读取的 token（0.1x 价格，便宜 90%）
          // - uncachedInputTokens: 非缓存的直接输入 token
          ...(cacheCreationTokens && { cacheCreationInputTokens: cacheCreationTokens, cacheWriteInputTokens: cacheCreationTokens }),
          ...(cacheReadTokens != null && { cacheReadInputTokens: cacheReadTokens }),
          uncachedInputTokens: directInputTokens,
        } as any,
      };
      addFunctionCallsGetter(result);
      return result as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );
}

/**
 * OpenAI 兼容模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAICompatibleModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const messages = OpenAIConverter.contentsToMessages(request.contents);
  const systemText = extractSystemText(request);
  if (systemText) {
    messages.unshift({ role: 'system', content: systemText });
  }
  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: OpenAIConverter.toolsToOpenAITools(request.config?.tools),
    stream: true,
    stream_options: { include_usage: true }, // 请求包含 usage 信息
    // 🟢 max_tokens：output cap，32K 统一兜底；EasyClaw 元数据填充时会更精确。
    // 详见 resolveOutputTokens 文档。
    max_tokens: resolveOutputTokens(modelConfig),
  };

  // Vendor-aware thinking dispatch (see callOpenAICompatibleModel for details).
  applyOpenAIChatThinking(requestBody, modelConfig.modelId, thinkingConfig);

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `OpenAI Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // 用于聚合流式工具调用
  const aggregatedTools: Map<number, { id: string, name: string, args: string }> = new Map();

  const flushTools = function* (): Generator<GenerateContentResponse> {
    if (aggregatedTools.size === 0) return;
    const toolParts = Array.from(aggregatedTools.values()).map(at => ({
      functionCall: {
        name: at.name || 'unknown_tool',
        args: parseJSONSafe(at.args),
        id: at.id || `call_${Date.now()}`
      }
    }));
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [{
        content,
        finishReason: FinishReason.STOP,
        index: 0
      }]
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedTools.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        // 流结束，使用最终解码
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          // OpenAI 明确表示流结束，此时应该 flush 所有待完成的工具调用
          yield* flushTools();
          isDone = true;
          break;
        }

        try {
          const chunk = JSON.parse(dataStr);
          const choice = chunk.choices?.[0];

          if (choice) {
            const delta = choice.delta;

            // 处理思考内容 - 立即 yield
            if (delta?.reasoning_content) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning: delta.reasoning_content }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any as GenerateContentResponse;
            }

            // 处理文本内容 - 立即 yield
            if (delta?.content) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text: delta.content }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any as GenerateContentResponse;
            }

            // 聚合工具调用 - 不立即 yield，等待完全接收
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let tool = aggregatedTools.get(idx);
                if (!tool) {
                  tool = { id: '', name: '', args: '' };
                  aggregatedTools.set(idx, tool);
                }
                if (tc.id) tool.id = tc.id;
                if (tc.function?.name) tool.name = tc.function.name.trim();
                if (tc.function?.arguments) tool.args += tc.function.arguments;
              }
            }

            // 只在流结束时 flush，不在 finish_reason 中间 flush
            // 这与 Claude 的行为一致，防止不完整的工具调用被识别
          }

          if (chunk.usage) {
            // 🔧 OpenAI prompt caching：缓存信息在 usage.prompt_tokens_details.cached_tokens
            const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
            const promptTokens = chunk.usage.prompt_tokens || 0;

            yield {
              candidates: [],
              usageMetadata: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: chunk.usage.completion_tokens || 0,
                totalTokenCount: chunk.usage.total_tokens || 0,
                // 🔧 OpenAI prompt caching support
                // OpenAI 使用 prompt_tokens_details.cached_tokens 表示缓存命中的 token
                // 映射到我们的字段名以保持与 geminiChat.ts 兼容
                ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
                // OpenAI 不区分 cache creation，只有 cache read
                uncachedInputTokens: promptTokens - cachedTokens,
              }
            } as any;
          }
        } catch (e) {}
      }

      if (isDone) {
        // 在流完全结束时，flush 所有待完成的工具调用
        yield* flushTools();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Anthropic 模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function* callAnthropicModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const { messages, system } = AnthropicConverter.contentsToAnthropic(request.contents);
  const systemText = extractSystemText(request);
  const systemBlocks = system ? [...system] : [];
  if (systemText && !systemBlocks.some((block) => block.text === systemText)) {
    systemBlocks.unshift({
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' },
    });
  }

  const requestBody: any = {
    model: modelConfig.modelId,
    messages,
    tools: AnthropicConverter.toolsToAnthropicTools(request.config?.tools),
    // ⚠️ output cap，不是 context window — 详见 resolveOutputTokens 文档。
    max_tokens: resolveOutputTokens(modelConfig),
    stream: true,
  };

  // 添加 system（数组格式，带 cache_control 支持）
  if (systemBlocks.length > 0) {
    requestBody.system = systemBlocks;
  }

  // 🆕 Extended Thinking 智能启用与力度调控策略（流式调用）：
  const thinkingConfig = resolveThinkingConfig(modelConfig);
  const isHaiku = modelConfig.modelId.toLowerCase().includes('haiku');
  const isThinkingEnabled = !isHaiku && (thinkingConfig.mode === 'on' ||
    (thinkingConfig.mode === 'auto' && shouldEnableThinkingByDefault()));

  if (isThinkingEnabled) {
    // 如果是现代的 Claude 4.6 / 4.7+ 系列，或者用户显式指定了特定的 effort，
    // 我们采用官方推荐且唯一的自适应思考 (adaptive) + 强度 (effort) 模式，彻底防范 400 报错
    const isAdaptiveModel = isAdaptiveThinkingClaude(modelConfig.modelId) ||
      (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');

    if (isAdaptiveModel && thinkingConfig.budgetTokens === undefined) {
      const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high'; // 默认为 high
      applyAnthropicAdaptiveThinking(requestBody, effort);
      // adaptive 模式下 budget 由 effort 决定，max_tokens 用 output cap 即可。
    } else {
      // 否则回退到传统的 "enabled" + budget_tokens（支持 Sonnet 3.7 / Sonnet 3.5 兼容等）
      const budgetTokens = thinkingConfig.budgetTokens !== undefined
        ? thinkingConfig.budgetTokens
        : effortToAnthropicBudget(thinkingConfig.effort);

      // 抬高 max_tokens 以容纳 thinking budget + 至少 1024 输出余量。
      // 旧逻辑直接用 maxTokens（=context window）覆盖 max_tokens，会触发 400。
      const adjustedMax = resolveOutputTokens(modelConfig, budgetTokens);
      requestBody.max_tokens = adjustedMax;
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(adjustedMax - 1, budgetTokens),
      };
    }
  }

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `Anthropic Stream error (${res.status}): ${errorText}`, res);
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    }
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  const aggregatedTools: Map<number, { id: string, name: string, args: string }> = new Map();
  // 🆕 用于聚合 thinking 内容块（流式累积后一次性发送）
  const aggregatedThinking: Map<number, string> = new Map();

  // 用于累积 token 使用统计
  // 🔧 修复：缓存 token 来自 message_start（初始值），output_tokens 来自 message_delta（累加）
  let inputTokens = 0;
  let totalOutputTokens = 0;
  // 缓存相关 token（从 message_start 获取，不累加）
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  try {
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);

        try {
          const chunk = JSON.parse(dataStr);
          const idx = chunk.index ?? 0;

          if (chunk.type === 'content_block_start') {
            if (chunk.content_block?.type === 'tool_use') {
              aggregatedTools.set(idx, {
                id: chunk.content_block.id,
                name: chunk.content_block.name?.trim() || chunk.content_block.name,
                args: ''
              });
            } else if (chunk.content_block?.type === 'thinking') {
              // 🆕 开始聚合 thinking 内容块
              aggregatedThinking.set(idx, chunk.content_block.thinking || '');
            }
          } else if (chunk.type === 'content_block_delta') {
            if (chunk.delta?.type === 'text_delta') {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text: chunk.delta.text }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any;
            } else if (chunk.delta?.type === 'input_json_delta') {
              const tool = aggregatedTools.get(idx);
              if (tool) tool.args += chunk.delta.partial_json;
            } else if (chunk.delta?.type === 'thinking_delta') {
              // 🆕 实时流式输出 thinking 内容，让 UI 能显示模型思考过程
              const thinkingChunk = chunk.delta.thinking || '';
              if (thinkingChunk) {
                const content = { role: MESSAGE_ROLES.MODEL, parts: [{ reasoning: thinkingChunk }] } as any;
                const resp = { candidates: [{ content, index: 0 }] } as any;
                addFunctionCallsGetter(resp);
                addFunctionCallsGetter(content);
                yield resp;
              }
              // 同时累积完整内容，以便在 content_block_stop 时可用（如果需要）
              const existing = aggregatedThinking.get(idx) || '';
              aggregatedThinking.set(idx, existing + thinkingChunk);
            }
          } else if (chunk.type === 'content_block_stop') {
            const tool = aggregatedTools.get(idx);
            if (tool) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ functionCall: { name: tool.name, args: parseJSONSafe(tool.args), id: tool.id } }] };
              const resp = {
                candidates: [{
                  content,
                  index: 0
                }]
              };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedTools.delete(idx);
            }
            // 🆕 thinking 内容已在 thinking_delta 中实时流式输出，这里只需清理状态
            // 不再重复 yield 完整内容，避免 UI 显示重复
            if (aggregatedThinking.has(idx)) {
              aggregatedThinking.delete(idx);
            }
          } else if (chunk.type === 'message_delta') {
            // 🔧 message_delta 中的 output_tokens 是最终总数，不是增量，所以用替换而非累加
            // 参考日志：message_start 有 output_tokens:5，message_delta 有 output_tokens:298（最终值）
            if (chunk.usage?.output_tokens != null) {
              totalOutputTokens = chunk.usage.output_tokens;
            }

            // 🔧 鲁棒性增强：一些上游厂商（如 GLM-4 的 Anthropic 兼容接口）在 message_start 中
            // 返回 input_tokens: 0，但在最后的 message_delta 中才返回真实的 token 用量。
            // 这里采用"有非零值就更新"的策略，确保能从任何位置获取正确的 token 数据。
            if (chunk.usage?.input_tokens != null && chunk.usage.input_tokens > 0) {
              inputTokens = chunk.usage.input_tokens;
            }
            if (chunk.usage?.cache_creation_input_tokens != null && chunk.usage.cache_creation_input_tokens > 0) {
              cacheCreationInputTokens = chunk.usage.cache_creation_input_tokens;
            }
            if (chunk.usage?.cache_read_input_tokens != null && chunk.usage.cache_read_input_tokens > 0) {
              cacheReadInputTokens = chunk.usage.cache_read_input_tokens;
            }

            // 🔧 计算真正的总输入 token：
            // Anthropic 的 input_tokens 只是非缓存的直接输入，实际总输入需要加上缓存 token
            // 实际总输入 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
            const actualPromptTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

            const content = { role: MESSAGE_ROLES.MODEL, parts: [] };
            const resp = {
              candidates: [{
                content,
                finishReason: AnthropicConverter.mapFinishReason(chunk.delta?.stop_reason),
                index: 0
              }],
              usageMetadata: {
                // promptTokenCount 应该反映实际处理的总输入 token（包括缓存）
                promptTokenCount: actualPromptTokens,
                candidatesTokenCount: totalOutputTokens,
                totalTokenCount: actualPromptTokens + totalOutputTokens,
                // 🔧 Claude prompt caching 详细信息
                // 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
                // - cacheCreationInputTokens: 本次写入缓存的 token（1.25x 价格）
                //   同时设置 cacheWriteInputTokens 别名，供 telemetry 等下游兼容读取
                // - cacheReadInputTokens: 从缓存读取的 token（0.1x 价格，便宜 90%）
                // - uncachedInputTokens: 非缓存的直接输入 token（原始 input_tokens）
                ...(cacheCreationInputTokens != null && { cacheCreationInputTokens, cacheWriteInputTokens: cacheCreationInputTokens }),
                ...(cacheReadInputTokens != null && { cacheReadInputTokens }),
                // 保留原始的非缓存输入 token 以便精确计费
                uncachedInputTokens: inputTokens,
              }
            } as any;
            addFunctionCallsGetter(resp);
            addFunctionCallsGetter(content);
            yield resp;
          } else if (chunk.type === 'message_start' && chunk.message?.usage) {
            // 🔧 message_start 包含完整的初始 usage，包括缓存 token
            const usage = chunk.message.usage;
            inputTokens = usage.input_tokens || 0;
            totalOutputTokens = usage.output_tokens || 0;
            // 缓存 token 只在 message_start 中出现，记录后不再累加
            cacheCreationInputTokens = usage.cache_creation_input_tokens || 0;
            cacheReadInputTokens = usage.cache_read_input_tokens || 0;
          }
        } catch (e) {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// Gemini native (GenAI v1beta) — POST /v1beta/models/{id}:streamGenerateContent
// ----------------------------------------------------------------------------
// Mirrors what OttoServerAdapter sends for Gemini through its proxy: the
// request body is a real Google GenAI payload (not OpenAI-shimmed), so we
// keep `thinkingConfig`, `thoughts`, `parts.functionCall`, and other native
// features instead of round-tripping through OpenAI's reduced schema.
//
// Probe-confirmed (2026-05-26) on EasyRouter:
//   • /v1beta/models/{id}:streamGenerateContent?key=…&alt=sse  → 200 OK
//   • thinkingConfig: { thinkingBudget: -1, includeThoughts: true } actually
//     emits parts with `thought: true` and reasoning text.
// See scripts/probe-gemini-thinking.mjs for the verification harness.
// ============================================================================

/**
 * Apply user's resolved {@link ThinkingConfig} to a Gemini GenAI request body.
 * Branches on Gemini family the same way OttoServerAdapter does:
 *   - Gemini 3 / 3.5  →  thinkingConfig.thinkingLevel ('minimal'|'low'|'medium'|'high')
 *   - Gemini 2.5 (default) →  thinkingConfig.thinkingBudget (number; -1=dynamic, 0=disable)
 * Always sets `includeThoughts: true` when thinking is on so the model emits
 * `parts[].thought = true` chunks the UI renders as the thinking block.
 */
function applyGeminiNativeThinking(
  generationConfig: Record<string, unknown>,
  modelId: string,
  thinking: ReturnType<typeof resolveThinkingConfig>,
): void {
  const lower = modelId.toLowerCase();
  const isGemini3 = lower.includes('gemini-3') || lower.includes('gemini-3.5');
  if (thinking.mode === 'off') {
    generationConfig.thinkingConfig = isGemini3
      ? { thinkingLevel: 'minimal' }
      : { thinkingBudget: 0 };
    return;
  }
  if (isGemini3) {
    const level = effortToGeminiLevel(thinking.effort) || 'medium';
    generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };
  } else {
    const budget =
      thinking.budgetTokens !== undefined
        ? thinking.budgetTokens
        : effortToGeminiBudget(thinking.effort) ?? -1; // -1 = dynamic thinking (Gemini 2.5 default)
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  }
}

// ----------------------------------------------------------------------------
// Tool / schema sanitiser for the GenAI v1beta endpoint
// ----------------------------------------------------------------------------
// Why this exists:
//   Gemini's `Schema` (per @google/genai's typings — see
//   node_modules/@google/genai/dist/node/node.d.ts ~line 8498) is an
//   OpenAPI-3-shaped *subset* of JSON Schema. Unknown keys produce a hard
//   HTTP 400 from the upstream:
//     "Invalid JSON payload received. Unknown name "$schema" at
//      'tools[0].function_declarations[N].parameters': Cannot find field."
//   MCP servers (e.g. Context7) return tool inputSchemas with the JSON-Schema
//   header `"$schema": "http://json-schema.org/draft-07/schema#"` plus the
//   occasional `additionalProperties` / `oneOf` / `const`, all of which are
//   valid JSON-Schema-2020-12 but not in Gemini's accepted set.
//
//   The OttoServerAdapter path doesn't trip this because the Otto proxy
//   strips these on its way out. The custom-model direct path (talking to
//   EasyRouter / Google directly) bypasses that proxy and therefore must
//   sanitise client-side. The other vendor branches in this file
//   (OpenAIConverter / OpenAIResponsesConverter / AnthropicConverter)
//   already do the equivalent — Gemini was the odd one out.
//
// Accepted Gemini Schema keys (kept in `GEMINI_SCHEMA_ALLOWED_KEYS` below)
// match @google/genai's `Schema` interface verbatim. Anything else is
// dropped silently. We also:
//   • lower→upper-case `type` values (Gemini canonicalises e.g. "STRING"),
//     because MCP tools emit lowercase JSON-Schema types like "string".
//     Both forms are tolerated by EasyRouter, but we normalise to the
//     uppercase form the SDK exposes for consistency with built-in tools
//     in the same payload (see decl 0 in the failing dump: type: "STRING").
//   • coerce `const: x` → `enum: [x]` (Gemini supports `enum` only).
//   • flatten `oneOf` / `allOf` into `anyOf` (the only multi-schema combinator
//     Gemini accepts), which is a strict-mode best-effort — unsupported
//     advanced combinators degrade rather than 400.
//
// Verification: see customModelAdapter.test.ts ("sanitiseGeminiToolSchema").
const GEMINI_SCHEMA_ALLOWED_KEYS = new Set<string>([
  'anyOf', 'default', 'description', 'enum', 'example', 'format',
  'items', 'maxItems', 'maxLength', 'maxProperties', 'maximum',
  'minItems', 'minLength', 'minProperties', 'minimum', 'nullable',
  'pattern', 'properties', 'propertyOrdering', 'required', 'title',
  'type',
]);

const GEMINI_TYPE_NORMALISE = new Map<string, string>([
  ['string', 'STRING'], ['number', 'NUMBER'], ['integer', 'INTEGER'],
  ['boolean', 'BOOLEAN'], ['array', 'ARRAY'], ['object', 'OBJECT'],
  ['null', 'TYPE_UNSPECIFIED'],
]);

/**
 * Recursively prune a JSON Schema down to the subset Gemini's GenAI v1beta
 * accepts. Returns a fresh object — does not mutate the input.
 *
 * Pure function — exported (via the trailing alias at the bottom of the
 * file) for unit testing.
 */
function sanitiseGeminiToolSchema(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitiseGeminiToolSchema(item));
  }
  if (typeof schema !== 'object') return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // 1) `const: x` → `enum: [x]` (Gemini supports enum only). Apply BEFORE
  //    field iteration so a coexisting `enum` (rare but legal in JSON-Schema)
  //    isn't clobbered.
  if (src['const'] !== undefined && src['enum'] === undefined) {
    out['enum'] = [src['const']];
  }

  // 2) `oneOf` / `allOf` → fold into `anyOf` (best-effort; Gemini only
  //    accepts anyOf as its combinator). If `anyOf` is also present we
  //    concatenate, dedupe is left to the upstream validator.
  const combinators: unknown[] = [];
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const v = src[key];
    if (Array.isArray(v)) combinators.push(...v);
  }
  if (combinators.length > 0) {
    out['anyOf'] = combinators.map((s) => sanitiseGeminiToolSchema(s));
  }

  for (const key of Object.keys(src)) {
    // anyOf already handled above; const already converted.
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'const') continue;
    if (!GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) continue; // drops $schema, $id,
    //                                                     additionalProperties,
    //                                                     patternProperties, $ref,
    //                                                     $defs, definitions, not, …

    const val = src[key];

    if (key === 'type' && typeof val === 'string') {
      const upper = GEMINI_TYPE_NORMALISE.get(val.toLowerCase()) ?? val;
      out[key] = upper;
      continue;
    }

    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
        props[propName] = sanitiseGeminiToolSchema(propSchema);
      }
      out[key] = props;
      continue;
    }

    if (key === 'items') {
      out[key] = sanitiseGeminiToolSchema(val);
      continue;
    }

    out[key] = val;
  }

  return out;
}

/**
 * Sanitise the `tools` array as it appears in `request.config.tools` on its
 * way into a Gemini-native request body. Each element is the GenAI
 * `{ functionDeclarations: [{ name, description, parameters }] }` shape.
 *
 * Returns a freshly built array — input is not mutated, so other adapter
 * branches (which receive the same `request.config.tools`) keep their
 * untouched JSON-Schema view.
 */
function sanitiseGeminiTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const t = tool as Record<string, unknown>;
    if (!Array.isArray(t['functionDeclarations'])) return tool;
    return {
      ...t,
      functionDeclarations: (t['functionDeclarations'] as unknown[]).map((fd) => {
        if (!fd || typeof fd !== 'object') return fd;
        const decl = fd as Record<string, unknown>;
        const cleaned: Record<string, unknown> = { ...decl };
        if (decl['parameters'] !== undefined) {
          cleaned['parameters'] = sanitiseGeminiToolSchema(decl['parameters']);
        }
        if (decl['response'] !== undefined) {
          // FunctionDeclaration also carries an optional `response` schema
          // (rare client-side, but follow the same rules to be safe).
          cleaned['response'] = sanitiseGeminiToolSchema(decl['response']);
        }
        return cleaned;
      }),
    };
  });
}

/**
 * Build the GenAI native request body. Forwards `request.contents` /
 * `request.config.tools` / `request.config.systemInstruction` etc. directly —
 * the server-side proxy has been doing this same passthrough already.
 */
function buildGeminiNativeRequestBody(
  modelConfig: CustomModelConfig,
  request: any,
): Record<string, unknown> {
  const reqConfig = request?.config || {};
  const generationConfig: Record<string, unknown> = {
    ...(reqConfig.generationConfig || {}),
  };
  // Pull selected top-level GenAI config knobs into generationConfig
  // (the Google SDK lets users specify either at top-level config.* or under
  // generationConfig.*; we normalise into generationConfig for the wire body).
  for (const k of ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stopSequences', 'candidateCount', 'responseMimeType', 'responseSchema'] as const) {
    if (reqConfig[k] !== undefined && generationConfig[k] === undefined) {
      generationConfig[k] = reqConfig[k];
    }
  }

  // 🟢 maxOutputTokens 兜底：request 没指定 → 用 modelConfig.maxOutputTokens
  // （EasyClaw 元数据填的）→ 用 32K 默认。统一走 resolveOutputTokens。
  if (generationConfig['maxOutputTokens'] === undefined) {
    generationConfig['maxOutputTokens'] = resolveOutputTokens(modelConfig);
  }

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  applyGeminiNativeThinking(generationConfig, modelConfig.modelId, thinkingConfig);

  /**
   * Sanitise `contents[].parts[]` for the GenAI v1beta endpoint.
   *
   * The chat history we accumulate contains UI-only / cross-protocol shapes
   * that Gemini's strict schema rejects with HTTP 400:
   *   * .parts[i].data: required oneof field 'data' must have one initialized field
   *   * Function call is missing a thought_signature in functionCall parts
   *
   * Specifically:
   *   - { reasoning } (our adapter's projection of Gemini `thought:true` parts) →
   *     converted back to `{ thought:true, text, thoughtSignature? }` so any
   *     thoughtSignature attached to the reasoning chunk survives the round
   *     trip. Gemini 3.x with thinking REQUIRES the matching thoughtSignature
   *     to be sent back, otherwise the next functionCall is rejected.
   *   - { thought:true, text, thoughtSignature? } (raw) — kept as-is.
   *   - functionCall / functionResponse — pass through after non-empty check;
   *     thoughtSignature is preserved.
   *   - text / inlineData / fileData — pass through canonically.
   * Empty / unknown parts are dropped (oneof validator fails on `{}`).
   *
   * 🆕 Cross-model migration → Gemini 3.x downgrade
   *   `thoughtSignature` is an opaque server-signed token: the client cannot
   *   forge or back-fill it. When a user accumulates history with Opus /
   *   GPT-4 / Gemini 2.5 and then switches to Gemini 3.x, the historical
   *   functionCall parts have NO signature, and Gemini 3.x will reject the
   *   request with HTTP 400 "Function call is missing a thought_signature".
   *
   *   Strategy: pre-scan the history once, identify every "naked" functionCall
   *   (one without a thoughtSignature) when targeting Gemini 3.x, and rewrite
   *   BOTH that part AND its paired functionResponse into plain text summary
   *   parts. The semantic information (which tool, what args, what result)
   *   survives as text — Gemini 3.x reads it as "previous tool activity
   *   described in prose", and the protocol constraint disappears because no
   *   `functionCall` part remains in the wire body.
   *
   *   Pairing key: `functionCall.id` if present, else `name:<name>`.
   *   Native Gemini 3.x → 3.x is unaffected: signed parts still round-trip.
   *   Gemini 2.5 / non-3.x targets are unaffected: detection gated on modelId.
   */
  const lowerModelId = (modelConfig.modelId || '').toLowerCase();
  const isGemini3Target = lowerModelId.includes('gemini-3');

  // Pre-scan: collect pairing keys of naked functionCall parts so we can
  // rewrite both the call AND its corresponding response as text.
  const nakedCallKeys: Set<string> = new Set();
  if (isGemini3Target && Array.isArray(request.contents)) {
    for (const c of request.contents) {
      if (!c || typeof c !== 'object') continue;
      const parts = Array.isArray(c.parts) ? c.parts : [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (
          p.functionCall &&
          typeof p.functionCall === 'object' &&
          typeof p.functionCall.name === 'string' &&
          p.functionCall.name.length > 0 &&
          typeof p.thoughtSignature !== 'string'
        ) {
          const key =
            typeof p.functionCall.id === 'string' && p.functionCall.id.length > 0
              ? p.functionCall.id
              : `name:${p.functionCall.name}`;
          nakedCallKeys.add(key);
        }
      }
    }
  }

  // Compact JSON helper for tool-summary text — keeps the line readable in
  // the model's context. Defensive against non-serialisable args.
  const safeStringify = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    try {
      const s = JSON.stringify(v);
      // Trim absurdly long blobs so a single huge tool result doesn't blow
      // up the migrated summary line.
      return s.length > 2000 ? s.slice(0, 2000) + '…(truncated)' : s;
    } catch {
      return String(v);
    }
  };

  const sanitiseContentsForGemini = (raw: any[] | undefined): any[] => {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const role = c.role;
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const cleanParts: any[] = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        // 1) UI-only `reasoning` projection → fold back to a thought part so
        //    the attached thoughtSignature (if any) is preserved.
        if (typeof p.reasoning === 'string') {
          if (p.reasoning.length === 0) continue;
          const part: any = { thought: true, text: p.reasoning };
          if (typeof p.thoughtSignature === 'string') part.thoughtSignature = p.thoughtSignature;
          cleanParts.push(part);
          continue;
        }
        // 2) Raw Gemini `thought:true` part — pass through with signature.
        if (p.thought === true) {
          if (typeof p.text !== 'string' || p.text.length === 0) continue;
          const part: any = { thought: true, text: p.text };
          if (typeof p.thoughtSignature === 'string') part.thoughtSignature = p.thoughtSignature;
          cleanParts.push(part);
          continue;
        }
        // 3) Canonical GenAI shapes — pass through, but verify the inner
        // shape is non-empty. The error
        //   * parts[i].data: required oneof field 'data' must have one initialized field
        // is also raised for shapes like `{ inlineData: {} }` or
        // `{ functionResponse: { name:'…' } }` (missing `response`).
        if (typeof p.text === 'string') {
          // GenAI rejects '' for some models; keep only meaningful text.
          if (p.text.length > 0) cleanParts.push({ text: p.text });
          continue;
        }
        if (p.inlineData && typeof p.inlineData === 'object') {
          const inline = p.inlineData as Record<string, unknown>;
          if (typeof inline.mimeType === 'string' && typeof inline.data === 'string' && inline.data.length > 0) {
            cleanParts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
          }
          continue;
        }
        if (p.functionCall && typeof p.functionCall === 'object') {
          const fc = p.functionCall as Record<string, unknown>;
          if (typeof fc.name === 'string' && fc.name.length > 0) {
            // 🆕 Naked functionCall on Gemini 3.x → downgrade to text summary.
            // We cannot synthesise a thoughtSignature (server-signed opaque
            // token), so preserve the semantics as prose instead. The paired
            // functionResponse is downgraded in the same pass below.
            if (isGemini3Target && typeof p.thoughtSignature !== 'string') {
              const argsStr = safeStringify(fc.args);
              cleanParts.push({
                text: `[Previous tool call] ${fc.name}(${argsStr})`,
              });
              continue;
            }
            const part: any = {
              functionCall: {
                name: fc.name,
                args: (fc.args && typeof fc.args === 'object') ? fc.args : {},
                ...(typeof fc.id === 'string' ? { id: fc.id } : {}),
              },
            };
            // Preserve thoughtSignature on the part (Gemini 3.x with thinking
            // requires this to round-trip; missing it ⇒ HTTP 400).
            if (typeof p.thoughtSignature === 'string') {
              part.thoughtSignature = p.thoughtSignature;
            }
            cleanParts.push(part);
          }
          continue;
        }
        if (p.functionResponse && typeof p.functionResponse === 'object') {
          const fr = p.functionResponse as Record<string, unknown>;
          // GenAI requires both `name` and `response` to be present and non-empty.
          // If the response payload is missing/empty we synthesise an empty
          // object so the part stays valid; dropping it would unbalance the
          // tool-call/response pairing and cause subsequent 400s.
          if (typeof fr.name === 'string' && fr.name.length > 0) {
            // 🆕 If this response pairs with a naked (downgraded) functionCall,
            // downgrade it as text too — keeping a `functionResponse` part
            // without its matching `functionCall` would produce a different
            // 400 ("functionResponse without preceding functionCall").
            if (isGemini3Target) {
              const key =
                typeof fr.id === 'string' && fr.id.length > 0
                  ? fr.id
                  : `name:${fr.name}`;
              if (nakedCallKeys.has(key)) {
                const resultStr = safeStringify(fr.response);
                cleanParts.push({
                  text: `[Previous tool result] ${fr.name} → ${resultStr}`,
                });
                continue;
              }
            }
            const responseValue =
              fr.response && typeof fr.response === 'object'
                ? fr.response
                : { result: typeof fr.response === 'string' ? fr.response : '' };
            cleanParts.push({
              functionResponse: {
                name: fr.name,
                response: responseValue,
                ...(typeof fr.id === 'string' ? { id: fr.id } : {}),
              },
            });
          }
          continue;
        }
        if (p.fileData && typeof p.fileData === 'object') {
          const fd = p.fileData as Record<string, unknown>;
          if (typeof fd.fileUri === 'string' && fd.fileUri.length > 0) {
            cleanParts.push({
              fileData: {
                fileUri: fd.fileUri,
                ...(typeof fd.mimeType === 'string' ? { mimeType: fd.mimeType } : {}),
              },
            });
          }
          continue;
        }
        // Unknown shapes silently dropped — better than a 400 from Gemini.
      }
      // A Content with zero valid parts also fails validation; skip it.
      if (cleanParts.length === 0) continue;
      out.push(role ? { role, parts: cleanParts } : { parts: cleanParts });
    }
    return out;
  };

  const body: Record<string, unknown> = {
    contents: sanitiseContentsForGemini(request.contents),
    generationConfig,
  };
  /**
   * Normalise `systemInstruction` to the GenAI wire shape `{ parts: [{ text }] }`.
   *
   * Callers historically passed it as either:
   *   - a plain string (legacy convenience)
   *   - `{ parts: [{ text }] }` (canonical GenAI)
   *   - `{ text: '...' }` (intermediate form some adapters used)
   * EasyRouter / Google's actual `/v1beta` endpoint only accepts the canonical
   * form — passing a string yields HTTP 500 "json: cannot unmarshal string
   * into Go struct field .systemInstruction of type OttoChatContent".
   */
  const normaliseSystemInstruction = (raw: unknown): unknown => {
    if (raw == null) return undefined;
    if (typeof raw === 'string') {
      return { parts: [{ text: raw }] };
    }
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // already canonical
      if (Array.isArray(obj.parts)) return obj;
      // {text:'…'} short form
      if (typeof obj.text === 'string') return { parts: [{ text: obj.text }] };
    }
    // Anything weirder — let it through verbatim; the upstream error message
    // will still be informative if the structure is unrecognised.
    return raw;
  };

  if (reqConfig.systemInstruction) {
    const normalised = normaliseSystemInstruction(reqConfig.systemInstruction);
    if (normalised !== undefined) body.systemInstruction = normalised;
  }
  if (reqConfig.tools) {
    // Strip JSON-Schema-only keys (e.g. `$schema` from MCP tools) and
    // normalise types/combinators down to Gemini's accepted Schema subset.
    // Without this, MCP-supplied tool schemas trigger HTTP 400 from the
    // upstream — the OttoServerAdapter path is shielded by the proxy doing
    // the same cleaning, but here we're talking to EasyRouter / Google
    // directly. See sanitiseGeminiToolSchema for the full rationale.
    body.tools = sanitiseGeminiTools(reqConfig.tools);
  }
  if (reqConfig.toolConfig) body.toolConfig = reqConfig.toolConfig;
  if (reqConfig.safetySettings) body.safetySettings = reqConfig.safetySettings;
  return body;
}

/**
 * Build the EasyRouter / GenAI endpoint URL. Uses Google's documented
 * `?key=...` form (works on both google.googleapis.com and the EasyRouter
 * gateway, no Authorization header required).
 */
function buildGeminiNativeUrl(
  modelConfig: CustomModelConfig,
  method: 'streamGenerateContent' | 'generateContent',
): string {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  // Normalise base: callers configure `https://llm-endpoint.net/v1` from
  // EasyRouter, but the GenAI mount is /v1beta. If the configured base is
  // already a /v1beta-style endpoint, leave it alone.
  const root = baseUrl.endsWith('/v1beta')
    ? baseUrl
    : baseUrl.replace(/\/v1$/, '') + '/v1beta';
  const sep = method === 'streamGenerateContent' ? '?alt=sse&key=' : '?key=';
  return `${root}/models/${encodeURIComponent(modelConfig.modelId)}:${method}${sep}${encodeURIComponent(apiKey)}`;
}

/**
 * Normalise Gemini's usageMetadata into the cross-provider shape downstream
 * consumers expect.
 *
 * Why this exists:
 *   geminiChat.ts:240 (the single place that emits TokenUsageEvent for the
 *   "Token Usage" footer) reads `usageMetadata.cacheReadInputTokens` —
 *   the cross-provider canonical name set by anthropic / openai-chat /
 *   openai-responses paths in this same file. Gemini, however, uses
 *   `cachedContentTokenCount` (camelCase, with `Count` suffix). Forwarding
 *   `data.usageMetadata` verbatim therefore caused the UI to permanently
 *   show "No cache information available" for any custom Gemini model,
 *   even when the upstream had handed back e.g. `cachedContentTokenCount: 3059`.
 *
 * Verified end-to-end via scripts/probe-cache-fields.mjs (round 2 hits
 * always populate cachedContentTokenCount on EasyRouter's
 * /v1beta/...:generateContent, both unary and SSE).
 *
 * Strategy: keep all original Gemini fields (some downstream code, e.g.
 * SessionManager, still reads `cachedContentTokenCount` directly), and
 * additionally project `cacheReadInputTokens` as an alias. We deliberately
 * do NOT synthesise `cacheCreationInputTokens` — Gemini's implicit cache has
 * no "creation" phase visible to clients (the tokens are billed once at
 * input rate; the cache is server-managed). Pretending otherwise would
 * double-count in cost calculators.
 */
function normaliseGeminiUsageMetadata(usage: any): any {
  if (!usage || typeof usage !== 'object') return usage;
  const cached = usage.cachedContentTokenCount || 0;
  // Already normalised (defensive — never expected from Google's API today).
  if (typeof usage.cacheReadInputTokens === 'number') return usage;
  return {
    ...usage,
    // Alias only when the upstream actually reported a hit; absent field
    // (round 1, miss) → leave undefined so existing `|| 0` fallbacks
    // downstream behave identically.
    ...(cached > 0 && { cacheReadInputTokens: cached }),
  };
}

/**
 * Map a single GenAI streaming JSON chunk to one or more
 * GenerateContentResponse-shaped objects ready to yield. Specifically, splits
 * `parts[]` into:
 *   • `{ thought: true, text }` → `{ reasoning: text }` (UI thinking block)
 *   • `{ text }`                → `{ text }`            (regular output)
 *   • `{ functionCall }`        → `{ functionCall }`
 * so downstream chat consumers see the same shape they expect from any other
 * provider.
 */
function* mapGeminiChunkToResponses(chunk: any): Generator<GenerateContentResponse> {
  const cand = chunk?.candidates?.[0];
  const parts = cand?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const mappedParts: any[] = [];
    for (const p of parts) {
      // Gemini 3.x with thinking emits a `thoughtSignature` on functionCall
      // parts. We must propagate it back on the next request, otherwise
      // Gemini rejects with HTTP 400 "Function call is missing a thought_signature".
      // Carry the field as-is — opaque to us, validated by Gemini.
      if (p?.thought === true && typeof p.text === 'string') {
        const out: any = { reasoning: p.text };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (typeof p?.text === 'string') {
        const out: any = { text: p.text };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (p?.functionCall) {
        const out: any = {
          functionCall: {
            name: p.functionCall.name?.trim() || p.functionCall.name,
            args: p.functionCall.args || {},
            id: p.functionCall.id,
          },
        };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (p?.inlineData) {
        // Pass through inline image/audio data unchanged.
        mappedParts.push({ inlineData: p.inlineData });
      }
    }
    if (mappedParts.length > 0) {
      const content = { role: MESSAGE_ROLES.MODEL, parts: mappedParts };
      const resp = {
        candidates: [
          {
            content,
            ...(cand.finishReason ? { finishReason: cand.finishReason } : {}),
            index: 0,
          },
        ],
      };
      addFunctionCallsGetter(resp);
      addFunctionCallsGetter(content);
      yield resp as any as GenerateContentResponse;
    }
  }
  // Usage metadata may arrive on any chunk (often the last one) — forward it,
  // normalising Gemini's cache token field name so the UI footer can pick
  // up cache hits the same way it does for anthropic / openai-* providers.
  if (chunk?.usageMetadata) {
    yield {
      candidates: [],
      usageMetadata: normaliseGeminiUsageMetadata(chunk.usageMetadata),
    } as any;
  }
}

/**
 * Drop the most recent Gemini native request body to
 * `~/.otto/last-requests/{ts}_gemini-{kind}_{modelId}.json` so when EasyRouter
 * / Google returns a schema-validation HTTP 400 we can inspect the *exact*
 * contents we sent at byte level. Cheap (≤20KB usually), fire-and-forget,
 * never blocks the request.
 *
 * Mirrors OttoServerAdapter.dumpOutboundRequest():
 *   - Same dir: `~/.otto/last-requests/`
 *   - Same ring buffer: keep the latest N entries
 *
 * Safety:
 *   - Skipped under `vitest` so unit tests don't pollute the ring with
 *     synthetic dumps. The runner sets `VITEST` automatically.
 *   - Atomic via `.tmp` + rename so an in-flight crash never leaves
 *     half-written / mixed-with-old-content bytes.
 */
const GEMINI_DUMP_DIR_SEGMENTS = ['.otto-user', 'last-requests'] as const;
const GEMINI_DUMP_RING_SIZE = 5;

/**
 * Sanitise a model id for use as a filesystem name segment.
 *
 * Strategy:
 *   - Lowercase
 *   - Replace any non `[a-z0-9._-]` character with `-`
 *   - Collapse repeats and trim leading/trailing dashes
 *   - Cap length to keep total path short on Windows (MAX_PATH = 260)
 *   - Fall back to `unknown-model` if the result is empty
 */
function sanitiseModelIdForFilename(raw: string | undefined): string {
  const id = (raw ?? '').toLowerCase().trim();
  const cleaned = id
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return cleaned || 'unknown-model';
}

function dumpGeminiRequest(kind: 'unary' | 'stream', modelId: string, body: unknown): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  void (async () => {
    try {
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');

      const home = os.homedir();
      const dumpDir = path.join(home, ...GEMINI_DUMP_DIR_SEGMENTS);
      await fs.promises.mkdir(dumpDir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeModel = sanitiseModelIdForFilename(modelId);
      const ringFile = path.join(
        dumpDir,
        `${ts}_gemini-${kind}_${safeModel}.json`,
      );

      const payload = JSON.stringify(
        { kind, modelId, ts: new Date().toISOString(), body },
        null,
        2,
      );

      // Atomic write to ring entry.
      const tmp = ringFile + '.tmp';
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, ringFile);

      // Trim ring to the last GEMINI_DUMP_RING_SIZE Gemini entries
      // (OttoServerAdapter writes its own kinds in the same dir; we only
      // touch our own files identified by the `_gemini-` infix).
      try {
        const entries = await fs.promises.readdir(dumpDir);
        const stale = entries
          .filter((f) => /_gemini-(stream|unary)_/.test(f) && f.endsWith('.json'))
          .sort()
          .reverse() // newest first
          .slice(GEMINI_DUMP_RING_SIZE);
        await Promise.all(
          stale.map((f) => fs.promises.unlink(path.join(dumpDir, f)).catch(() => undefined)),
        );
      } catch {
        // ring trim is best-effort
      }
    } catch {
      // Diagnostic dump must never break the call.
    }
  })();
}

/**
 * Gemini native single-shot call (GenAI generateContent).
 */
export async function callGeminiNativeModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const url = buildGeminiNativeUrl(modelConfig, 'generateContent');
  const requestBody = buildGeminiNativeRequestBody(modelConfig, request);
  dumpGeminiRequest('unary', modelConfig.modelId, requestBody);

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(response.status, `Gemini native error (${response.status}): ${errorText}`, response);
      }
      const data = await response.json();
      const cand = data.candidates?.[0];
      const rawParts = cand?.content?.parts || [];
      const parts: any[] = [];
      for (const p of rawParts) {
        // See mapGeminiChunkToResponses() for why thoughtSignature must
        // be carried through to all part shapes that may emit it.
        if (p?.thought === true && typeof p.text === 'string') {
          const out: any = { reasoning: p.text };
          if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
          parts.push(out);
        } else if (typeof p?.text === 'string') {
          const out: any = { text: p.text };
          if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
          parts.push(out);
        } else if (p?.functionCall) {
          const out: any = {
            functionCall: {
              name: p.functionCall.name?.trim() || p.functionCall.name,
              args: p.functionCall.args || {},
              id: p.functionCall.id,
            },
          };
          if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
          parts.push(out);
        } else if (p?.inlineData) {
          parts.push({ inlineData: p.inlineData });
        }
      }

      const result = {
        candidates: [
          {
            content: { role: MESSAGE_ROLES.MODEL, parts: parts.length ? parts : [{ text: '' }] },
            ...(cand?.finishReason ? { finishReason: cand.finishReason } : { finishReason: FinishReason.STOP }),
            index: 0,
          },
        ],
        // Normalise Gemini's cachedContentTokenCount → cacheReadInputTokens
        // alias so the UI footer / cost calculator pick up cache hits the
        // same way they do for anthropic / openai-* providers. Verified by
        // scripts/probe-cache-fields.mjs.
        usageMetadata: normaliseGeminiUsageMetadata(data.usageMetadata),
      };
      addFunctionCallsGetter(result);
      return result as any as GenerateContentResponse;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );
}

/**
 * Gemini native streaming call (GenAI streamGenerateContent + alt=sse).
 *
 * EasyRouter follows Google's wire format: lines look like
 *   data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"…"}]}}]}
 * separated by blank lines. We tolerate both `\n` and `\r\n` framings and
 * a trailing partial chunk on the buffer between reads.
 */
export async function* callGeminiNativeModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  const url = buildGeminiNativeUrl(modelConfig, 'streamGenerateContent');
  const requestBody = buildGeminiNativeRequestBody(modelConfig, request);
  dumpGeminiRequest('stream', modelConfig.modelId, requestBody);

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(res.status, `Gemini native stream error (${res.status}): ${errorText}`, res);
      }
      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await readStreamWithIdleTimeout(reader);
      if (done) {
        buffer += decoder.decode(undefined, { stream: false });
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      // SSE events are separated by blank lines. Tolerate both \n\n and \r\n\r\n.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const ev of events) {
        // Only interested in `data:` lines; concatenate them per-event.
        let data = '';
        for (const line of ev.split(/\r?\n/)) {
          const trimmed = line.replace(/^\s+/, '');
          if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
        }
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          yield* mapGeminiChunkToResponses(chunk);
        } catch {
          // Tolerate malformed chunks — Gemini streaming occasionally
          // sends framing artefacts; swallow and continue.
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}


export async function* callCustomModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): AsyncGenerator<GenerateContentResponse> {
  console.log(`[CustomModel] Stream call: ${modelConfig.displayName} (${modelConfig.provider})`);
  // 🐛 [thinking-debug] 直连自定义模型路径 - 打印解析后的 thinking 配置
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m (custom-direct/stream) modelId=\x1b[36m${modelConfig.modelId}\x1b[0m  resolvedThinking=${JSON.stringify(resolveThinkingConfig(modelConfig))}`
  );

  // 🛡️ 协议安全网：复用 OttoChat.sanitizeRequestContents（即 fixRequestContents）
  // 修复 functionCall ↔ functionResponse 配对错乱、孤立 functionResponse、
  // 末尾 model 消息（破坏 Bedrock prefill 限制）等问题。
  // 该方法在 Gemini 原生路径已经经过长期打磨，CustomModel 路径直连（GCP/AWS/...）也必须走同一卫士。
  const requestToUse = request && Array.isArray(request.contents)
    ? { ...request, contents: OttoChat.sanitizeRequestContents(request.contents) }
    : request;

  if (modelConfig.provider === 'openai') yield* callOpenAICompatibleModelStream(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'openai-responses') yield* callOpenAIResponsesModelStream(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'anthropic') yield* callAnthropicModelStream(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'gemini') yield* callGeminiNativeModelStream(modelConfig, requestToUse, abortSignal);
  else throw new Error(`Unsupported custom model provider for streaming: ${modelConfig.provider}`);
}

export async function callCustomModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal
): Promise<GenerateContentResponse> {
  console.log(`[CustomModel] Unary call: ${modelConfig.displayName} (${modelConfig.provider})`);
  // 🐛 [thinking-debug] 直连自定义模型路径 - 打印解析后的 thinking 配置
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m (custom-direct/unary) modelId=\x1b[36m${modelConfig.modelId}\x1b[0m  resolvedThinking=${JSON.stringify(resolveThinkingConfig(modelConfig))}`
  );

  // 🛡️ 协议安全网：与 stream 路径保持一致，统一调用 fixRequestContents 清洗。
  const requestToUse = request && Array.isArray(request.contents)
    ? { ...request, contents: OttoChat.sanitizeRequestContents(request.contents) }
    : request;

  if (modelConfig.provider === 'openai') return callOpenAICompatibleModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'openai-responses') return callOpenAIResponsesModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'anthropic') return callAnthropicModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'gemini') return callGeminiNativeModel(modelConfig, requestToUse, abortSignal);
  else throw new Error(`Unsupported custom model provider: ${modelConfig.provider}`);
}

/**
 * @internal
 * 导出 parseJSONSafe 用于单元测试
 * 这是内部实现细节，不属于公开 API，可能随时变更
 */
export { parseJSONSafe as parseJSONSafeExport };

/**
 * @internal
 * Exported for the Gemini-native tool-schema sanitiser unit tests
 * (see customModelAdapter.test.ts → "sanitiseGeminiToolSchema"). These are
 * implementation details of the GenAI v1beta tool branch, not public API.
 */
export {
  sanitiseGeminiToolSchema as sanitiseGeminiToolSchemaExport,
  sanitiseGeminiTools as sanitiseGeminiToolsExport,
};
