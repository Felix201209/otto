/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 自定义模型提供商类型
 * - openai: OpenAI 兼容格式（OpenAI API、Azure OpenAI、Groq、Together AI 等）
 * - openai-responses: OpenAI Responses API 格式（使用 /responses 端点）
 * - anthropic: Anthropic Claude API 格式
 * - gemini: Google GenAI 原生格式（POST /v1beta/models/{id}:streamGenerateContent）
 *           与 Otto 自带 Gemini 路径完全对齐，原生支持 thinkingConfig / thoughts
 */
export type CustomModelProvider = 'openai' | 'openai-responses' | 'anthropic' | 'gemini';

/**
 * 标准化的"思考"配置，跨 provider 统一抽象
 *
 * - mode: on=强制启用 / off=强制禁用 / auto=遵从 provider 默认
 * - effort: 思考力度 low/medium/high；auto 表示由 provider 自定
 * - budgetTokens: 高级用户直接指定 budget tokens（仅 Anthropic 生效）
 *
 * Provider 映射关系：
 * | Provider          | 字段映射                                              |
 * |-------------------|-------------------------------------------------------|
 * | anthropic         | thinking.budget_tokens（low=4000/medium=16000/high=31999）|
 * | openai-responses  | reasoning.effort（low/medium/high 直传）              |
 * | openai (chat)     | 无控制字段，思考由模型自身决定（如 deepseek-reasoner）|
 */
export interface ThinkingConfig {
  /** 启用模式 */
  mode: 'on' | 'off' | 'auto';
  /** 思考力度，可选 */
  effort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'auto';
  /**
   * 直接指定 budget tokens（覆盖 effort）
   * 仅 Anthropic 3.7 / Gemini 2.5 生效
   */
  budgetTokens?: number;
}

/**
 * 默认 ThinkingConfig
 */
export const DEFAULT_THINKING_CONFIG: ThinkingConfig = {
  mode: 'auto',
  effort: 'auto',
};

/**
 * 把 effort 映射为 Anthropic budget_tokens (对于不支持 effort 的老模型/老接口兼容)
 * 参考：https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
 */
export function effortToAnthropicBudget(
  effort: ThinkingConfig['effort'] | undefined,
): number {
  switch (effort) {
    case 'low':
      return 4000;
    case 'medium':
      return 16000;
    case 'high':
    case 'max':
    case 'xhigh':
      return 31999;
    case 'auto':
    default:
      return 31999; // 默认采用官方推荐的最大预算
  }
}

/**
 * 把 effort 映射为 Anthropic Adaptive Thinking 的 effort 值。
 * 该值写入请求体 output_config.effort，而不是 thinking.effort。
 * Bedrock Claude Opus 4.7 会拒绝旧的 thinking.enabled/budget_tokens，
 * 并要求使用 thinking.adaptive + output_config.effort 控制思考强度。
 */
export function effortToAnthropicEffort(
  effort: ThinkingConfig['effort'] | undefined,
): 'low' | 'medium' | 'high' | 'max' | 'xhigh' | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' || effort === 'xhigh') {
    return effort;
  }
  return undefined;
}

/**
 * 将 Anthropic adaptive thinking 配置写入请求体。
 * 注意：现代 Claude 的思考强度字段属于 output_config.effort，
 * 不是 thinking.effort；否则 Bedrock 会返回 ValidationException。
 */
export function applyAnthropicAdaptiveThinking(
  requestBody: Record<string, unknown>,
  effort: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
): void {
  requestBody.thinking = {
    type: 'adaptive',
    display: 'summarized',
  };
  requestBody.output_config = {
    ...(typeof requestBody.output_config === 'object' && requestBody.output_config !== null
      ? requestBody.output_config as Record<string, unknown>
      : {}),
    effort,
  };
}

/**
 * 把 effort 映射为 OpenAI Responses / Chat Completions 的 reasoning_effort/reasoning.effort 值
 * @see https://platform.openai.com/docs/api-reference/responses/create#responses-create-reasoning
 */
export function effortToOpenAIEffort(
  effort: ThinkingConfig['effort'] | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
    return effort;
  }
  if (effort === 'max') {
    return 'xhigh'; // 🌟 max 映射为 OpenAI 的极致性能级别 xhigh (支持 o1/gpt-5.5)
  }
  // 'auto' 或 undefined：交给 OpenAI 默认值
  return undefined;
}

/**
 * 把 effort 映射为 Gemini 3 / 3.5 系列的 thinkingLevel
 * @see https://ai.google.dev/gemini-api/docs/thinking
 */
export function effortToGeminiLevel(
  effort: ThinkingConfig['effort'] | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'max':
    case 'xhigh':
      return 'high';
    case 'auto':
    default:
      return undefined; // 让 Gemini 默认决定 (一般 3.5 Flash 默认 medium, 3.1 Pro 默认 high)
  }
}

/**
 * 把 effort 映射为 Gemini 2.5 系列的 thinkingBudget token 数量
 */
export function effortToGeminiBudget(
  effort: ThinkingConfig['effort'] | undefined,
): number | undefined {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
    case 'max':
    case 'xhigh':
      return 16384;
    case 'auto':
      return -1; // 🌟 setting thinkingBudget to -1 turns on dynamic thinking (Gemini 2.5 官方推荐默认值)
    default:
      return undefined;
  }
}

/**
 * 判断给定的 Anthropic 模型是否为现代模型 (Claude 4.6, 4.7 及以上或 Mythos 系列)，
 * 这些模型使用 "adaptive" 思考模式，不再接受传统的 "enabled" + "budget_tokens"（会报 400）。
 */
export function isAdaptiveThinkingClaude(modelId: string): boolean {
  const lower = modelId.toLowerCase();

  // 1. Mythos 系列
  if (lower.includes('mythos')) return true;

  // 2. 正则匹配：Claude 4.6, 4.7 及 5.x 以上版本
  // 支持格式：claude-opus-4.7, claude-opus-4-7, claude-sonnet-4-6 等
  // 只取第一个数字版本对，避免把 claude-sonnet-4-5-20250929 误判为 5.x。
  const versionMatch = lower.match(/(?:^|[-@])(\d+)[.-](\d+)(?=$|[-@])/);
  if (versionMatch) {
    const major = parseInt(versionMatch[1], 10);
    const minor = parseInt(versionMatch[2], 10);
    if (major > 4 || (major === 4 && minor >= 6)) {
      return true;
    }
  }

  // 备选兼容（无点命名）：claude-4-6, claude-4-7, claude-5 等
  if (lower.includes('claude-4-6') || lower.includes('claude-4-7') || lower.includes('claude-4-8') || lower.includes('claude-5-')) {
    return true;
  }

  return false;
}

/**
 * 判断 provider 是否支持 thinking 强度调控
 */
export function providerSupportsThinkingControl(
  provider: CustomModelProvider,
): boolean {
  return (
    provider === 'anthropic' ||
    provider === 'openai-responses' ||
    provider === 'openai' ||
    provider === 'gemini'
  );
}

// ============================================================================
// OpenAI-compatible thinking dispatch (vendor-aware)
// ----------------------------------------------------------------------------
// 各厂商对 OpenAI 协议下的"思考"参数实现差异巨大：
//
// | 厂商                | 字段                                              | 说明                                  |
// |---------------------|---------------------------------------------------|---------------------------------------|
// | OpenAI (gpt/o1/o3)  | top-level `reasoning_effort`                      | minimal / low / medium / high / xhigh / none |
// | 智谱 GLM            | `extra_body.thinking = { type, clear_thinking }`  | enabled / disabled                    |
// | Qwen (DashScope)    | `extra_body.enable_thinking` (boolean)            | true / false                          |
// | DeepSeek / Kimi /   | （不识别任何 thinking 参数）                       | 不识别就直接回 400，必须不发           |
// |   Grok / MiniMax /  |                                                   |                                        |
// |   MiMo              |                                                   |                                        |
//
// 这份枚举与 {@link detectOpenAICompatibleVendor} 同步，
// applyOpenAIChatThinking() 据此做单一调度入口。
// ============================================================================

/**
 * 客户端能识别的 OpenAI 兼容厂商家族。
 * 'unknown' 表示我们不知道这家如何处理思考字段——必须**不发**任何思考相关字段。
 */
export type OpenAICompatibleVendor =
  | 'openai'   // OpenAI 官方 / GPT / o-series
  | 'glm'      // 智谱 GLM
  | 'qwen'     // 阿里 Qwen
  | 'unknown'; // DeepSeek, Kimi, Grok, MiniMax, MiMo, 其他

/**
 * 按 modelId 的关键字检测客户端识别的 OpenAI 兼容厂商家族。
 * 关键字与服务器端 OttoServerAdapter.applyGenAIThinkingConfig() 对齐。
 *
 * 命中规则按优先级（一旦命中即返回）：
 * - 'openai': 包含 'gpt' / 'o1' / 'o3' / 'o4'（裸 'o\d' 用 word-ish 边界避免误伤）
 * - 'glm': 包含 'glm'
 * - 'qwen': 包含 'qwen'
 * - 否则 'unknown'（DeepSeek / Kimi / Grok / MiniMax / MiMo / 其他）
 */
export function detectOpenAICompatibleVendor(modelId: string): OpenAICompatibleVendor {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return 'unknown';
  if (id.includes('gpt')) return 'openai';
  // 'o1' / 'o3' / 'o4' 系列：用 (^|[-/]) 前缀避免 'kimi' 'mimo' 等被误命中
  if (/(^|[-/])o[1-9](-|$)/.test(id)) return 'openai';
  if (id.includes('glm')) return 'glm';
  if (id.includes('qwen')) return 'qwen';
  return 'unknown';
}

/**
 * Apply thinking config to an OpenAI-compatible chat request body in-place,
 * routed by the model's vendor family.
 *
 * Mirrors OttoServerAdapter.applyGenAIThinkingConfig() so client-direct
 * (`callOpenAICompatibleModel`) and server-proxied paths produce identical
 * upstream requests.
 *
 * Behaviour matrix:
 * | vendor   | mode='off'                                  | mode='on'/'auto'                                                |
 * | -------- | ------------------------------------------- | ----------------------------------------------------------------|
 * | openai   | reasoning_effort='none'                     | reasoning_effort=<effortToOpenAIEffort> (omit if undefined)     |
 * | glm      | extra_body.thinking={type:'disabled'}       | extra_body.thinking={type:'enabled', clear_thinking:false}      |
 * | qwen     | extra_body.enable_thinking=false            | extra_body.enable_thinking=true                                 |
 * | unknown  | (no field — vendor doesn't recognise)       | (no field — vendor doesn't recognise)                           |
 *
 * @param requestBody  The mutable OpenAI chat request body.
 * @param modelId      The custom model id (used for vendor detection).
 * @param thinking     Resolved ThinkingConfig from {@link resolveThinkingConfig}.
 */
export function applyOpenAIChatThinking(
  requestBody: Record<string, unknown>,
  modelId: string,
  thinking: ThinkingConfig,
): void {
  const vendor = detectOpenAICompatibleVendor(modelId);

  // Helper: write/merge `extra_body` without clobbering caller-supplied keys.
  const writeExtraBody = (patch: Record<string, unknown>) => {
    const existing =
      typeof requestBody['extra_body'] === 'object' && requestBody['extra_body'] !== null
        ? (requestBody['extra_body'] as Record<string, unknown>)
        : {};
    requestBody['extra_body'] = { ...existing, ...patch };
  };

  switch (vendor) {
    case 'openai': {
      if (thinking.mode === 'off') {
        // Officially documented "no thinking" floor for gpt-5.x / o-series.
        requestBody['reasoning_effort'] = 'none';
      } else {
        const effort = effortToOpenAIEffort(thinking.effort);
        if (effort) {
          requestBody['reasoning_effort'] = effort;
        }
        // mode === 'auto' && effort === 'auto'  → emit nothing,
        // let the upstream model use its own default.
      }
      return;
    }
    case 'glm': {
      writeExtraBody({
        thinking:
          thinking.mode === 'off'
            ? { type: 'disabled' }
            : { type: 'enabled', clear_thinking: false }, // Preserved Thinking
      });
      return;
    }
    case 'qwen': {
      writeExtraBody({
        enable_thinking: thinking.mode !== 'off',
      });
      return;
    }
    case 'unknown':
    default:
      // Intentionally emit no field — DeepSeek / Kimi / Grok / MiniMax / MiMo /
      // unknown vendors reject reasoning_effort with HTTP 400.
      return;
  }
}

/**
 * 自定义模型配置接口
 * 支持用户配置标准OpenAI兼容格式和Claude API格式的自定义模型
 */
export interface CustomModelConfig {
  /** 显示名称，在UI中展示，同时作为唯一标识符 */
  displayName: string;

  /** 提供商类型 */
  provider: CustomModelProvider;

  /** API基础URL */
  baseUrl: string;

  /** API密钥，支持环境变量替换（如 ${OPENAI_API_KEY}） */
  apiKey: string;

  /** 模型ID（传递给API的实际模型名称） */
  modelId: string;

  /** 最大token数（上下文窗口大小） */
  maxTokens?: number;

  /**
   * 最大输出 token 数（生成响应的硬上限，对应 Anthropic `max_tokens` /
   * OpenAI Responses `max_output_tokens`）。
   *
   * 与 maxTokens 的区别：
   * - maxTokens 是上下文窗口（输入+输出之和），通常 100K~1M。
   * - maxOutputTokens 是单次响应输出的硬上限，通常 4K~64K。
   *   Anthropic 等 provider 会拒绝 max_tokens 超出该模型出参上限的请求，
   *   所以拿 1M 的上下文窗口直接当 max_tokens 发出去会立刻 400。
   *
   * 来源优先级（高到低）：
   * 1. EasyClaw `max_output_length` 元数据（EasyRouter 路径自动填）
   * 2. 用户手动编辑 ~/.otto/custom-models.json
   * 3. 适配器内置的 32K 统一兜底（见 customModelAdapter.ts 的
   *    DEFAULT_MAX_OUTPUT_TOKENS）
   *
   * 注意：向导里不暴露这一项 —— 32K 兜底对绝大多数现代模型都安全，
   * EasyClaw 元数据填充覆盖了 EasyRouter 路径，没必要再让用户配置。
   *
   * undefined 表示"未配置" —— 适配器会回退到 32K 默认值。
   */
  maxOutputTokens?: number;

  /** 是否启用此模型 */
  enabled?: boolean;

  /** 额外的HTTP headers（可选） */
  headers?: Record<string, string>;

  /** 超时时间（毫秒，可选） */
  timeout?: number;

  /**
   * @deprecated 使用 thinking 字段代替。保留此字段仅用于向后兼容旧配置文件。
   *
   * Enable Anthropic extended thinking (only for anthropic provider)
   * - true: Force enable thinking with budget_tokens = min(maxTokens - 1, 31999)
   * - false: Force disable thinking
   * - undefined (default): Auto-enable for all Anthropic models
   *   (Models that don't support thinking will ignore this parameter)
   *
   * When enabled, thinking content will be displayed in the UI as "Reasoning" before the response.
   * Official recommended budget_tokens: 31999
   * @see https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
   */
  enableThinking?: boolean;

  /**
   * 标准化的思考配置，跨 provider 统一抽象。
   * 当 thinking 字段存在时优先使用；否则回退到 enableThinking 字段（向后兼容）。
   *
   * 通过 /thinking 命令可以在运行时覆盖此配置。
   */
  thinking?: ThinkingConfig;
}

/**
 * 解析模型有效的 ThinkingConfig
 *
 * 优先级（高到低）：
 * 1. runtimeOverride（来自 /thinking 命令的会话级覆盖）
 * 2. modelConfig.thinking（模型级配置）
 * 3. modelConfig.enableThinking（向后兼容字段）
 * 4. provider 默认（auto）
 *
 * @param modelConfig 模型配置
 * @param runtimeOverride 运行时覆盖（来自 /thinking 命令）
 */
export function resolveThinkingConfig(
  modelConfig: CustomModelConfig,
  runtimeOverride?: ThinkingConfig,
): ThinkingConfig {
  if (runtimeOverride) {
    return runtimeOverride;
  }
  if (modelConfig.thinking) {
    return modelConfig.thinking;
  }
  // 向后兼容：旧的 enableThinking 字段
  if (modelConfig.enableThinking === true) {
    return { mode: 'on', effort: 'auto' };
  }
  if (modelConfig.enableThinking === false) {
    return { mode: 'off' };
  }
  return { ...DEFAULT_THINKING_CONFIG };
}

/**
 * 生成自定义模型的唯一键
 * 基于 provider + baseUrl + modelId 确定唯一性
 */
export function generateCustomModelKey(config: CustomModelConfig): string {
  return `${config.provider}|${config.baseUrl}|${config.modelId}`;
}

/**
 * 生成自定义模型的内部ID（用于 UI 选择和配置保存）
 * 格式: custom:{provider}:{modelId}@{baseUrlHash}
 *
 * 使用简短的 baseUrl hash 避免 ID 过长，同时保证唯一性
 */
export function generateCustomModelId(config: CustomModelConfig): string {
  // 简单的字符串哈希函数
  const hashString = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36).substring(0, 6);
  };

  const baseUrlHash = hashString(config.baseUrl);
  return `custom:${config.provider}:${config.modelId}@${baseUrlHash}`;
}

/**
 * @deprecated 使用 generateCustomModelId(config) 代替
 * 仅用于向后兼容旧格式 custom:{displayName}
 */
export function generateLegacyCustomModelId(displayName: string): string {
  return `custom:${displayName}`;
}

/**
 * 从内部ID提取provider
 * 支持新格式 custom:{provider}:{modelId}@{hash} 和旧格式 custom:{displayName}
 */
export function extractProvider(modelId: string): CustomModelProvider | null {
  if (!isCustomModel(modelId)) {
    return null;
  }
  const withoutPrefix = modelId.replace('custom:', '');
  if (withoutPrefix.startsWith('openai-responses:')) {
    return 'openai-responses';
  }
  if (withoutPrefix.startsWith('openai:')) {
    return 'openai';
  }
  if (withoutPrefix.startsWith('anthropic:')) {
    return 'anthropic';
  }
  return null;
}

/**
 * 验证自定义模型配置
 */
export function validateCustomModelConfig(config: CustomModelConfig): string[] {
  const errors: string[] = [];

  if (!config.displayName || typeof config.displayName !== 'string') {
    errors.push('displayName is required and must be a string');
  }

  if (!['openai', 'openai-responses', 'anthropic', 'gemini'].includes(config.provider)) {
    errors.push('provider must be one of: openai, openai-responses, anthropic, gemini');
  }

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push('baseUrl is required and must be a string');
  }

  if (!config.apiKey || typeof config.apiKey !== 'string') {
    errors.push('apiKey is required and must be a string');
  }

  if (!config.modelId || typeof config.modelId !== 'string') {
    errors.push('modelId is required and must be a string');
  }

  if (config.maxTokens !== undefined && (typeof config.maxTokens !== 'number' || config.maxTokens <= 0)) {
    errors.push('maxTokens must be a positive number if specified');
  }

  if (config.maxOutputTokens !== undefined && (typeof config.maxOutputTokens !== 'number' || config.maxOutputTokens <= 0)) {
    errors.push('maxOutputTokens must be a positive number if specified');
  }

  if (config.timeout !== undefined && (typeof config.timeout !== 'number' || config.timeout <= 0)) {
    errors.push('timeout must be a positive number if specified');
  }

  return errors;
}

/**
 * 检查模型是否为自定义模型
 * 格式: custom:{displayName}
 */
export function isCustomModel(modelName: string): boolean {
  return modelName.startsWith('custom:');
}

// ============================================================================
// EasyRouter (https://llm-endpoint.net) 集成
// ============================================================================

/**
 * EasyRouter 的固定 base URL。
 * 所有 EasyRouter 模型都共享同一个 endpoint，用户只需提供 API Key。
 */
export const EASY_ROUTER_BASE_URL = 'https://llm-endpoint.net/v1';

/**
 * EasyRouter 模型的默认上下文窗口（tokens）。
 *
 * 当 EasyClaw `/api/v1/public-model-list` 没有该模型的元数据
 * （或返回的 max_context_length 为非正数）时，我们用这个值作为兜底，
 * 确保 ~/.otto/custom-models.json 里每条 EasyRouter 条目都带有
 * 一个保守的 maxTokens，UI 与下游 token 预算计算可以直接使用。
 *
 * 200_000 ≈ 当前主流模型的常见 200K 上下文窗口
 * （GLM-5 / Claude Haiku / Kimi 等都是这个量级），
 * 对未知模型来说既不会过度乐观也不会过度保守。
 */
export const EASY_ROUTER_DEFAULT_MAX_TOKENS = 200_000;

/**
 * 用于过滤 EasyRouter /v1/models 列表的关键字。
 * 模型 id（小写后）包含其中任一关键字时会被排除——因为 Otto
 * 当前主要面向文本/对话模型，图像/嵌入/视频/视频生成模型并不适用。
 *
 * 关键字一览：
 * - image / embed / video：通用类别词
 * - seedance / seed：字节 Seedance 系列（视频生成；"seed" 作为词缀也涵盖 seed-* 视觉模型）
 * - veo：Google Veo 视频生成系列
 * - tts：TTS 语音合成模型（如 gemini-2.5-flash-tts、gpt-4o-mini-tts 等）
 */
export const EASY_ROUTER_EXCLUDE_KEYWORDS: readonly string[] = [
  'image',
  'embed',
  'video',
  'seedance',
  'seed',
  'veo',
  'tts',
];

/**
 * EasyRouter /v1/models 接口返回的单条模型条目（仅声明用到的字段）。
 */
export interface EasyRouterModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  supported_endpoint_types?: string[];
}

/**
 * 判断 EasyRouter 返回的模型 id 是否应该被过滤掉。
 * - 大小写不敏感
 * - 命中任意 {@link EASY_ROUTER_EXCLUDE_KEYWORDS} 即过滤
 */
export function shouldExcludeEasyRouterModel(modelId: string): boolean {
  if (!modelId || typeof modelId !== 'string') {
    return true;
  }
  const lower = modelId.toLowerCase();
  return EASY_ROUTER_EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 过滤 EasyRouter 模型列表，去掉空条目和命中关键字的条目，
 * 同时按 id 字典序稳定排序。
 */
export function filterEasyRouterModels(
  entries: ReadonlyArray<EasyRouterModelEntry | { id?: unknown } | null | undefined>,
): EasyRouterModelEntry[] {
  const seen = new Set<string>();
  const result: EasyRouterModelEntry[] = [];
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (shouldExcludeEasyRouterModel(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(entry as EasyRouterModelEntry);
  }
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

/**
 * 根据 EasyRouter 的模型 id 决定 Otto 走哪个内部协议适配器。
 *
 * 规则（按用户产品要求）：
 * - 以 "gpt" 开头 → 使用 OpenAI Responses 协议（/v1/responses）
 * - 以 "claude" 开头 → 使用 Anthropic 协议
 * - 其他全部 → 使用 OpenAI Chat Completions 协议
 *
 * 注意：判断只看模型 id 前缀（去掉首尾空白后的小写形式），不看 supported_endpoint_types，
 * 这样即使上游临时改了 supported_endpoint_types 也不会影响行为。
 */
export function classifyEasyRouterModel(modelId: string): CustomModelProvider {
  const id = (modelId ?? '').trim().toLowerCase();
  if (id.startsWith('gemini')) {
    // Gemini 走原生 GenAI 协议，与 Otto 自带同路，完整支持 thinkingConfig + thoughts
    return 'gemini';
  }
  if (id.startsWith('gpt')) {
    return 'openai-responses';
  }
  if (id.startsWith('claude')) {
    return 'anthropic';
  }
  return 'openai';
}

/**
 * 把 EasyRouter 的一条模型条目转换为可直接持久化的 {@link CustomModelConfig}。
 *
 * - displayName 默认就是模型 id（用户可在 UI 后续编辑）；如果同名已存在，
 *   调用方应自行去重（一般通过 generateCustomModelId 比较）。
 * - baseUrl 固定为 {@link EASY_ROUTER_BASE_URL}
 * - apiKey 由调用方传入
 * - provider 由 {@link classifyEasyRouterModel} 决定
 * - maxTokens 解析顺序（高优先级到低）：
 *   1. options.maxTokens 显式覆盖
 *   2. options.metadata.max_context_length（来自 EasyClaw 元数据，>0）
 *   3. {@link EASY_ROUTER_DEFAULT_MAX_TOKENS}（200K 兜底）
 *   永远不会返回 undefined，保证持久化条目都有可用的上下文上限。
 */
export function buildEasyRouterModelConfig(
  modelId: string,
  apiKey: string,
  options?: {
    displayName?: string;
    maxTokens?: number;
    maxOutputTokens?: number;
    /**
     * 命中 EasyClaw `/api/v1/public-model-list` 时拿到的元数据。
     * 用于 maxTokens / maxOutputTokens 的自动填充——displayName 行为保持原样
     * （=modelId），让 ~/.otto/custom-models.json 中已经存在的同名条目
     * 可被原地覆盖。
     */
    metadata?: EasyClawModelMetadata;
  },
): CustomModelConfig {
  const provider = classifyEasyRouterModel(modelId);
  const explicit =
    typeof options?.maxTokens === 'number' && options.maxTokens > 0
      ? options.maxTokens
      : undefined;
  const fromMetadata =
    typeof options?.metadata?.max_context_length === 'number' &&
    options.metadata.max_context_length > 0
      ? options.metadata.max_context_length
      : undefined;
  const resolvedMaxTokens =
    explicit ?? fromMetadata ?? EASY_ROUTER_DEFAULT_MAX_TOKENS;

  // maxOutputTokens 单独解析，不沿用 EASY_ROUTER_DEFAULT_MAX_TOKENS（200K）
  // —— 因为 200K 对于大多数模型的 output cap 来说严重超标，会被 Anthropic 等
  // provider 直接拒绝。这里宁可不填（undefined），交给适配器各自 provider 默认
  // （Anthropic 8192 / OpenAI 4096 等），也不要瞎填一个会触发 400 的值。
  const explicitOutput =
    typeof options?.maxOutputTokens === 'number' && options.maxOutputTokens > 0
      ? options.maxOutputTokens
      : undefined;
  const fromMetadataOutput =
    typeof options?.metadata?.max_output_length === 'number' &&
    options.metadata.max_output_length > 0
      ? options.metadata.max_output_length
      : undefined;
  const resolvedMaxOutputTokens = explicitOutput ?? fromMetadataOutput;

  return {
    displayName: options?.displayName?.trim() || modelId,
    provider,
    baseUrl: EASY_ROUTER_BASE_URL,
    apiKey,
    modelId,
    maxTokens: resolvedMaxTokens,
    ...(resolvedMaxOutputTokens !== undefined ? { maxOutputTokens: resolvedMaxOutputTokens } : {}),
    enabled: true,
  };
}

// ============================================================================
// EasyClaw public model metadata (https://api.easyclaw.work)
// ----------------------------------------------------------------------------
// EasyRouter (`/v1/models`) only returns model ids. EasyClaw exposes a sibling
// public endpoint (`/api/v1/public-model-list`) that publishes per-model
// context window / output limits / pricing. We use it ONLY to auto-fill
// `maxTokens` for newly added models — nothing else depends on EasyClaw being
// reachable, so missing metadata is silently tolerated.
// ============================================================================

/**
 * EasyClaw public-model-list base URL.
 */
export const EASY_CLAW_METADATA_URL =
  'https://api.easyclaw.work/api/v1/public-model-list';

/**
 * Single model metadata entry as returned by
 * `GET /api/v1/public-model-list`. Field names mirror the API verbatim
 * (snake_case) to avoid translation bugs at the boundary.
 */
export interface EasyClawModelMetadata {
  model_id: string;
  display_name?: string;
  capabilities?: string[];
  /** Maximum context window (tokens). */
  max_context_length?: number;
  /** Maximum output length (tokens). */
  max_output_length?: number;
  billing?: {
    credits_per_usd?: number;
    /** Price-per-request (USD-equivalent, used as a hint only). */
    per_request_price?: number;
  };
  created_at?: string;
}

/**
 * Build a fast lookup map keyed by model_id from a metadata list.
 * Returns an empty Map for null/undefined/non-array input so callers can
 * treat "metadata unavailable" the same as "metadata empty".
 */
export function indexEasyClawMetadata(
  list: ReadonlyArray<EasyClawModelMetadata | { model_id?: unknown } | null | undefined> | null | undefined,
): Map<string, EasyClawModelMetadata> {
  const map = new Map<string, EasyClawModelMetadata>();
  if (!list || !Array.isArray(list)) return map;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as { model_id?: unknown }).model_id;
    if (typeof id !== 'string' || id.length === 0) continue;
    map.set(id, entry as EasyClawModelMetadata);
  }
  return map;
}
