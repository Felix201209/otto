import { logger } from '../utils/enhancedLogger.js';
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// DISCLAIMER: This is a copied version of https://github.com/googleapis/js-genai/blob/main/src/chats.ts with the intention of working around a key bug
// where function responses are not treated as "valid" responses: https://b.corp.google.com/issues/420354090

import {
  GenerateContentResponse,
  GenerateContentConfig,
  SendMessageParameters,
  createUserContent,
  Part,
  GenerateContentResponseUsageMetadata,
  Tool,
  ContentUnion,
} from '@google/genai';
import { Content, stripUIFieldsFromArray } from '../types/extendedContent.js';
import { CacheSafeParamsStore } from '../services/cacheSafeParams.js';
import { retryWithBackoff } from '../utils/retry.js';
import { isFunctionResponse, hasFunctionCall } from '../utils/messageInspectors.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { SceneType } from './sceneManager.js';
import { ContentGenerator, AuthType } from './contentGenerator.js';
import { Config } from '../config/config.js';
import { isDeepXQuotaError } from '../utils/quotaErrorDetection.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../telemetry/loggers.js';
import {
  ApiErrorEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  AgentContext,
} from '../telemetry/types.js';
import { DEFAULT_GEMINI_FLASH_MODEL, DEFAULT_GEMINI_MODEL } from '../config/models.js';
import { WorkflowTool } from '../tools/workflow.js';
import { tokenUsageEventManager } from '../events/tokenUsageEvents.js';
import { realTimeTokenEventManager } from '../events/realTimeTokenEvents.js';
import { SessionManager } from '../services/sessionManager.js';

/**
 * Returns true if the response is valid, false otherwise.
 */
function isValidResponse(response: GenerateContentResponse): boolean {
  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }
  const content = response.candidates[0]?.content;
  if (content === undefined) {
    return false;
  }
  return isValidContent(content);
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!part.thought && part.text !== undefined && part.text === '') {
      return false;
    }
  }
  return true;
}

/**
 * Validates the history contains the correct roles.
 *
 * @throws Error if the history does not start with a user turn.
 * @throws Error if the history contains an invalid role.
 */
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== MESSAGE_ROLES.USER && content.role !== MESSAGE_ROLES.MODEL) {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

/**
 * 检查内容是否为 reasoning（思考过程）
 * reasoning 会保留在 history 中由 DeepV Server 决定如何转发给上游协议
 * （DeepSeek 思考模式：带 tool_call 时必须回传，不带时服务器会忽略）
 */
function isReasoningContent(content: Content | undefined): boolean {
  return !!(
    content &&
    content.role === 'model' &&
    content.parts &&
    content.parts.length > 0 &&
    'reasoning' in content.parts[0]
  );
}

/**
 * Extracts the curated (valid) history from a comprehensive history.
 *
 * @remarks
 * The model may sometimes generate invalid or empty contents(e.g., due to safety
 * filters or recitation). Extracting valid turns from the history
 * ensures that subsequent requests could be accepted by the model.
 * reasoning 内容保留在 history 中，由 DeepV Server 决定如何转发给上游
 */
function extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
  if (comprehensiveHistory === undefined || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory: Content[] = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === MESSAGE_ROLES.USER) {
      curatedHistory.push(comprehensiveHistory[i]);
      i++;
    } else {
      const modelOutput: Content[] = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === MESSAGE_ROLES.MODEL) {
        const currentContent = comprehensiveHistory[i];
        modelOutput.push(currentContent);
        // reasoning content 在 isValidContent 下应当被视为有效
        // （它有 parts 且 parts[0] 有 reasoning 字段）
        if (isValid && !isValidContent(currentContent)) {
          isValid = false;
        }
        i++;
      }
      if (isValid && modelOutput.length > 0) {
        curatedHistory.push(...modelOutput);
      } else if (!isValid) {
        // Remove the last user input when model content is invalid.
        curatedHistory.pop();
      }
    }
  }
  return curatedHistory;
}

/**
 * Chat session that enables sending messages to the model with previous
 * conversation context.
 *
 * @remarks
 * The session maintains all the turns between user and model.
 */
export class GeminiChat {
  // A promise to represent the current state of the message being sent to the
  // model.
  private sendPromise: Promise<void> = Promise.resolve();

  // 保存创建时指定的模型，避免被config覆盖
  private specifiedModel: string;

  /**
   * Snapshot of the last successful request's parameters, populated after
   * each `sendMessage` / `sendMessageStream` succeeds. Forked side agents
   * (e.g. `/btw`) read from this to reuse the prompt-cache prefix.
   * Public for cross-package access without an extra getter call.
   */
  readonly cacheSafeParams = new CacheSafeParamsStore();

  constructor(
    private readonly config: Config,
    private readonly contentGenerator: ContentGenerator,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
    private readonly agentContext: AgentContext = { type: 'main' }, // 默认为主会话
    specifiedModel?: string // 新增：允许指定特定模型
  ) {
    validateHistory(history);
    // 优先使用指定模型，否则使用config模型
    this.specifiedModel = specifiedModel || this.config.getModel();
  }

  private _getRequestTextFromContents(contents: Content[]): string {
    return JSON.stringify(contents);
  }

  setSpecifiedModel(model: string): void {
    this.specifiedModel = model;
  }

  private async _logApiRequest(
    contents: Content[],
    model: string,
    prompt_id: string,
  ): Promise<void> {
    const requestText = this._getRequestTextFromContents(contents);
    logApiRequest(
      this.config,
      new ApiRequestEvent(model, prompt_id, requestText),
    );
  }

  private async _logApiResponse(
    durationMs: number,
    prompt_id: string,
    usageMetadata?: GenerateContentResponseUsageMetadata,
    responseText?: string,
    agentContext?: AgentContext,
  ): Promise<void> {
    logApiResponse(
      this.config,
      new ApiResponseEvent(
        this.config.getModel(),
        durationMs,
        prompt_id,
        this.config.getContentGeneratorConfig()?.authType,
        usageMetadata,
        responseText,
        undefined, // error
        agentContext,
      ),
    );

    // Update session token statistics
    if (usageMetadata && this.config.getProjectRoot()) {
      try {
        const sessionManager = new SessionManager(this.config.getProjectRoot());
        await sessionManager.updateTokenStats(
          this.config.getSessionId(),
          this.config.getModel(),
          {
            input_token_count: usageMetadata.promptTokenCount || 0,
            output_token_count: usageMetadata.candidatesTokenCount || 0,
            total_token_count: usageMetadata.totalTokenCount || 0,
            cached_content_token_count: usageMetadata.cachedContentTokenCount || 0,
            thoughts_token_count: 0, // Not available in usageMetadata
            tool_token_count: 0, // Not available in usageMetadata
            cache_creation_input_tokens: (usageMetadata as any).cacheCreationInputTokens || 0,
            cache_read_input_tokens: (usageMetadata as any).cacheReadInputTokens || 0,
          }
        );
      } catch (error) {
        // Log error but don't fail the API response logging
        console.warn('[SessionManager] Failed to update token stats:', error);
      }

      // 触发token使用更新事件，通知UI更新
      tokenUsageEventManager.emitTokenUsage({
        cache_creation_input_tokens: (usageMetadata as any).cacheCreationInputTokens || 0,
        cache_read_input_tokens: (usageMetadata as any).cacheReadInputTokens || 0,
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        credits_usage: (usageMetadata as any).creditsUsage || 0,
        model: this.config.getModel(),
        timestamp: Date.now(),
      });

      // 清除实时token显示，因为请求已完成
      realTimeTokenEventManager.clearRealTimeToken();
    }
  }

  private _logApiError(
    durationMs: number,
    error: unknown,
    prompt_id: string,
    agentContext?: AgentContext,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof Error ? error.name : 'unknown';

    logApiError(
      this.config,
      new ApiErrorEvent(
        this.config.getModel(),
        errorMessage,
        durationMs,
        prompt_id,
        this.config.getContentGeneratorConfig()?.authType,
        errorType,
        undefined, // status_code
        agentContext,
      ),
    );
  }

  /**
   * Handles falling back to Flash model when persistent 429 errors occur for OAuth users.
   * Uses a fallback handler if provided by the config; otherwise, returns null.
   */
  private async handleFlashFallback(
    authType?: string,
    error?: unknown,
  ): Promise<string | null> {
    // Only handle fallback for OAuth users
    // Flash fallback only supported for Google OAuth, not available with Cheeth OA
    return null;
  }

  /**
   * Sends a message to the model and returns the response.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessageStream} for streaming method.
   * @param params - parameters for sending messages within a chat session.
   * @returns The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessage({
   *   message: 'Why is the sky blue?'
   * });
   * logger.debug(response.text);
   * ```
   */
  async sendMessage(
    params: SendMessageParameters,
    prompt_id: string,
    scene: SceneType,
  ): Promise<GenerateContentResponse> {
    await this.sendPromise;
    const baseUserContent = createUserContent(params.message);
    // 🎯 添加 prompt_id 到用户内容中
    const userContent: Content = {
      ...baseUserContent,
      prompt_id
    };
    const originalContents = this.getHistory(true).concat(userContent);

    // 🔧 修正请求内容，确保 function call/response 成对出现
    const requestContents = this.fixRequestContents(originalContents);

    this._logApiRequest(requestContents, this.config.getModel(), prompt_id);

    const startTime = Date.now();
    let response: GenerateContentResponse;

    try {
      const apiCall = () => {
        const modelToUse = this.specifiedModel || DEFAULT_GEMINI_MODEL;

        // Prevent Flash model calls immediately after quota error
        if (
          this.config.getQuotaErrorOccurred() &&
          modelToUse === DEFAULT_GEMINI_FLASH_MODEL
        ) {
          throw new Error(
            'Please submit a new query to continue with the Flash model.',
          );
        }

        return this.contentGenerator.generateContent({
          model: modelToUse,
          contents: stripUIFieldsFromArray(requestContents),
          config: { ...this.generationConfig, ...params.config, tools: filterToolsByMessage(userContent, this.generationConfig.tools) as Tool[] },
        }, scene);
      };

      response = await retryWithBackoff(apiCall, {
        shouldRetry: (error: Error) => {
          if (error && error.message) {
            if (error.message.includes('429')) return true;
            if (error.message.match(/5\d{2}/)) return true;
          }
          return false;
        },
        onPersistent429: async (authType?: string, error?: unknown) =>
          await this.handleFlashFallback(authType, error),
        authType: this.config.getContentGeneratorConfig()?.authType,
      });
      const durationMs = Date.now() - startTime;
      await this._logApiResponse(
        durationMs,
        prompt_id,
        response.usageMetadata,
        JSON.stringify(response),
        this.agentContext,
      );

      this.sendPromise = (async () => {
        const outputContent = response.candidates?.[0]?.content;
        // Because the AFC input contains the entire curated chat history in
        // addition to the new user input, we need to truncate the AFC history
        // to deduplicate the existing chat history.
        const fullAutomaticFunctionCallingHistory =
          response.automaticFunctionCallingHistory;
        const index = this.getHistory(true).length;
        let automaticFunctionCallingHistory: Content[] = [];
        if (fullAutomaticFunctionCallingHistory != null) {
          automaticFunctionCallingHistory =
            fullAutomaticFunctionCallingHistory.slice(index) ?? [];
        }
        const modelOutput = outputContent ? [outputContent] : [];
        this.recordHistory(
          userContent,
          modelOutput,
          automaticFunctionCallingHistory,
        );
      })();
      await this.sendPromise.catch(() => {
        // Resets sendPromise to avoid subsequent calls failing
        this.sendPromise = Promise.resolve();
      });
      return response;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, prompt_id, this.agentContext);
      // 清除实时token显示，因为请求失败
      realTimeTokenEventManager.clearRealTimeToken();
      this.sendPromise = Promise.resolve();
      throw error;
    }
  }

  /**
   * 修正请求内容，确保 function call 和 function response 成对出现
   *
   * 处理逻辑：
   * 1. 检查历史中未完成的 function call
   * 2. 为未完成的 function call 添加 "user cancel" response
   * 3. 如果用户消息包含混合内容（text + function-response），调整顺序为 function-response 在前
   * 4. 🆕 检测并移除重复的 function response（同一个 functionCall 对应多个 response 时取第一个）
   * 5. 🆕 检测并警告多余的无匹配 function response（保留原有行为）
   *
   * @param requestContents 原始请求内容
   * @returns 修正后的请求内容
   */
  private fixRequestContents(requestContents: Content[]): Content[] {
    return GeminiChat.sanitizeRequestContents(requestContents);
  }

  /**
   * 静态版本的请求内容修复器，与实例方法 fixRequestContents 行为完全一致，
   * 但可被无 GeminiChat 实例的调用方直接复用（如 CustomModelAdapter、setHistory 兜底）。
   *
   * 之所以新增 static 入口而不是把 fixRequestContents 直接改成 static：
   *   - 保持外部所有现有调用点（this.fixRequestContents）零改动
   *   - 让所有协议路径（Gemini 原生 / DeepVServer / CustomModel）共享同一份实现，避免逻辑漂移
   *
   * 函数体保持不变；如需更新清洗规则，只在这里修改即可。
   */
  static sanitizeRequestContents(requestContents: Content[]): Content[] {
    // 🆕 [并行同名工具调用兜底] —— 在任何 dedup 之前给「同名 ≥2 且都无 id」的 fc/fr 配合成 id
    //
    // 触发场景（用户实拍 400，状态栏全程 [Gemini] gemini-3.5-flash，没切模型）：
    //   Gemini 原生上游报：
    //     "Please ensure that the number of function response parts
    //      is equal to the number of function call parts of the function call turn."
    //
    // 根因：Gemini 协议下 functionCall / functionResponse 的 `id` 字段不强制必填。
    //   当 Gemini 在一个 turn 里**并行调用 N 次同名工具**（比如同时 read_file
    //   多个文件、并行 replace 多处），写回的 N 个 fr 全是同 name 无 id。
    //   而下面去重阶段使用的 key = `id || name:${name}` 会让这 N 个 fr 全部 collide
    //   到同一个桶，只保留 1 个 → API 收到 N 个 fc 但只有 1 个 fr → 数量不等 → 400。
    //
    //   `unmatchedCalls` 那一步用的 isToolMatch 在双方都无 id 时回退到「只看 name」，
    //   N 个 fc 都"匹配"到唯一 1 个 fr，也不会触发 cancel 补全。
    //
    // 修复策略：进入任何 dedup 之前，专门针对「同名 ≥2 个无 id functionCall」这个
    //   触发条件启动「FIFO id 配对」—— 把同名的 fc / fr 按出现顺序一一配对，
    //   让每一对共享同一个「权威 id」，从根上消除 fc.id ≠ fr.id 的错位。
    //
    // 🐛 二次修复（2026-06-04，用户实拍切到 [Anthropic] claude-opus-4-8 后 400）：
    //   错误码原文：
    //     ValidationException: ***.***.content.1: unexpected `tool_use_id`
    //     found in `tool_result` blocks: read_file-1780549486950-5f6pb6trd.
    //     Each `tool_result` block must have a corresponding `tool_use` block.
    //
    //   病灶定位：`read_file-<ts>-<rand>` 是 coreToolScheduler 给 functionResponse
    //   强制写入的 callId（见 createFunctionResponsePart：`id: callId`），几乎总是存在；
    //   而 Gemini 原生 functionCall 通常无 id。旧实现的「合成 id 配对」只做了两件错事：
    //     1) 给无 id 的 fc 造了 `gem_synth_read_file_N`；
    //     2) 第 2 遍只回填「无 id」的 fr —— 但 fr 早就带着真实 callId，于是被整段跳过。
    //   结果 tool_use.id = gem_synth_read_file_1，tool_result.tool_use_id =
    //   read_file-<ts>-<rand>，两侧永不相等。更糟的是：这反而把下游 isToolMatch 的
    //   「ID 对齐」逻辑也击穿了（双方都有 id 但不等 → 不再 name 模糊匹配 → 不对齐）。
    //
    //   正确做法（本次）：权威 id 取值优先级 = fc 原始 id > fr 原始 id（CLI callId）>
    //   确定性合成 id。把这个权威 id 同时写回配对的 fc 和 fr，保证严格一致。
    //
    // 关键约束（保护现有行为，零回归）：
    //   - 仅当**同名无 id fc 出现 ≥2 次**才启动 —— 这是 bug 的唯一触发条件。
    //     单个无 id fc 的场景（Claude 跨模型迁移）继续走原 name 模糊匹配 + ID 对齐路径。
    //   - 已自洽（fc.id === fr.id）的配对先剔除，绝不被 FIFO 误配。
    //   - 合成 id 仅在 fc / fr 双方都无 id 时才用，且基于稳定 counter（幂等）。
    //   - 没匹配上的多余孤立 fr 会自然落入下面"移除孤立 functionResponse"分支。
    //   - 与 4343cb67 在 AnthropicConverter 内的合成 id 配对独立互不干扰。
    {
      // 第 0 步：扫描所有 functionCall，统计每个 name 下「无 id」实例的数量
      const noIdCallsByName = new Map<string, number>();
      for (const content of requestContents) {
        if (content.role !== MESSAGE_ROLES.MODEL || !content.parts) continue;
        for (const part of content.parts) {
          const fc = (part as any)?.functionCall;
          if (!fc || typeof fc !== 'object') continue;
          if (typeof fc.id === 'string' && fc.id.length > 0) continue;
          const name = typeof fc.name === 'string' ? fc.name : 'unknown';
          noIdCallsByName.set(name, (noIdCallsByName.get(name) ?? 0) + 1);
        }
      }

      // 仅对「同名 ≥2 个无 id fc」的 name 启动 FIFO 合成 id 配对
      const namesNeedingSynth = new Set<string>();
      for (const [name, count] of noIdCallsByName) {
        if (count >= 2) namesNeedingSynth.add(name);
      }

      if (namesNeedingSynth.size > 0) {
        let synthCounter = 0;
        const hasId = (x: any) => x && typeof x.id === 'string' && x.id.length > 0;

        // 收集目标 name 的 fc / fr（按文档出现顺序），用于 FIFO 配对。
        const callsByName = new Map<string, any[]>();
        const respsByName = new Map<string, any[]>();
        for (const content of requestContents) {
          if (!content.parts) continue;
          if (content.role === MESSAGE_ROLES.MODEL) {
            for (const part of content.parts) {
              const fc = (part as any)?.functionCall;
              if (!fc || typeof fc !== 'object') continue;
              const name = typeof fc.name === 'string' ? fc.name : 'unknown';
              if (!namesNeedingSynth.has(name)) continue;
              if (!callsByName.has(name)) callsByName.set(name, []);
              callsByName.get(name)!.push(fc);
            }
          } else if (content.role === MESSAGE_ROLES.USER) {
            for (const part of content.parts) {
              const fr = (part as any)?.functionResponse;
              if (!fr || typeof fr !== 'object') continue;
              const name = typeof fr.name === 'string' ? fr.name : 'unknown';
              if (!namesNeedingSynth.has(name)) continue;
              if (!respsByName.has(name)) respsByName.set(name, []);
              respsByName.get(name)!.push(fr);
            }
          }
        }

        for (const name of namesNeedingSynth) {
          const calls = callsByName.get(name) ?? [];
          const resps = respsByName.get(name) ?? [];

          // 步骤 A：先剔除「fc / fr 已带相同 id」的自洽配对，避免后续 FIFO 误配。
          const usedResp = new Set<number>();
          const pendingCalls: any[] = [];
          for (const fc of calls) {
            if (hasId(fc)) {
              const matchIdx = resps.findIndex(
                (fr, i) => !usedResp.has(i) && hasId(fr) && fr.id === fc.id,
              );
              if (matchIdx >= 0) {
                usedResp.add(matchIdx);
                continue;
              }
            }
            pendingCalls.push(fc);
          }
          const pendingResps = resps.filter((_, i) => !usedResp.has(i));

          // 步骤 B：对剩余的 fc·fr 按 FIFO 一一配对，让每对共享同一个「权威 id」。
          //
          // 🔑 权威 id 优先级：fc 原始 id > fr 原始 id（如 CLI 生成的 callId）> 确定性合成 id。
          //
          // 这一步是本次修复的核心：旧实现只给无 id 的 fc 造合成 id、却跳过「已带真实 id 的
          // fr」（functionResponse 的 id 由 coreToolScheduler 用 `${name}-${ts}-${rand}` 强制
          // 写入，几乎总是存在）。结果 tool_use.id = gem_synth_read_file_1，而
          // tool_result.tool_use_id = read_file-<ts>-<rand>，两侧永不相等 →
          //   Anthropic/Bedrock 400: unexpected `tool_use_id` found in `tool_result` blocks.
          // 现在改为把 fr 上已有的真实 id 回填到无 id 的 fc 上（双方共享同一 id），从根上消除错位。
          const n = Math.max(pendingCalls.length, pendingResps.length);
          for (let k = 0; k < n; k++) {
            const fc = pendingCalls[k];
            const fr = pendingResps[k];
            let canonical: string;
            if (hasId(fc)) canonical = fc.id;
            else if (hasId(fr)) canonical = fr.id;
            else if (fc) canonical = `gem_synth_${name}_${++synthCounter}`;
            else continue; // 多出来的孤立 fr（无对应 fc）：留给下面「移除孤立 functionResponse」处理
            if (fc) fc.id = canonical;
            if (fr) fr.id = canonical;
          }
        }
      }
    }

    const fixedContents: Content[] = [];

    // 🔍 辅助函数：判断 functionCall 和 functionResponse 是否匹配
    // 支持模糊匹配：如果其中一方缺少 ID，只要名称相同即视为匹配（兼容 Claude 等模型）
    const isToolMatch = (call: any, resp: any) => {
      if (!call || !resp || call.name !== resp.name) return false;
      if (call.id && resp.id) return call.id === resp.id;
      return true; // 其中一方缺少 ID，仅通过名称匹配
    };

    // 🔍 预先收集所有 function call 用于多余 response 检测
    const allFunctionCalls: Array<{
      call: any;
      messageIndex: number;
    }> = [];

    for (let i = 0; i < requestContents.length; i++) {
      const current = requestContents[i];
      if (current.role === MESSAGE_ROLES.MODEL && current.parts) {
        current.parts.forEach(part => {
          if (part.functionCall) {
            allFunctionCalls.push({
              call: part.functionCall,
              messageIndex: i
            });
          }
        });
      }
    }

    // 🎯 第一步：收集并仲裁所有 functionResponse（关键修复）
    // 当存在多个响应对应同一个 functionCall 时（如：自动补全的 cancel vs 延迟到达的真实结果），
    // 我们根据优先级进行仲裁：真实结果 > 取消占位符。
    // 注意：Map 的 key 逻辑已优化，如果存在带 ID 的响应，它将覆盖同名但不带 ID 的响应。
    const bestResponses: Map<string, { part: Part; priority: number; originalIndex: number }> = new Map();

    // 优先级判定函数
    const getPriority = (part: Part): number => {
      const result = (part.functionResponse?.response as any)?.result;
      return result === 'user cancel' ? 10 : 100;
    };

    // 1.1 预扫描所有消息，找出每个 callId 的最佳响应
    for (let i = 0; i < requestContents.length; i++) {
      const content = requestContents[i];
      if (content.role === MESSAGE_ROLES.USER && content.parts) {
        for (const part of content.parts) {
          if (part.functionResponse) {
            const resp = part.functionResponse;
            const priority = getPriority(part);

            // 智能 Key：如果带 ID，优先使用 ID；否则使用 name
            // 这样带 ID 的真实结果可以覆盖不带 ID 的占位符（Claude 场景）
            const key = resp.id || `name:${resp.name}`;

            const existing = bestResponses.get(key);
            if (!existing || priority > existing.priority) {
              bestResponses.set(key, { part, priority, originalIndex: i });
            }

            // 特殊逻辑：如果是带 ID 的响应，还要尝试覆盖掉只有 name 的记录
            if (resp.id) {
              const nameKey = `name:${resp.name}`;
              const nameExisting = bestResponses.get(nameKey);
              if (nameExisting && priority >= nameExisting.priority) {
                bestResponses.delete(nameKey); // 让位给带精准 ID 的响应
              }
            }
          }
        }
      }
    }

    // 1.2 重构内容，只保留最佳响应，并强制 ID 对齐
    const deduplicatedContents: Content[] = [];
    const usedResponseKeys: Set<string> = new Set();

    for (let i = 0; i < requestContents.length; i++) {
      const content = requestContents[i];
      if (content.role === MESSAGE_ROLES.USER && content.parts) {
        const filteredParts: Part[] = [];

        for (const part of content.parts) {
          if (part.functionResponse) {
            const resp = part.functionResponse;
            const key = resp.id || `name:${resp.name}`;
            const best = bestResponses.get(key);

            // 只有当当前 Part 就是该 callId 的“最佳响应”时，才保留它
            if (best && best.part === part && !usedResponseKeys.has(key)) {
              // 🎯 关键修复：强制 ID 对齐
              // 查找该响应对应的原始 functionCall，确保 ID 完全一致（兼容 Claude 严格协议）
              const matchingCall = allFunctionCalls.find(fc => isToolMatch(fc.call, resp));
              if (matchingCall) {
                if (matchingCall.call.id !== resp.id) {
                  logger.debug(
                    `[fixRequestContents] 🔧 ID 对齐：将响应 ${resp.name} 的 ID 从 "${resp.id || 'unnamed'}" ` +
                    `同步为调用方的 ID "${matchingCall.call.id || 'unnamed'}"`
                  );
                  resp.id = matchingCall.call.id;
                }
              }

              filteredParts.push(part);
              usedResponseKeys.add(key);
            } else {
              // 如果不带 ID 的响应被带 ID 的响应取代了，也会进入这里
              console.warn(
                `[fixRequestContents] 🗑️ 移除次优或重复的 functionResponse：${resp.name} (id: ${resp.id || 'unnamed'})。` +
                `保留优先级更高或更精准的响应。`
              );
            }
          } else {
            filteredParts.push(part);
          }
        }

        if (filteredParts.length > 0) {
          deduplicatedContents.push({ ...content, parts: filteredParts });
        }
      } else {
        deduplicatedContents.push(content);
      }
    }

    for (let i = 0; i < deduplicatedContents.length; i++) {
      const current = deduplicatedContents[i];
      fixedContents.push(current);

      // 🆕 检测用户消息中的孤立 function response（无匹配的 functionCall）
      if (current.role === MESSAGE_ROLES.USER && current.parts) {
        const functionResponses = current.parts.filter(part => part.functionResponse);
        if (functionResponses.length > 0) {
          const orphanedResponses = functionResponses.filter(respPart => {
            const functionResponse = respPart.functionResponse!;
            return !allFunctionCalls.some(({ call }) => {
              // 使用模糊匹配逻辑
              return isToolMatch(call, functionResponse);
            });
          });

          if (orphanedResponses.length > 0) {
            logger.debug(
              `[fixRequestContents] 检测到第${i + 1}条消息中有 ${orphanedResponses.length} 个孤立的 function response:`,
              orphanedResponses.map(r => ({
                name: r.functionResponse!.name,
                id: r.functionResponse!.id,
                result: (r.functionResponse!.response as any)?.result
              }))
            );
          }
        }
      }

      // 检查当前消息是否包含 function call
      const hasFunctionCall = current.role === MESSAGE_ROLES.MODEL &&
        current.parts?.some(part => part.functionCall);

      if (hasFunctionCall) {
        const next = deduplicatedContents[i + 1];

        // 获取当前消息中的所有 function call
        const functionCalls = current.parts?.filter(part => part.functionCall) || [];

        if (functionCalls.length > 0) {
          // 检查下一条消息中的 function response
          const nextFunctionResponses = next?.role === MESSAGE_ROLES.USER && next.parts ?
            next.parts.filter(part => part.functionResponse) : [];

          // 找出未匹配的 function call（使用模糊匹配）
          const unmatchedCalls = functionCalls.filter(callPart => {
            const functionCall = callPart.functionCall!;
            return !nextFunctionResponses.some(respPart => {
              const functionResponse = respPart.functionResponse!;
              return isToolMatch(functionCall, functionResponse);
            });
          });

          // 🎯 关键修复：只补全那些没有在任何地方有真实结果的 call
          // 如果 bestResponses 中有非 cancel 的响应，说明真实结果存在（可能在后续消息中），不需要补全
          const callsNeedingCancel = unmatchedCalls.filter(callPart => {
            const functionCall = callPart.functionCall!;
            const key = functionCall.id || `name:${functionCall.name}`;
            const best = bestResponses.get(key);

            // 如果 bestResponses 中存储的是真实结果（优先级 100），且不是我们当前看到的这条消息中的
            // 说明真实结果在后续消息中，不需要补全 cancel
            if (best && best.priority === 100 && best.originalIndex > i + 1) {
              logger.debug(`[fixRequestContents] ⏭️ 跳过补全 cancel：${functionCall.name} (id: ${functionCall.id || 'unnamed'})，真实结果将在后续消息中到达`);
              return false;
            }
            return true;
          });

          // 为未匹配的 function call 创建 "user cancel" response
          if (callsNeedingCancel.length > 0) {
            const cancelResponses = callsNeedingCancel.map(part => {
              const functionCall = part.functionCall!;
              return {
                functionResponse: {
                  name: functionCall.name,
                  response: { result: 'user cancel' },
                  ...(functionCall.id && { id: functionCall.id })
                }
              };
            });

            // 插入补全的 function response
            fixedContents.push({
              role: MESSAGE_ROLES.USER,
              parts: cancelResponses
            });

            logger.debug(`[fixRequestContents] 为第${i + 1}条消息补全了 ${callsNeedingCancel.length} 个未匹配的 function call`);
          }

          // 如果下一条消息有混合内容，调整 parts 顺序：function-response 在前，text 在后
          if (next && nextFunctionResponses.length > 0) {
            const textParts = next.parts?.filter(part => !part.functionResponse) || [];

            if (textParts.length > 0) {
              // 修改下一条消息的 parts 顺序
              deduplicatedContents[i + 1] = {
                ...next,
                parts: [...nextFunctionResponses, ...textParts]
              };
              logger.debug(`[fixRequestContents] 调整了第${i + 2}条消息的内容顺序，function-response 在前`);
            }
          }
        }
      }
    }

    // 🆕 最终清理：移除所有仍然孤立的 functionResponse
    // 这处理了 "functionResponse without preceding functionCall" 的情况
    // 这种情况可能发生在压缩后，或者历史记录损坏时
    const finalContents: Content[] = [];
    const finalToolCallStack: { [id: string]: boolean } = {};
    const finalToolCallNames: { [name: string]: boolean } = {};

    for (const content of fixedContents) {
      // 记录所有 function call
      if (content.role === MESSAGE_ROLES.MODEL && content.parts) {
        content.parts.forEach(part => {
          if (part.functionCall) {
            if (part.functionCall.id) finalToolCallStack[part.functionCall.id] = true;
            if (part.functionCall.name) finalToolCallNames[part.functionCall.name] = true;
          }
        });
        finalContents.push(content);
      } else if (content.role === MESSAGE_ROLES.USER && content.parts) {
        // 过滤 functionResponse
        const validParts = content.parts.filter(part => {
          if (!part.functionResponse) return true; // 保留非 functionResponse 部分

          const response = part.functionResponse;
          const hasMatchingId = response.id && finalToolCallStack[response.id];
          const hasMatchingName = response.name && finalToolCallNames[response.name];

          if (hasMatchingId || hasMatchingName) {
            return true;
          } else {
            console.warn(
              `[fixRequestContents] ❌ 移除孤立的 functionResponse：${response.name} (id: ${response.id})。` +
              `这个 response 没有对应的 function call。`
            );
            return false;
          }
        });

        if (validParts.length > 0) {
          finalContents.push({ ...content, parts: validParts });
        } else {
          console.warn(`[fixRequestContents] 移除空的用户消息（所有 functionResponse 都被过滤）`);
        }
      } else {
        finalContents.push(content);
      }
    }

    // 🔧 安全保障：确保 contents 不以 model/assistant 结尾
    // 某些模型（如 AWS Bedrock 上的 Claude）不支持 assistant prefill，
    // 要求对话必须以 user 消息结尾。如果上面的过滤逻辑移除了末尾的 user 消息
    // （例如因为孤立的 functionResponse 被全部过滤），末尾会变成 model 消息，
    // 导致 API 返回 400 错误。
    if (finalContents.length > 0) {
      const lastContent = finalContents[finalContents.length - 1];
      if (lastContent.role === MESSAGE_ROLES.MODEL) {
        console.warn('[fixRequestContents] ⚠️ Contents ends with model message after cleanup — appending user placeholder to prevent assistant-prefill error');
        finalContents.push({
          role: MESSAGE_ROLES.USER,
          parts: [{ text: '[Conversation continues]' }],
        });
      }
    }

    // 🔧 合并相邻同 role 消息（关键修复：解决"两条相邻 user 消息"导致的上游 400）
    //
    // 触发场景：流式响应中断后，客户端的恢复逻辑会注入一条独立的
    // user("[System] interrupted...continue") 消息，但这一条紧贴在前一条
    // user(functionResponse) 后面，形成 [user(fr), user(text)] 的相邻 user 序列。
    //
    // 当下游 OpenAI 兼容上游（如 deepseek-v4-pro 的 easyrouter）做协议规范化时，
    // 可能错误地认为后一条 user 把前一条 user 的 tool_result 截断了 —— 触发：
    //   "Messages with role 'tool' must be a response to a preceding message
    //    with 'tool_calls'"
    //
    // 修复：在请求最终发出前，把所有相邻同 role 消息的 parts 合并到第一条上。
    // 这对 user(fr) + user(text) 来说意味着把 text 加到 functionResponse 同一条 user 里，
    // 让上游看到一段完整的 "tool_use → tool_result" 配对，而 text 只是配对里的附加上下文。
    const mergedContents: Content[] = [];
    for (const content of finalContents) {
      const prev = mergedContents[mergedContents.length - 1];
      if (prev && prev.role === content.role) {
        prev.parts = [...(prev.parts || []), ...(content.parts || [])];
      } else {
        // 浅拷贝：避免直接修改 caller 持有的对象
        mergedContents.push({
          ...content,
          parts: content.parts ? [...content.parts] : undefined,
        });
      }
    }

    return mergedContents;
  }

  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   *   message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   *   logger.debug(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(
    params: SendMessageParameters,
    prompt_id: string,
    scene: SceneType,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    await this.sendPromise;

    const baseUserContent = createUserContent(params.message);
    // 🎯 添加 prompt_id 到用户内容中
    const userContent: Content = {
      ...baseUserContent,
      prompt_id
    };
    const originalContents = this.getHistory(true).concat(userContent);

    // 🔧 修正请求内容，确保 function call/response 成对出现
    const requestContents = this.fixRequestContents(originalContents);
    this._logApiRequest(requestContents, this.config.getModel(), prompt_id);

    const startTime = Date.now();

    try {
      const apiCall = () => {
        const modelToUse = this.specifiedModel || DEFAULT_GEMINI_MODEL;

        // Prevent Flash model calls immediately after quota error
        if (
          this.config.getQuotaErrorOccurred() &&
          modelToUse === DEFAULT_GEMINI_FLASH_MODEL
        ) {
          throw new Error(
            'Please submit a new query to continue with the Flash model.',
          );
        }

        return this.contentGenerator.generateContentStream({
          model: modelToUse,
          contents: stripUIFieldsFromArray(requestContents),
          config: { ...this.generationConfig, ...params.config, tools: filterToolsByMessage(userContent, this.generationConfig.tools) as Tool[] },
        }, scene);
      };

      // Note: Retrying streams can be complex. If generateContentStream itself doesn't handle retries
      // for transient issues internally before yielding the async generator, this retry will re-initiate
      // the stream. For simple 429/500 errors on initial call, this is fine.
      // If errors occur mid-stream, this setup won't resume the stream; it will restart it.
      const streamResponse = await retryWithBackoff(apiCall, {
        shouldRetry: (error: Error) => {
          // 🚫 DeepX配额错误不应重试 - 需要立即显示友好提示
          if (isDeepXQuotaError(error)) {
            return false;
          }

          // Check error messages for status codes, or specific error names if known
          if (error && error.message) {
            if (error.message.includes('429')) return true;
            // 451错误不重试 - 立即失败
            if (error.message.includes('REGION_BLOCKED_451') || error.message.includes('451')) return false;
            if (error.message.match(/5\d{2}/)) return true;
          }
          return false; // Don't retry other errors by default
        },
        onPersistent429: async (authType?: string, error?: unknown) =>
          await this.handleFlashFallback(authType, error),
        authType: this.config.getContentGeneratorConfig()?.authType,
      });

      // Resolve the internal tracking of send completion promise - `sendPromise`
      // for both success and failure response. The actual failure is still
      // propagated by the `await streamResponse`.
      this.sendPromise = Promise.resolve(streamResponse)
        .then(() => undefined)
        .catch(() => undefined);

      const result = this.processStreamResponse(
        streamResponse,
        userContent,
        startTime,
        prompt_id,
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, prompt_id, this.agentContext);
      // 清除实时token显示，因为请求失败
      realTimeTokenEventManager.clearRealTimeToken();
      this.sendPromise = Promise.resolve();
      throw error;
    }
  }

  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   *   empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   *     history.
   * @return History contents alternating between user and model for the entire
   *     chat session.
   */
  getHistory(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    // Deep copy the history to avoid mutating the history outside of the
    // chat session.
    return structuredClone(history);
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Adds a new entry to the chat history.
   *
   * @param content - The content to add to the history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
  }
  setHistory(history: Content[]): void {
    this.history = history;
  }

  setTools(tools: Tool[]): void {
    this.generationConfig.tools = tools;
  }

  /**
   * 获取工具声明（用于 token 计数等场景）
   * @returns 工具列表，如果未设置则返回 undefined
   */
  getTools(): typeof this.generationConfig.tools {
    return this.generationConfig.tools;
  }

  /**
   * 更新系统指令（用于动态更新系统提示，如当MCP prompts被发现时）
   * @param systemInstruction 新的系统指令
   */
  setSystemInstruction(systemInstruction: ContentUnion | undefined): void {
    this.generationConfig.systemInstruction = systemInstruction;
  }

  /**
   * 获取系统指令（用于 token 计数等场景）
   * @returns 系统指令内容，如果未设置则返回 undefined
   */
  getSystemInstruction(): ContentUnion | undefined {
    return this.generationConfig.systemInstruction;
  }

  getFinalUsageMetadata(
    chunks: GenerateContentResponse[],
  ): GenerateContentResponseUsageMetadata | undefined {
    const lastChunkWithMetadata = chunks
      .slice()
      .reverse()
      .find((chunk) => chunk.usageMetadata);

    return lastChunkWithMetadata?.usageMetadata;
  }

  private async *processStreamResponse(
    streamResponse: AsyncGenerator<GenerateContentResponse>,
    inputContent: Content,
    startTime: number,
    prompt_id: string,
  ) {
    const outputContent: Content[] = [];
    const chunks: GenerateContentResponse[] = [];
    let errorOccurred = false;

    try {
      for await (const chunk of streamResponse) {
        // 先检查是否是 reasoning 内容
        const content = chunk.candidates?.[0]?.content;
        const isReasoning = content && this.isReasoningContent(content);
        const isThought = content && this.isThoughtContent(content);

        // 收集所有有效的块，但排除 thought（thought 仅 UI 显示不入历史）
        // reasoning 仍然入 chunks 用于 API response 日志记录与 history 保留
        if ((isValidResponse(chunk) || chunk.usageMetadata) && !isThought) {
          chunks.push(chunk);
        }

        // 处理包含内容的有效响应
        if (isValidResponse(chunk)) {
          if (content !== undefined) {
            // thought 仅 UI 显示，不加入历史记录
            if (isThought) {
              yield chunk;
              continue;
            }
            // 🆕 reasoning content 也要进入 outputContent 以保留在 history 中
            // 由 DeepV Server 在转发到上游时按各家协议（如 DeepSeek）规则自行处理
            if (isReasoning) {
              this.appendReasoningToOutput(outputContent, content);
              yield chunk;
              continue;
            }
            // 🆕 FIX: 跳过只包含空白字符的内容，避免插入无意义的消息
            const hasOnlyWhitespace = content.parts?.every(part =>
              part.text !== undefined && part.text.trim() === ''
            );
            if (hasOnlyWhitespace) {
              yield chunk;
              continue;
            }
            outputContent.push(content);
          }
        }
        yield chunk;
      }
    } catch (error) {
      errorOccurred = true;
      const durationMs = Date.now() - startTime;
      this._logApiError(durationMs, error, prompt_id, this.agentContext);
      // 清除实时token显示，因为请求失败
      realTimeTokenEventManager.clearRealTimeToken();

      // 🎯 关键修复：即使发生错误（如用户取消），也要记录已经收到的内容
      // 如果模型已经输出了内容（尤其是 functionCall），记录它能保持历史记录的完整性，
      // 避免后续工具执行结果变成“孤立响应”。
      if (outputContent.length > 0) {
        this.recordHistory(inputContent, outputContent);
      }

      throw error;
    }

    if (!errorOccurred) {
      const durationMs = Date.now() - startTime;
      const allParts: Part[] = [];
      for (const content of outputContent) {
        if (content.parts) {
          allParts.push(...content.parts);
        }
      }
      await this._logApiResponse(
        durationMs,
        prompt_id,
        this.getFinalUsageMetadata(chunks),
        JSON.stringify(chunks),
        this.agentContext,
      );
      // 🎯 正常结束时记录历史
      this.recordHistory(inputContent, outputContent);
    }
  }

  private recordHistory(
    userInput: Content,
    modelOutput: Content[],
    automaticFunctionCallingHistory?: Content[],
  ) {
    // 过滤掉 thought 内容（thought 仅 UI 显示）
    // reasoning 内容保留进入 history，由 DeepV Server 决定如何转发给上游
    const nonThoughtModelOutput = modelOutput.filter(
      (content) => !this.isThoughtContent(content),
    );

    let outputContents: Content[] = [];
    if (
      nonThoughtModelOutput.length > 0 &&
      nonThoughtModelOutput.every((content) => content.role !== undefined)
    ) {
      outputContents = nonThoughtModelOutput;
    } else if (nonThoughtModelOutput.length === 0 && modelOutput.length > 0) {
      // This case handles when the model returns only a thought.
      // We don't want to add an empty model response in this case.
    } else {
      // When not a function response appends an empty content when model returns empty response, so that the
      // history is always alternating between user and model.
      // Workaround for: https://b.corp.google.com/issues/420354090
      if (!isFunctionResponse(userInput)) {
        outputContents.push({
          role: MESSAGE_ROLES.MODEL,
          parts: [],
        } as Content);
      }
    }
    if (
      automaticFunctionCallingHistory &&
      automaticFunctionCallingHistory.length > 0
    ) {
      this.history.push(
        ...extractCuratedHistory(automaticFunctionCallingHistory),
      );
    } else {
      this.history.push(userInput);
    }

    // 🔧 Enhanced consolidation logic to merge function calls into single messages
    const consolidatedOutputContents: Content[] = [];
    for (const content of outputContents) {
      // 跳过 thought 内容（reasoning 保留入 history）
      if (this.isThoughtContent(content)) {
        continue;
      }
      const lastContent =
        consolidatedOutputContents[consolidatedOutputContents.length - 1];

      // Check if current content has function calls
      const hasFunctionCalls = content.parts?.some(part => part.functionCall);
      const lastHasFunctionCalls = lastContent?.parts?.some(part => part.functionCall);

      if (this.isTextContent(lastContent) && this.isTextContent(content)) {
        // If both current and last are text, combine their text into the lastContent's first part
        // and append any other parts from the current content.
        lastContent.parts[0].text += content.parts[0].text || '';
        if (content.parts.length > 1) {
          lastContent.parts.push(...content.parts.slice(1));
        }
      } else if (hasFunctionCalls && lastHasFunctionCalls && lastContent.role === MESSAGE_ROLES.MODEL) {
        // 🚀 KEY FIX: Merge consecutive function calls into the same message
        // This ensures multiple function calls are stored as one model message with multiple parts
        logger.debug('[recordHistory] Merging consecutive function calls into single message');
        lastContent.parts?.push(...(content.parts || []));
      } else {
        consolidatedOutputContents.push(content);
      }
    }

    if (consolidatedOutputContents.length > 0) {
      const lastHistoryEntry = this.history[this.history.length - 1];
      const canMergeWithLastHistory =
        !automaticFunctionCallingHistory ||
        automaticFunctionCallingHistory.length === 0;

      if (
        canMergeWithLastHistory &&
        this.isTextContent(lastHistoryEntry) &&
        this.isTextContent(consolidatedOutputContents[0])
      ) {
        // If both current and last are text, combine their text into the lastHistoryEntry's first part
        // and append any other parts from the current content.
        lastHistoryEntry.parts[0].text +=
          consolidatedOutputContents[0].parts[0].text || '';
        if (consolidatedOutputContents[0].parts.length > 1) {
          lastHistoryEntry.parts.push(
            ...consolidatedOutputContents[0].parts.slice(1),
          );
        }
        consolidatedOutputContents.shift(); // Remove the first element as it's merged
      }
      this.history.push(...consolidatedOutputContents);
    }

    // 🎯 Snapshot cache-safe params at the natural end-of-turn boundary.
    // Forked side-question agents (`/btw`) read this to reuse the prompt
    // cache prefix on long histories. Best-effort: snapshot failure must
    // never break the main turn, so it's wrapped defensively.
    try {
      this.cacheSafeParams.set({
        model: this.specifiedModel,
        contents: stripUIFieldsFromArray(this.history.slice()),
        systemInstruction: this.generationConfig.systemInstruction,
        timestamp: Date.now(),
      });
    } catch (snapshotErr) {
      // Snapshot is an optimization, not load-bearing. Swallow.
      logger.warn(
        `[GeminiChat] cacheSafeParams snapshot failed (non-fatal): ${snapshotErr}`,
      );
    }
  }

  private isTextContent(
    content: Content | undefined,
  ): content is Content & { parts: [{ text: string }, ...Part[]] } {
    return !!(
      content &&
      content.role === 'model' &&
      content.parts &&
      content.parts.length > 0 &&
      typeof content.parts[0].text === 'string' &&
      content.parts[0].text !== ''
    );
  }

  private isThoughtContent(
    content: Content | undefined,
  ): content is Content & { parts: [{ thought: boolean }, ...Part[]] } {
    return !!(
      content &&
      content.role === 'model' &&
      content.parts &&
      content.parts.length > 0 &&
      typeof content.parts[0].thought === 'boolean' &&
      content.parts[0].thought === true
    );
  }

  /**
   * 检查内容是否为模型的 reasoning（思考过程）
   * reasoning 仍会保留在 history 中，由 DeepV Server 决定如何转发给上游
   * 直接调用外部函数
   */
  private isReasoningContent(content: Content | undefined): boolean {
    return isReasoningContent(content);
  }

  /**
   * 把流式 reasoning chunk 合并到 outputContent 末尾。
   * 如果末尾已经是 reasoning content，就把文本拼接进去；
   * 否则作为新的一条 model content 追加。
   * 这样可以避免几十上百个 reasoning chunk 各自变成一条 history 记录。
   */
  private appendReasoningToOutput(
    outputContent: Content[],
    chunkContent: Content,
  ): void {
    const incomingText = (chunkContent.parts || [])
      .map((p) => (typeof (p as any).reasoning === 'string' ? (p as any).reasoning : ''))
      .join('');
    if (!incomingText) return;

    const last = outputContent[outputContent.length - 1];
    if (last && this.isReasoningContent(last)) {
      const firstPart: any = last.parts?.[0];
      if (firstPart && typeof firstPart.reasoning === 'string') {
        firstPart.reasoning += incomingText;
        return;
      }
    }
    outputContent.push({
      role: MESSAGE_ROLES.MODEL,
      parts: [{ reasoning: incomingText } as any],
    });
  }
}

/**
 * Filter tools for a single request based on the current user message.
 *
 * WorkflowTool is only exposed when the user's message contains the exact
 * trigger word "workflow" (case-insensitive). This is a hard, per-request
 * enforcement layer that complements the prompt-level description constraints.
 * Historical context (prior workflow invocations) cannot bypass this gate.
 */
function filterToolsByMessage(userContent: Content, tools: unknown): unknown {
  if (!tools || !Array.isArray(tools)) return tools;

  const userText = (userContent.parts ?? [])
    .filter((p): p is { text: string } => typeof (p as any).text === 'string')
    .map(p => p.text)
    .join('');

  const hasWorkflowTrigger = /\bworkflow\b/i.test(userText);
  if (hasWorkflowTrigger) return tools;

  // Remove WorkflowTool from this request's tool declarations
  return (tools as Tool[]).map(toolGroup => {
    if (!toolGroup.functionDeclarations) return toolGroup;
    const filtered = toolGroup.functionDeclarations.filter(
      decl => decl.name !== WorkflowTool.Name,
    );
    return { ...toolGroup, functionDeclarations: filtered };
  });
}
