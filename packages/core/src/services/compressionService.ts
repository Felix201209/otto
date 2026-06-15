/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { Tool } from '@google/genai';
import { Content } from '../types/extendedContent.js';
import { ChatCompressionInfo } from '../core/turn.js';
import { ContentGenerator } from '../core/contentGenerator.js';
import { SceneType } from '../core/sceneManager.js';
import { getCompressionPrompt, formatCompactSummary } from '../core/prompts.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { getErrorMessage } from '../utils/errors.js';
import { GeminiClient } from '../core/client.js';
import { Config } from '../config/config.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { retryWithBackoff } from '../utils/retry.js';

/**
 * 对话历史压缩服务配置
 */
export interface CompressionServiceConfig {
  /**
   * 压缩触发阈值：当对话历史token数量超过模型限制的此倍数时触发压缩
   * 默认: 0.7 (70%)
   */
  compressionTokenThreshold?: number;

  /**
   * 压缩保留阈值：压缩后保留最近历史的倍数
   * 默认: 0.3 (30%)
   */
  compressionPreserveThreshold?: number;

  /**
   * 跳过环境信息的数量：通常前2条消息是环境设置
   * 默认: 2 (用户环境信息 + 模型确认)
   */
  skipEnvironmentMessages?: number;

  /**
   * 连续压缩失败熔断阈值：连续失败超过此次数后停止自动压缩
   * 默认: 3
   */
  maxConsecutiveFailures?: number;
}

/**
 * 对话历史压缩结果
 */
export interface CompressionResult {
  success: boolean;
  compressionInfo?: ChatCompressionInfo;
  error?: string;
  summary?: string;
  newHistory?: Content[];
  skipReason?: string;
}

/**
 * 查找指定比例后的内容索引
 * 导出用于测试目的
 */
export function findIndexAfterFraction(
  history: Content[],
  fraction: number,
): number {
  if (fraction <= 0 || fraction >= 1) {
    throw new Error('Fraction must be between 0 and 1');
  }

  const contentLengths = history.map(
    (content) => JSON.stringify(content).length,
  );

  const totalCharacters = contentLengths.reduce(
    (sum, length) => sum + length,
    0,
  );

  // Calculate the maximum characters we want to keep (the complement of fraction)
  // e.g. if fraction is 0.7 (compress 70%), we want to keep at most 30%
  const maxKeepCharacters = totalCharacters * (1 - fraction);

  let keptCharacters = 0;
  // Iterate backwards to find the cut-off point
  for (let i = contentLengths.length - 1; i >= 0; i--) {
    const currentLength = contentLengths[i];

    // If adding this message exceeds our keep limit, this message must be compressed
    if (keptCharacters + currentLength > maxKeepCharacters) {
      // The cut-off is after this message (i.e., this message is included in compression)
      // Return i + 1 because slice(0, k) excludes k, so we want slice(0, i+1) to include i
      return i + 1;
    }

    keptCharacters += currentLength;
  }

  // If we can keep everything (unlikely given we are compressing), return 0
  // This means compress nothing, keep everything
  return 0;
}

/**
 * 对话历史压缩服务
 * 提供统一的对话历史压缩功能，可被 client.ts 和 subAgent.ts 共同使用
 */
export class CompressionService {
  private readonly compressionTokenThreshold: number;
  private readonly compressionPreserveThreshold: number;
  private readonly skipEnvironmentMessages: number;
  private readonly maxConsecutiveFailures: number;

  /** 连续自动压缩失败计数（熔断器） */
  private consecutiveAutoCompressFailures: number = 0;

  /**
   * 受保护的工具列表
   */
  private static readonly PROTECTED_TOOLS = ['skill', 'use_skill'];

  constructor(config: CompressionServiceConfig = {}) {
    this.compressionTokenThreshold = config.compressionTokenThreshold ?? 0.8;
    this.compressionPreserveThreshold = config.compressionPreserveThreshold ?? 0.3;
    this.skipEnvironmentMessages = config.skipEnvironmentMessages ?? 2;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  }

  /**
   * 检查熔断器是否已触发（连续失败过多）
   */
  isCircuitBreakerTripped(): boolean {
    return this.consecutiveAutoCompressFailures >= this.maxConsecutiveFailures;
  }

  /**
   * 重置熔断器（例如手动压缩成功后）
   */
  resetCircuitBreaker(): void {
    this.consecutiveAutoCompressFailures = 0;
  }

  /**
   * 获取连续失败次数
   */
  getConsecutiveFailures(): number {
    return this.consecutiveAutoCompressFailures;
  }

  /**
   * 寻找合适的工具调用边界作为压缩分割点
   * 从startIndex开始寻找第一个user消息进行切分，同时确保不在tool_use和tool_result之间切割
   * @param history 对话历史
   * @param startIndex 开始搜索的索引位置
   * @returns 合适的切分索引，如果没找到返回-1表示不应压缩
   */
  private findToolCallBoundary(history: Content[], startIndex: number): number {
    // 边界检查
    if (startIndex >= history.length) {
      console.warn(`[findToolCallBoundary] startIndex (${startIndex}) >= history.length (${history.length}), no suitable boundary found`);
      return -1; // 没有合适的压缩区间
    }

    console.log(`[findToolCallBoundary] Searching from index ${startIndex} to ${history.length - 1}, total history length: ${history.length}`);

    // Helper function to check if a part contains a protected tool
    const isProtectedTool = (part: any): boolean => {
      const toolName = part.functionResponse?.name || part.functionCall?.name;
      return toolName && CompressionService.PROTECTED_TOOLS.includes(toolName);
    };

    // 策略1：首先寻找user消息作为首选边界
    // 从startIndex开始寻找第一个user消息
    // 同时确保不会在tool_use和tool_result之间切割
    for (let i = startIndex; i < history.length; i++) {
      const msg = history[i];
      const msgInfo = `[${i}] role=${msg.role}`;

      // 🛡️ 检查是否包含受保护的工具
      if (msg.parts) {
        const protectedToolPart = msg.parts.find(isProtectedTool);
        const hasProtectedTool = !!protectedToolPart;

        if (hasProtectedTool) {
          const toolName = protectedToolPart.functionResponse?.name || protectedToolPart.functionCall?.name;
          console.log(`${msgInfo} - PROTECTED TOOL FOUND: ${toolName}, skipping this boundary`);
        }

        // 如果包含受保护工具，跳过这条消息作为边界
        if (hasProtectedTool) {
          continue;
        }
      }

      if (msg.role === 'user') {
        // 检查i-1处是否有未完成的tool调用
        if (i > 0) {
          const prevMsg = history[i - 1];
          // 如果前一个消息是model消息，检查其是否只包含functionCall（还没有响应）
          if (prevMsg.role === MESSAGE_ROLES.MODEL && prevMsg.parts) {
            const hasFunctionCall = prevMsg.parts.some((p: any) => p.functionCall);
            const hasToolResult = prevMsg.parts.some((p: any) => p.toolResult);

            // 如果有functionCall但没有toolResult，这表示tool还未响应，继续寻找
            if (hasFunctionCall && !hasToolResult) {
              console.log(`${msgInfo} (user) - SKIP: previous model message has pending tool call`);
              continue; // 跳过这个user消息，继续寻找下一个
            }
          }
        }

        // 这是一个安全的切割点（要么是第一个消息，要么前面没有待响应的tool调用）
        console.log(`${msgInfo} (user) - FOUND SUITABLE BOUNDARY at index ${i + 1}`);
        return i + 1; // 压缩到这个user消息（包含），保留后面的内容
      } else {
        const partTypes = msg.parts?.map((p: any) => {
          if (p.text) return 'text';
          if (p.functionCall) return 'functionCall';
          if (p.toolResult) return 'toolResult';
          return 'unknown';
        }).join(',') || 'empty';
        console.log(`${msgInfo} - skipping, parts=[${partTypes}]`);
      }
    }

    // 策略2：如果找不到user消息，回退到寻找model消息且包含text的消息作为备选边界
    console.warn(`[findToolCallBoundary] No suitable user message boundary found. Trying fallback strategy with model messages...`);
    for (let i = history.length - 1; i >= startIndex; i--) {
      const msg = history[i];
      if (msg.role === MESSAGE_ROLES.MODEL && msg.parts?.some((p: any) => p.text)) {
        // 找到一个包含text的model消息，这也是一个合理的切割点
        console.log(`[findToolCallBoundary] Found fallback boundary at index ${i + 1} (model message with text)`);
        return i + 1;
      }
    }

    // 策略3：如果还是找不到，返回startIndex本身作为最后的回退
    // 这表示从startIndex开始的所有内容都要保留，前面的全部压缩
    if (startIndex > 0) {
      console.warn(`[findToolCallBoundary] Using fallback boundary at startIndex: ${startIndex}`);
      return startIndex;
    }

    // 无法找到任何合适的边界
    console.warn(`[findToolCallBoundary] No suitable boundary found at all`);
    return -1;
  }

  /**
   * 验证并清理历史，确保：
   * 1. tool calls和responses成对出现
   * 2. 没有空的parts数组的消息
   */
  private validateAndCleanHistory(history: Content[]): Content[] {
    const cleanedHistory: Content[] = [];
    const toolCallStack: { [toolUseId: string]: boolean } = {};
    const toolCallNames: { [toolName: string]: boolean } = {}; // Track by name as fallback

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      let hasInvalidToolResult = false;
      let hasEmptyParts = false;

      // 检查消息的parts数组是否为空
      if (!msg.parts || msg.parts.length === 0) {
        console.warn(`[CompressionService] Found message with empty parts array at index ${i}. Removing this message.`);
        hasEmptyParts = true;
      }

      // 检查每个消息中的parts
      if (msg.parts && msg.parts.length > 0) {
        for (const part of msg.parts) {
          const partAny = part as any;

          // 记录tool_use调用
          if (partAny.functionCall) {
            const toolCallId = partAny.functionCall?.id;
            const toolCallName = partAny.functionCall?.name;

            if (toolCallId) {
              toolCallStack[toolCallId] = true;
            }
            if (toolCallName) {
              toolCallNames[toolCallName] = true;
            }
          }

          // 检查tool_result响应 (Claude format)
          if (partAny.toolResult) {
            const toolResultId = partAny.toolResult?.toolUseId;
            if (!toolResultId || !toolCallStack[toolResultId]) {
              // 这是一个孤立的tool_result，需要移除整个消息
              console.warn(`[CompressionService] Found orphaned tool_result with ID: ${toolResultId}. Removing this message.`);
              hasInvalidToolResult = true;
              break;
            }
          }

          // 检查functionResponse (Gemini format)
          if (partAny.functionResponse) {
            const responseId = partAny.functionResponse?.id;
            const responseName = partAny.functionResponse?.name;

            // Check by ID if available, otherwise by name (Gemini sometimes relies on name matching)
            let isValid = false;
            if (responseId && toolCallStack[responseId]) {
              isValid = true;
            } else if (responseName && toolCallNames[responseName]) {
              // Fallback: if name matches a previous call, we consider it valid for now
              // Ideally we want strict ID matching, but Gemini history sometimes lacks IDs on calls
              isValid = true;
            }

            if (!isValid) {
              console.warn(`[CompressionService] Found orphaned functionResponse (name=${responseName}, id=${responseId}). Removing this message.`);
              hasInvalidToolResult = true;
              break;
            }
          }
        }
      }

      // 如果消息包含无效内容，跳过整个消息
      if (!hasInvalidToolResult && !hasEmptyParts) {
        cleanedHistory.push(msg);
      }
    }

    if (cleanedHistory.length < history.length) {
      console.log(`[CompressionService] Cleaned history: removed ${history.length - cleanedHistory.length} invalid messages`);
    }

    return cleanedHistory;
  }

  /**
   * 确保消息角色严格交替（user ↔ model），修复连续同角色消息问题。
   * - 连续两条相同角色：中间插入一条对方角色的占位消息
   * - 第一条必须是 user 角色，否则在最前面补一条 user 占位
   *
   * 这在压缩拼接后特别关键，因为 summaryAck(model) + historyToKeep[0](model)
   * 或 postCompactRestoration(user) + historyToKeep 末尾(user) 等情况会导致连续同角色。
   */
  private ensureAlternatingRoles(history: Content[]): Content[] {
    if (history.length === 0) return history;

    const result: Content[] = [];

    // 确保第一条消息是 user 角色
    if (history[0].role !== MESSAGE_ROLES.USER) {
      result.push({
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '[Conversation continues]' }],
      });
      console.warn(`[ensureAlternatingRoles] Inserted placeholder user message at start (first message was ${history[0].role})`);
    }

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      const prev = result[result.length - 1];

      if (prev && prev.role === msg.role) {
        // 连续同角色 → 插入对方角色的占位
        const fillerRole = msg.role === MESSAGE_ROLES.USER ? MESSAGE_ROLES.MODEL : MESSAGE_ROLES.USER;
        const fillerText = fillerRole === MESSAGE_ROLES.MODEL
          ? 'Understood.'
          : '[Conversation continues]';
        result.push({
          role: fillerRole,
          parts: [{ text: fillerText }],
        });
        console.warn(`[ensureAlternatingRoles] Inserted placeholder ${fillerRole} message before index ${i} to fix consecutive ${msg.role} messages`);
      }

      result.push(msg);
    }

    if (result.length !== history.length) {
      console.log(`[ensureAlternatingRoles] Fixed role alternation: ${history.length} -> ${result.length} messages`);
    }

    return result;
  }

  /**
   * 修剪 historyToKeep 末尾连续的工具调用消息对，替换为一条文本摘要。
   *
   * 压缩后模型如果看到尾部是 tool call / response，会倾向于"继续"那个操作流程，
   * 但此时上下文已不完整（工具调用链的早期部分可能被压缩掉了），容易导致死循环。
   *
   * 策略：从末尾向前找到最后一条纯文本的 user 消息为止，将之后的所有工具调用对
   * 摘要为一条简短的文本消息（model），确保尾部是 user(text) → model(text) 格式。
   */
  private trimTrailingToolCalls(history: Content[]): Content[] {
    if (history.length === 0) return history;

    // 判断一条消息是否包含工具调用或工具响应（即非纯文本）
    const hasToolParts = (msg: Content): boolean => {
      if (!msg.parts || msg.parts.length === 0) return false;
      return msg.parts.some((p: any) => p.functionCall || p.functionResponse || p.toolResult);
    };

    // 从末尾向前，找到最后一条"纯文本 user 消息"的位置
    // 这是安全的对话边界——此消息以及之前的内容保留，之后的工具调用对摘要化
    let cutIndex = history.length; // 默认不裁剪
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === MESSAGE_ROLES.USER && !hasToolParts(msg)) {
        // 找到了一条纯文本 user 消息
        // 检查它下面是否紧跟一条纯文本 model 消息（理想的对话结尾）
        if (i + 1 < history.length) {
          const next = history[i + 1];
          if (next.role === MESSAGE_ROLES.MODEL && !hasToolParts(next)) {
            // user(text) + model(text) 对，保留到 model 消息，裁剪之后的
            cutIndex = i + 2;
            break;
          }
        }
        // user(text) 后面直接是工具调用，保留到这条 user 消息，裁剪之后的
        cutIndex = i + 1;
        break;
      }
    }

    // 如果没找到纯文本 user 消息（全是工具调用），从头裁剪
    if (cutIndex >= history.length) {
      // 检查末尾是否确实有工具调用需要处理
      const lastMsg = history[history.length - 1];
      if (hasToolParts(lastMsg)) {
        // 整段都是工具调用，全部摘要化
        cutIndex = 0;
      } else {
        // 末尾已是纯文本，无需裁剪
        return history;
      }
    }

    const trimmedMessages = history.slice(cutIndex);
    const keptHistory = history.slice(0, cutIndex);

    // 从被裁剪的工具消息中生成摘要
    const toolSummaryParts: string[] = [];
    for (const msg of trimmedMessages) {
      if (!msg.parts) continue;
      for (const part of msg.parts) {
        const p = part as any;
        if (p.functionCall) {
          const args = p.functionCall.args;
          // 提取关键参数摘要（例如 file_path, pattern 等）
          let argSummary = '';
          if (args) {
            if (args.file_path || args.absolute_path) argSummary = ` on "${args.file_path || args.absolute_path}"`;
            else if (args.path) argSummary = ` on "${args.path}"`;
            else if (args.pattern) argSummary = ` for "${args.pattern}"`;
            else if (args.command) argSummary = `: \`${args.command.substring(0, 80)}\``;
          }
          toolSummaryParts.push(`- Called \`${p.functionCall.name}\`${argSummary}`);
        }
        if (p.functionResponse) {
          const output = p.functionResponse.response?.output;
          if (typeof output === 'string') {
            // 取首行作为结果摘要
            const firstLine = output.split('\n')[0].substring(0, 120);
            toolSummaryParts.push(`  → ${firstLine}`);
          }
        }
      }
    }

    if (toolSummaryParts.length === 0) {
      // 没有实际的工具调用（可能只是空消息），直接返回裁剪后的
      return keptHistory;
    }

    const toolSummaryText = `[Recent tool activity summary — prior tool calls compressed, verify file state with read_file before editing]\n${toolSummaryParts.join('\n')}`;

    // 根据 keptHistory 末尾的角色决定如何追加摘要消息
    const lastKept = keptHistory[keptHistory.length - 1];
    if (!lastKept) {
      // keptHistory 为空（全部都是工具调用被裁剪了）
      // 以 user(摘要) 形式追加，确保末尾是 user 角色
      // 这样 compressHistory 拼接时: summaryAck(model) + user(toolSummary) 角色交替正确
      keptHistory.push({
        role: MESSAGE_ROLES.USER,
        parts: [{ text: toolSummaryText }],
      });
    } else if (lastKept.role === MESSAGE_ROLES.USER) {
      // 末尾是 user，追加一条 model 消息
      keptHistory.push({
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: toolSummaryText }],
      });
    } else if (lastKept.role === MESSAGE_ROLES.MODEL) {
      // 末尾是 model，追加 user + model 对
      keptHistory.push({
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '[Conversation continues]' }],
      });
      keptHistory.push({
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: toolSummaryText }],
      });
    }

    console.log(`[trimTrailingToolCalls] Trimmed ${trimmedMessages.length} trailing tool messages (${toolSummaryParts.length} tool operations) and replaced with text summary`);

    return keptHistory;
  }

  /**
   * 检查是否需要压缩对话历史
   * @param history 对话历史
   * @param model 使用的模型
   * @param contentGenerator 内容生成器，用于计算token数量
   * @param force 是否强制压缩
   * @returns 是否需要压缩
   */
  async shouldCompress(
    history: Content[],
    model: string,
    contentGenerator: ContentGenerator,
    force: boolean = false,
    config?: Config
  ): Promise<{ shouldCompress: boolean; tokenCount?: number }> {
    // 如果历史为空，不需要压缩
    if (history.length === 0) {
      return { shouldCompress: false };
    }

    // 如果强制压缩，直接返回true
    if (force) {
      return { shouldCompress: true };
    }

    // 计算当前token数量
    let tokenCount: number | undefined;
    try {
      const result = await contentGenerator.countTokens({
        model,
        contents: history,
      });
      tokenCount = result.totalTokens;
    } catch (error) {
      console.warn(`Could not determine token count for model ${model}. Error: ${getErrorMessage(error)}`);
      return { shouldCompress: false };
    }

    if (tokenCount === undefined) {
      console.warn(`Could not determine token count for model ${model}.`);
      return { shouldCompress: false };
    }

    // 检查是否超过压缩阈值
    const threshold = this.compressionTokenThreshold * tokenLimit(model, config);
    const shouldCompress = tokenCount >= threshold;

    return { shouldCompress, tokenCount };
  }

  /**
   * 压缩对话历史
   * @param history 要压缩的对话历史
   * @param model 用于测算长度的模型（history实际使用的模型）
   * @param compressionModel 用于执行压缩的模型（由scene决定）
   * @param contentGenerator 内容生成器
   * @param prompt_id 提示ID
   * @param originalTokenCount 原始token数量（可选，如果提供则跳过重复计算）
   * @param overridePreserveRatio 可选的覆盖保留比例（0-1），用于激进压缩
   * @param isModelSwitchCompression 是否是模型切换时的压缩（默认false）
   * @param force 是否为用户主动触发的强制压缩（默认false）。强制压缩时放宽
   *              "历史过少"与"找不到边界"两个守卫，只要有内容就尽力压缩，
   *              并允许压缩全部历史（用于修复残缺的 tool_call 上下文）
   * @returns 压缩结果
   */
  async compressHistory(
    config: Config,
    history: Content[],
    model: string,
    compressionModel: string,
    geminiClient: GeminiClient, // 使用 GeminiClient 而不是 ContentGenerator
    prompt_id: string,
    abortSignal: AbortSignal,
    originalTokenCount?: number,
    overridePreserveRatio?: number,
    isModelSwitchCompression: boolean = false,
    force: boolean = false
  ): Promise<CompressionResult> {
    try {
      // 获取或计算原始token数量
      let finalOriginalTokenCount = originalTokenCount;

      if (finalOriginalTokenCount === undefined) {
        const originalTokenResult = await this.shouldCompress(history, model, geminiClient.getContentGenerator(), false, config);
        finalOriginalTokenCount = originalTokenResult.tokenCount;

        if (finalOriginalTokenCount === undefined) {
          return {
            success: false,
            error: 'Could not determine original token count'
          };
        }
      }

      // 分离环境信息和实际对话历史
      const environmentMessages = history.slice(0, Math.min(this.skipEnvironmentMessages, history.length));
      const conversationHistory = history.slice(this.skipEnvironmentMessages);

      // 如果对话历史太少，不进行压缩
      // 强制压缩（用户主动 /compress）时放宽此限制：只要有内容就允许压缩，
      // 这样用户可以随时通过压缩来修复残缺的 tool_call 上下文。
      if (!force && conversationHistory.length <= 2) {
        return {
          success: false,
          error: 'Insufficient conversation history to compress'
        };
      }
      if (force && conversationHistory.length === 0) {
        return {
          success: false,
          error: 'No conversation history to compress'
        };
      }

      // 确定保留比例：优先使用 override，否则使用配置默认值
      const preserveRatio = overridePreserveRatio ?? this.compressionPreserveThreshold;

      // 在对话历史中确定压缩分割点
      let compressBeforeIndex = findIndexAfterFraction(
        conversationHistory,
        1 - preserveRatio,
      );

      console.log(`[compressHistory] Compression plan: conversationHistory.length=${conversationHistory.length}, preserveRatio=${preserveRatio}, initialCompressBeforeIndex=${compressBeforeIndex}`);

      // 寻找最近的完整工具调用对边界，统一处理主agent和subAgent场景
      compressBeforeIndex = this.findToolCallBoundary(conversationHistory, compressBeforeIndex);

      // 如果没有找到合适的压缩边界
      if (compressBeforeIndex === -1) {
        console.warn(`[compressHistory] Could not find suitable compression boundary. Conversation history structure may prevent compression.`);
        console.log(`[compressHistory] Last 5 messages in conversationHistory:`);
        for (let i = Math.max(0, conversationHistory.length - 5); i < conversationHistory.length; i++) {
          const msg = conversationHistory[i];
          const partTypes = msg.parts?.map((p: any) => {
            if (p.text) return 'text';
            if (p.functionCall) return 'functionCall';
            if (p.toolResult) return 'toolResult';
            return 'unknown';
          }).join(',') || 'empty';
          console.log(`  [${i}] role=${msg.role}, parts=[${partTypes}]`);
        }

        if (force) {
          // 用户主动压缩：即使找不到"干净"的边界也尽力而为，
          // 退化为压缩全部对话历史（保留 0 条）。validateAndCleanHistory
          // 会在拼接后清理孤立的 tool_use/tool_result，从而修复残缺上下文。
          console.warn(`[compressHistory] Force compression: no clean boundary found, compressing entire conversation history.`);
          compressBeforeIndex = conversationHistory.length;
        } else {
          return {
            success: false,
            error: 'Could not find suitable compression boundary'
          };
        }
      }

      const historyToCompress = conversationHistory.slice(0, compressBeforeIndex);
      let historyToKeep = conversationHistory.slice(compressBeforeIndex);

      // 清理historyToKeep：移除开头的孤立tool_result（因为对应的tool_use在被压缩的部分）
      // 这防止了"unexpected `tool_use_id` found in `tool_result` blocks"错误
      while (historyToKeep.length > 0) {
        const firstMessage = historyToKeep[0];
        let shouldRemove = false;

        // Case 1: Model message with only toolResult (unlikely in Gemini, but possible in some mappings)
        if (firstMessage.role === MESSAGE_ROLES.MODEL) {
          const hasOnlyToolResult = firstMessage.parts?.every((part: any) => 'toolResult' in part && !('text' in part));
          if (hasOnlyToolResult && firstMessage.parts && firstMessage.parts.length > 0) {
            shouldRemove = true;
          }
        }

        // Case 2: User message with functionResponse (Common in Gemini)
        if (firstMessage.role === MESSAGE_ROLES.USER) {
          const hasFunctionResponse = firstMessage.parts?.some((part: any) => part.functionResponse);
          if (hasFunctionResponse) {
            shouldRemove = true;
          }
        }

        if (shouldRemove) {
          console.warn(`[CompressionService] Removing orphaned tool result/response at start of historyToKeep (role=${firstMessage.role})`);
          historyToKeep = historyToKeep.slice(1);
        } else {
          break;
        }
      }

      // 检查historyToCompress最后一个消息，如果是user需要添加model回复避免连续user消息
      let historyForCompression = [...environmentMessages, ...historyToCompress];
      const lastMessage = historyToCompress[historyToCompress.length - 1];

      if (lastMessage && lastMessage.role === 'user') {
        // 添加一个简单的model确认，确保对话格式正确
        historyForCompression.push({
          role: MESSAGE_ROLES.MODEL,
          parts: [{ text: 'Understood.' }],
        });
      }

      // 使用临时GeminiChat进行压缩，获得完整的API监控和错误处理
      const compressionPrompt = 'First, reason in your <analysis> scratchpad. Then, generate the <summary> containing the <state_snapshot>.';

      console.log(`[CompressionService] Using temporary chat for compression with full API monitoring`);

      // 创建临时Chat获得完整的API日志、Token统计、错误处理等功能
      const temporaryChat = await geminiClient.createTemporaryChat(
        SceneType.COMPRESSION,
        compressionModel, // 使用压缩模型（由scene决定）
        { type: 'sub', agentId: 'CompressionService' }
      );

      // 注意：不设置工具，因为压缩的目的是生成文本摘要，不需要调用工具
      // 如果设置工具，模型可能会尝试调用工具而不是生成文本

      // 如果是模型切换压缩，对传给压缩模型的历史进行token限制
      let historyForCompressionRequest = historyForCompression;
      if (isModelSwitchCompression) {
        // 限制压缩请求中的历史为最近的N条消息，避免上下文过长
        // 保留环境消息和最近的对话历史
        const maxHistoryLength = 50; // 最多保留50条消息
        if (historyForCompression.length > maxHistoryLength) {
          const skip = historyForCompression.length - maxHistoryLength;
          historyForCompressionRequest = [
            ...environmentMessages, // 总是保留环境消息
            ...historyForCompression.slice(skip)
          ];
          console.log(`[CompressionService] Model switch compression: limiting history from ${historyForCompression.length} to ${historyForCompressionRequest.length} messages`);
        }
      }

      // 净化历史：移除所有函数调用和函数响应，只保留文本对话
      // 原因：压缩模型不会调用工具，所以不应该在历史中包含函数调用对
      const purifiedHistory: Content[] = [];
      for (const msg of historyForCompressionRequest) {
        if (msg.role === MESSAGE_ROLES.USER || msg.role === MESSAGE_ROLES.MODEL) {
          // 只保留文本内容，移除所有函数调用和函数响应
          const textParts = msg.parts?.filter((part: any) => 'text' in part) || [];
          if (textParts.length > 0) {
            purifiedHistory.push({
              ...msg,
              parts: textParts
            });
          }
        }
      }

      // 构建包含历史的完整对话
      const compressionContents = [
        ...purifiedHistory,
        { role: MESSAGE_ROLES.USER, parts: [{ text: compressionPrompt }] }
      ];

      // PTL 渐进降级：如果压缩请求自身触发 prompt-too-long 错误，
      // 逐步截断最旧的消息组并重试
      const MAX_PTL_RETRIES = 3;
      const PTL_TRUNCATE_RATIO = 0.2; // 每次截断 20% 的消息
      let ptlRetryCount = 0;
      let currentPurifiedHistory = [...purifiedHistory];
      let compressionResponse: any = null;

      while (ptlRetryCount <= MAX_PTL_RETRIES) {
        const contentsForRequest = [
          ...currentPurifiedHistory,
          { role: MESSAGE_ROLES.USER, parts: [{ text: compressionPrompt }] }
        ];

        // 设置历史并发送压缩请求
        temporaryChat.setHistory(contentsForRequest.slice(0, -1));

        try {
          compressionResponse = await temporaryChat.sendMessage(
            {
              message: compressionPrompt,
              config: {
                maxOutputTokens: 16384, // 压缩摘要需要足够空间来捕获长对话的完整上下文
                temperature: 0.1, // 低温度确保一致性
                thinkingConfig: { thinkingBudget: 0 }, // 压缩场景禁用thinking，确保所有token用于文本输出
                abortSignal,
                systemInstruction: getCompressionPrompt()
              }
            },
            `compress-${prompt_id}-${Date.now()}`,
            SceneType.COMPRESSION
          );
          break; // 成功，退出重试循环
        } catch (ptlError: any) {
          const errorMsg = ptlError?.message?.toLowerCase() || '';
          const isPTL = errorMsg.includes('prompt') && errorMsg.includes('too long')
            || errorMsg.includes('token limit')
            || errorMsg.includes('context length')
            || errorMsg.includes('413')
            || errorMsg.includes('exceeds the maximum');

          if (!isPTL || ptlRetryCount >= MAX_PTL_RETRIES) {
            throw ptlError; // 非 PTL 错误或已达到最大重试次数
          }

          ptlRetryCount++;
          // 截断最旧的消息（保留环境消息后的部分）
          const envCount = Math.min(this.skipEnvironmentMessages, currentPurifiedHistory.length);
          const nonEnvMessages = currentPurifiedHistory.slice(envCount);
          const truncateCount = Math.max(1, Math.ceil(nonEnvMessages.length * PTL_TRUNCATE_RATIO));
          const remainingMessages = nonEnvMessages.slice(truncateCount);

          // 如果截断后没有消息可摘要，放弃
          if (remainingMessages.length === 0) {
            throw new Error('PTL: No messages left after truncation, cannot compress');
          }

          // 确保第一条消息是 user（API 要求）
          let newHistory = [...currentPurifiedHistory.slice(0, envCount), ...remainingMessages];
          if (newHistory.length > 0 && newHistory[0].role !== MESSAGE_ROLES.USER) {
            newHistory = [
              { role: MESSAGE_ROLES.USER, parts: [{ text: '[Earlier conversation context was truncated due to length]' }] },
              ...newHistory
            ];
          }

          currentPurifiedHistory = newHistory;
          console.warn(`[CompressionService] PTL retry ${ptlRetryCount}/${MAX_PTL_RETRIES}: truncated ${truncateCount} oldest messages, ${currentPurifiedHistory.length} remaining`);
        }
      }

      if (!compressionResponse) {
        throw new Error('Compression failed: no response received after PTL retries');
      }

      console.log(`[CompressionService] Compression response received${ptlRetryCount > 0 ? ` (after ${ptlRetryCount} PTL retries)` : ''}:`, {
        hasCandidates: !!compressionResponse.candidates,
        candidatesLength: compressionResponse.candidates?.length,
        firstCandidateFinishReason: compressionResponse.candidates?.[0]?.finishReason,
        hasContent: !!compressionResponse.candidates?.[0]?.content,
        partsCount: compressionResponse.candidates?.[0]?.content?.parts?.length || 0,
        partTypes: compressionResponse.candidates?.[0]?.content?.parts?.map((p: any) => {
          if (p.thought) return 'thought';
          if ('text' in p) return 'text';
          if ('functionCall' in p) return 'functionCall';
          if ('functionResponse' in p) return 'functionResponse';
          return Object.keys(p)[0] || 'unknown';
        })
      });

      // 尝试从所有部分中查找文本（跳过 thought part 和空 text）
      let summary = '';
      const parts = compressionResponse.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part && 'text' in part && typeof part.text === 'string' && part.text.length > 0 && !part.thought) {
          summary = (part as any).text;
          break;
        }
      }

      if (!summary) {
        const detailedError = `Failed to generate compression summary - empty response. Response: ${JSON.stringify({
          candidates: compressionResponse.candidates?.length || 0,
          firstCandidateFinishReason: compressionResponse.candidates?.[0]?.finishReason,
          firstCandidateContent: compressionResponse.candidates?.[0]?.content?.parts?.length || 0,
          partTypes: compressionResponse.candidates?.[0]?.content?.parts?.map((p: any) => {
            if (p.thought) return 'thought';
            if ('text' in p) return 'text';
            if ('functionCall' in p) return 'functionCall';
            if ('functionResponse' in p) return 'functionResponse';
            return Object.keys(p)[0] || 'unknown';
          })
        })}`;
        throw new Error(detailedError);
      }

      // 两阶段输出处理：剥离 <analysis> 草稿，只保留 <summary> 内容
      const rawSummaryLength = summary.length;
      summary = formatCompactSummary(summary);
      if (summary.length < rawSummaryLength) {
        console.log(`[CompressionService] Stripped analysis scratchpad: ${rawSummaryLength} -> ${summary.length} chars`);
      }

      // 构建新的对话历史：环境信息 + 压缩摘要 + 保留的最近历史
      // 摘要以 user 角色注入，加上强化前缀，让模型将其视为权威上下文信息
      // 随后紧跟 model 确认消息，表示模型已"接受"这些信息
      const summaryPreamble = `[Context Restoration] The following is a comprehensive summary of our previous conversation. This is authoritative context — treat it as ground truth and continue seamlessly from where we left off. Do NOT re-introduce yourself or treat this as a new conversation.

IMPORTANT POST-COMPRESSION RULES:
1. Files may have been modified by prior tool calls that are no longer in the conversation history. Always use read_file to verify the current state of a file BEFORE attempting any replace/edit operation.
2. If a replace tool call fails with "0 occurrences found", do NOT retry with the same old_string. Instead, read_file to see what the file actually contains now, then construct a new edit based on the actual content.
3. Never retry a failed edit more than once without reading the file first.

`;
      const summaryAsUserMessage: Content = {
        role: MESSAGE_ROLES.USER,
        parts: [{ text: summaryPreamble + summary }],
      };
      const summaryAckMessage: Content = {
        role: MESSAGE_ROLES.MODEL,
        parts: [{ text: 'I have reviewed the conversation summary and all context has been restored. I will continue seamlessly from where we left off. I understand that files may have been modified by prior tool calls no longer visible in history, so I will always read_file to verify current file state before attempting any edits.' }],
      };

      // 🔧 修剪 historyToKeep 末尾的工具调用对，替换为文本摘要
      // 压缩后模型看到尾部的 tool call/response 容易陷入"继续未完成的工具操作"死循环，
      // 因为上下文不再完整。将末尾连续的工具调用对摘要化，确保末尾是纯文本人机对话。
      historyToKeep = this.trimTrailingToolCalls(historyToKeep);

      let newHistory: Content[] = [
        ...environmentMessages, // 保留环境信息
        summaryAsUserMessage,
        summaryAckMessage,
        ...historyToKeep,
      ];

      // 🔧 CRITICAL: Validate and clean the new history to ensure tool calls/responses are paired
      // This prevents the "unexpected tool_use_id found in tool_result" error
      newHistory = this.validateAndCleanHistory(newHistory);

      // 🔧 确保消息角色严格交替，修复压缩拼接后可能出现的连续同角色消息
      newHistory = this.ensureAlternatingRoles(newHistory);

      // 详细诊断日志
      console.log(`[CompressionService] New history structure after compression:
        - Total messages: ${newHistory.length}
        - Environment: ${environmentMessages.length}
        - Summary: 1 (user message + model ack)
        - Retained conversation: ${historyToKeep.length}`);

      // 打印前几条消息的结构用于诊断
      console.log('[CompressionService] First 5 messages structure:');
      for (let i = 0; i < Math.min(5, newHistory.length); i++) {
        const msg = newHistory[i];
        const partTypes = msg.parts?.map((p: any) => {
          if (p.text) return 'text';
          if (p.functionCall) return `functionCall(${p.functionCall?.id})`;
          if (p.toolResult) return `toolResult(${p.toolResult?.toolUseId})`;
          return 'unknown';
        }).join(',') || 'no-parts';
        console.log(`  [${i}] role=${msg.role}, parts=[${partTypes}]`);
      }

      // 计算压缩后的token数量
      let newTokenCount: number | undefined;
      try {
        const result = await geminiClient.getContentGenerator().countTokens({
          model,
          contents: newHistory,
        });
        newTokenCount = result.totalTokens;
      } catch (error) {
        console.warn(`Could not determine compressed history token count. Error: ${getErrorMessage(error)}`);
        return {
          success: false,
          error: 'Could not determine compressed history token count'
        };
      }

      if (newTokenCount === undefined) {
        console.warn('Could not determine compressed history token count.');
        return {
          success: false,
          error: 'Could not determine compressed history token count'
        };
      }

      console.log(`[CompressionService] Compression completed: ${finalOriginalTokenCount} -> ${newTokenCount} tokens`);

      return {
        success: true,
        compressionInfo: {
          originalTokenCount: finalOriginalTokenCount,
          newTokenCount,
        },
        summary,
        newHistory,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[CompressionService] Compression failed:', errorMessage);

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * 一步式压缩方法：检查并执行压缩
   * @param history 对话历史
   * @param model 用于测算长度的模型（history实际使用的模型）
   * @param compressionModel 用于执行压缩的模型（由scene决定）
   * @param contentGenerator 内容生成器
   * @param prompt_id 提示ID
   * @param force 是否强制压缩
   * @returns 压缩结果，如果不需要压缩则返回null
   */
  async tryCompress(
    config: Config,
    history: Content[],
    model: string,
    compressionModel: string,
    geminiClient: any, // 使用 GeminiClient 而不是 ContentGenerator
    prompt_id: string,
    abortSignal: AbortSignal,
    force: boolean = false
  ): Promise<CompressionResult | null> {
    // 熔断器检查：非强制压缩时，如果连续失败过多则跳过
    if (!force && this.isCircuitBreakerTripped()) {
      console.warn(`[CompressionService] Circuit breaker tripped: ${this.consecutiveAutoCompressFailures} consecutive failures. Skipping auto-compress. Use /compress to force.`);
      return null;
    }

    // 检查是否需要压缩
    const shouldCompressResult = await this.shouldCompress(history, model, geminiClient.getContentGenerator(), force, config);

    if (!shouldCompressResult.shouldCompress) {
      return null;
    }

    try {
      // 使用 retryWithBackoff 包装压缩执行逻辑
      const result = await retryWithBackoff(async () => {
        // 执行压缩，传递已计算的token数量避免重复计算
        const innerResult = await this.compressHistory(
          config,
          history,
          model,
          compressionModel,
          geminiClient,
          prompt_id,
          abortSignal,
          shouldCompressResult.tokenCount,
          undefined,
          false,
          force
        );

        // 如果压缩失败且没有明确的跳过原因，抛出错误以触发重试
        if (!innerResult.success && !innerResult.skipReason) {
          throw new Error(innerResult.error || 'Compression failed without specific error');
        }

        return innerResult;
      }, {
        maxAttempts: 3, // 最多重试3次
        shouldRetry: (error) => {
          console.warn(`[CompressionService] Compression attempt failed: ${error.message}. Retrying...`);
          return true;
        }
      });

      // 压缩成功，重置熔断器
      if (result && result.success) {
        this.consecutiveAutoCompressFailures = 0;
      }

      return result;
    } catch (error) {
      // 所有重试都失败了，更新熔断器计数
      if (!force) {
        this.consecutiveAutoCompressFailures++;
        console.warn(`[CompressionService] Auto-compress failed. Consecutive failures: ${this.consecutiveAutoCompressFailures}/${this.maxConsecutiveFailures}`);
      }
      throw error;
    }
  }

  /**
   * 尝试压缩历史以适应目标模型的Token限制
   *
   * @param config 配置对象
   * @param history 当前对话历史
   * @param currentModel 当前模型（用于计算Token）
   * @param targetModel 目标模型（用于获取限制）
   * @param compressionModel 压缩执行模型
   * @param geminiClient 客户端实例
   * @param prompt_id 提示ID
   * @param abortSignal 中止信号
   * @param knownTokenCount 可选的已知token数量（由调用方提供，避免重新计算）
   * @returns 压缩结果，如果不需要压缩则返回null
   */
  async compressToFit(
    config: Config,
    history: Content[],
    currentModel: string,
    targetModel: string,
    compressionModel: string,
    geminiClient: GeminiClient,
    prompt_id: string,
    abortSignal: AbortSignal,
    knownTokenCount?: number
  ): Promise<CompressionResult> {
    // 使用 retryWithBackoff 包装 compressToFit 逻辑
    return await retryWithBackoff(async () => {
      console.log(`[CompressionService] compressToFit called: ${currentModel} → ${targetModel}${knownTokenCount ? ` (knownTokenCount: ${knownTokenCount})` : ''}`);

      // 1. 获取目标模型的Token限制
      const targetLimit = tokenLimit(targetModel, config);
      // 留 10% 的安全缓冲
      const safeLimit = targetLimit * 0.9;

      // 2. 使用已知的token数量，或重新计算
      let currentTokenCount: number | undefined = knownTokenCount;

      if (currentTokenCount === undefined) {
        try {
          const result = await geminiClient.getContentGenerator().countTokens({
            model: currentModel,
            contents: history,
          });
          currentTokenCount = result.totalTokens;
        } catch (error) {
          console.warn(`[CompressionService] Could not count tokens for model switch check: ${getErrorMessage(error)}`);
          // 如果无法计算，保守起见假设不需要压缩，返回成功但带有跳过原因
          return {
            success: true,
            skipReason: `Unable to count tokens for model switch: ${getErrorMessage(error)}. Proceeding without compression.`
          };
        }
      }

      if (currentTokenCount === undefined) {
        return {
          success: true,
          skipReason: 'Unable to determine token count for model switch. Proceeding without compression.'
        };
      }

      console.log(`[CompressionService] Model Switch Check: Current Tokens=${currentTokenCount}, Target Limit=${targetLimit} (Safe=${safeLimit})`);

      // 3. 检查是否需要压缩
      if (currentTokenCount <= safeLimit) {
        // 不需要压缩，返回成功但带有跳过原因
        return {
          success: true,
          skipReason: `Context sufficient for target model: ${currentTokenCount} tokens ≤ ${safeLimit} safe limit (model limit: ${targetLimit})`
        };
      }

      console.log(`[CompressionService] History too large for target model ${targetModel}. Triggering aggressive compression.`);

      // 4. 计算需要的压缩比例
      // 我们需要将历史压缩到 safeLimit 以下
      // 假设环境信息占用很少，主要压缩对话部分
      // 这是一个简化的策略：直接使用更激进的保留阈值
      // 如果当前超出很多，可能需要保留很少的历史

      // 动态调整保留阈值：
      // 目标是让 (环境 + 摘要 + 保留历史) < safeLimit
      // 假设 (环境 + 摘要) 占用约 1000 tokens
      const estimatedOverhead = 1000;
      const availableForHistory = Math.max(0, safeLimit - estimatedOverhead);

      // 计算需要的保留比例
      // ratio = available / current
      let requiredRatio = availableForHistory / currentTokenCount;

      // 限制比例在合理范围内 (0.05 - 0.5)
      // 至少保留 5%，最多保留 50% (如果不需要压缩那么多，但为了安全起见)
      // 如果 requiredRatio > 0.3 (默认值)，则使用默认值，因为 compressToFit 只有在超标时才调用
      // 但这里我们已经确认超标了，所以 requiredRatio 肯定 < 1

      // 如果 requiredRatio 非常小（例如 < 0.05），说明目标模型太小了，可能无法保留有意义的历史
      // 但我们还是尽力而为
      requiredRatio = Math.max(0.05, Math.min(requiredRatio, this.compressionPreserveThreshold));

      console.log(`[CompressionService] Dynamic compression ratio calculated: ${requiredRatio.toFixed(4)} (Available: ${availableForHistory}, Current: ${currentTokenCount})`);

      const result = await this.compressHistory(
        config,
        history,
        currentModel,
        compressionModel,
        geminiClient,
        prompt_id,
        abortSignal,
        currentTokenCount,
        requiredRatio, // 传入计算出的动态比例
        true // 标记这是模型切换压缩
      );

      // 如果压缩失败且没有明确的跳过原因，抛出错误以触发重试
      if (!result.success && !result.skipReason) {
        throw new Error(result.error || 'Compression failed without specific error');
      }

      return result;
    }, {
      maxAttempts: 3, // 最多重试3次
      shouldRetry: (error: any) => {
        console.warn(`[CompressionService] compressToFit attempt failed: ${error.message || String(error)}. Retrying...`);
        return true;
      }
    });
  }

  /**
   * 获取压缩配置
   */
  getConfig(): CompressionServiceConfig {
    return {
      compressionTokenThreshold: this.compressionTokenThreshold,
      compressionPreserveThreshold: this.compressionPreserveThreshold,
      skipEnvironmentMessages: this.skipEnvironmentMessages,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
    };
  }
}