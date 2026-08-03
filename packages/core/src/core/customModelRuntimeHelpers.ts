import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { CustomModelConfig } from '../types/customModel.js';
import { getErrorStatus } from '../utils/retry.js';
import {
  CODEX_OAUTH_SENTINEL,
  CUSTOM_MODEL_DEFAULT_MAX_OUTPUT_TOKENS,
  CUSTOM_MODEL_STREAM_READ_IDLE_TIMEOUT_MS,
} from './customModelProviderContract.js';

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
export async function readStreamWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  timeoutMs: number = CUSTOM_MODEL_STREAM_READ_IDLE_TIMEOUT_MS,
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
 * 抄自 opencode：让 API key 不必经过终端粘贴（部分终端 / Windows / SSH 下
 * bracketed-paste 不稳，表现为「key 粘不进去」）。把 key 放进一个文件或环境变量
 * （在普通编辑器 / shell 里粘贴永远可靠），再用引用指向它即可：
 *
 *   {file:~/.otto-user/secrets/glm}   读取该文件内容（去首尾空白）—— 推荐，最稳
 *   {env:ZHIPU_API_KEY}               读取环境变量
 *   ${VAR} / $VAR                     读取环境变量（旧语法，向后兼容）
 *
 * 解析失败（文件不存在 / 变量未设）时原样返回，由上层报「缺 key」而非崩溃。
 */
export function resolveEnvVar(value: string): string {
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
export function isCodexAuth(
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
export async function resolveAuthHeaders(
  modelConfig: CustomModelConfig,
  resolvedApiKey: string,
): Promise<Record<string, string>> {
  if (isCodexAuth(modelConfig, resolvedApiKey)) {
    const { CodexAuthManager } = await import('./codexAuth.js');
    const h = await CodexAuthManager.getInstance().getAuthHeaders();
    const out: Record<string, string> = { Authorization: h.Authorization };
    if (h['chatgpt-account-id'])
      out['chatgpt-account-id'] = h['chatgpt-account-id'];
    return out;
  }
  return { Authorization: `Bearer ${resolvedApiKey}` };
}

/** 从请求里抽取 system 文本(Codex /responses 要求 instructions 非空)。 */
export function extractSystemText(request: Record<string, unknown>): string {
  const config = request.config && typeof request.config === 'object' ? request.config as Record<string, unknown> : {};
  const si = config.systemInstruction;
  if (!si) return '';
  if (typeof si === 'string') return si.trim();
  if (typeof si !== 'object' || si === null) return '';
  const siRecord = si as Record<string, unknown>;
  if (typeof siRecord.text === 'string') return siRecord.text.trim();
  if (Array.isArray(siRecord.parts)) {
    return siRecord.parts
      .map((p: unknown) => p && typeof p === 'object' && typeof (p as Record<string, unknown>).text === 'string' ? (p as Record<string, unknown>).text : '')
      .join('\n')
      .trim();
  }
  return '';
}

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
export function resolveOutputTokens(
  modelConfig: CustomModelConfig,
  thinkingMinimum?: number,
): number {
  const explicit =
    typeof modelConfig.maxOutputTokens === 'number' &&
    modelConfig.maxOutputTokens > 0
      ? modelConfig.maxOutputTokens
      : undefined;
  const base = explicit ?? CUSTOM_MODEL_DEFAULT_MAX_OUTPUT_TOKENS;
  // 思考型模型需要为思考预留 budget；如果 thinking budget 比当前 base 大，
  // 把 max_tokens 抬到至少 thinking budget + 一个余量，否则模型会把
  // 思考 budget 用完后没空间出文字。
  if (
    thinkingMinimum !== undefined &&
    thinkingMinimum > 0 &&
    thinkingMinimum >= base
  ) {
    return thinkingMinimum + 1024;
  }
  return base;
}

/**
 * 创建带状态码的错误对象，便于重试逻辑判断
 */
export function createHttpError(
  status: number,
  message: string,
  response?: Response,
): Error & { status: number; response?: { headers: Record<string, string> } } {
  const error = new Error(message) as Error & {
    status: number;
    response?: { headers: Record<string, string> };
  };
  error.status = status;

  // 尝试解析 Retry-After 头，传递给重试逻辑
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      error.response = {
        headers: { 'retry-after': retryAfter },
      };
    }
  }

  return error;
}

/**
 * 判断是否应该重试自定义模型请求
 * 重试条件：429 限流 或 5xx 服务器错误
 */
export function shouldRetryCustomModel(error: Error): boolean {
  const status = getErrorStatus(error);

  // ✅ 429 限流 - 重试
  if (status === 429) {
    console.warn(
      `[CustomModel] Rate limited (429), will retry with backoff...`,
    );
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
