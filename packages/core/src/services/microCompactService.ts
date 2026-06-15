/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 微压缩服务 (MicroCompact)
 *
 * 在每次 API 请求前执行轻量级清理，替换旧的工具结果为占位符，
 * 减少上下文大小而无需调用 LLM 进行全量摘要。
 *
 * 灵感来自 ClaudeCode 的 microCompact 策略：
 * - 时间感知：距离上次对话超过阈值时，清除旧工具结果（服务器缓存已冷）
 * - 保留最近的 N 个工具结果
 * - 只清理特定的可压缩工具（read_file, run_shell_command 等）
 */

import { Content } from '../types/extendedContent.js';

/**
 * 可被微压缩清理的工具名称集合
 * 这些工具的输出通常较大且随时间失去时效性
 */
export const COMPACTABLE_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'search_file_content',
  'glob',
  'list_directory',
  'ls',
  'run_shell_command',
  'web_fetch',
  'google_web_search',
  'codesearch',
  'read_lints',
  'lsp',
  'lsp_hover',
  'lsp_goto_definition',
  'lsp_find_references',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_implementation',
  'task',
  'batch',
]);

/** 清除后的占位符标记 */
export const CLEARED_TOOL_RESULT_MARKER = '[Old tool result content cleared to save context space]';

/**
 * 微压缩配置
 */
export interface MicroCompactConfig {
  /**
   * 空闲时间阈值（分钟）：距离上次助手消息超过此时间后触发微压缩
   * 默认: 60 分钟
   */
  idleThresholdMinutes?: number;

  /**
   * 保留最近 N 个工具结果不被清除
   * 默认: 5
   */
  keepRecentToolResults?: number;

  /**
   * 是否启用微压缩
   * 默认: true
   */
  enabled?: boolean;

  /**
   * Token 用量触发阈值：当上下文使用率达到此比例时触发微压缩
   * 作为全量压缩的缓冲层，在全量压缩之前先尝试轻量清理
   * 默认: 0.7 (70%)，应低于全量压缩阈值 (默认 0.8)
   */
  tokenUsageThreshold?: number;
}

/**
 * 微压缩结果
 */
export interface MicroCompactResult {
  /** 是否执行了微压缩 */
  applied: boolean;
  /** 清除的工具结果数量 */
  clearedCount: number;
  /** 触发原因 */
  reason?: string;
}

/**
 * 微压缩服务
 */
export class MicroCompactService {
  private readonly idleThresholdMinutes: number;
  private readonly keepRecentToolResults: number;
  private readonly tokenUsageThreshold: number;
  private enabled: boolean;

  /** 上次助手消息的时间戳 */
  private lastAssistantMessageTime: number = Date.now();

  constructor(config: MicroCompactConfig = {}) {
    this.idleThresholdMinutes = config.idleThresholdMinutes ?? 60;
    this.keepRecentToolResults = config.keepRecentToolResults ?? 5;
    this.tokenUsageThreshold = config.tokenUsageThreshold ?? 0.7;
    this.enabled = config.enabled ?? true;
  }

  /**
   * 更新助手消息时间戳（每次收到助手响应后调用）
   */
  updateLastAssistantMessageTime(): void {
    this.lastAssistantMessageTime = Date.now();
  }

  /**
   * 获取空闲时间（分钟）
   */
  getIdleMinutes(): number {
    return (Date.now() - this.lastAssistantMessageTime) / (1000 * 60);
  }

  /**
   * 检查是否应该执行微压缩
   * 触发条件（满足任一即触发）：
   * 1. 空闲 ≥ 60分钟（长时间不活动，缓存早已冷透，清理旧工具结果省钱）
   * 2. Token 用量 ≥ 70% 且空闲 > 6分钟（上下文快满了 + 缓存已冷，作为全量压缩的缓冲层）
   * @param tokenUsageRatio 当前 token 使用率（0-1），可选
   */
  shouldMicroCompact(tokenUsageRatio?: number): boolean {
    if (!this.enabled) return false;

    const idleMinutes = this.getIdleMinutes();

    // 条件1：长时间空闲触发（缓存早已冷透）
    if (idleMinutes >= this.idleThresholdMinutes) return true;

    // 条件2：token 快满 + 缓存已冷（>6分钟），作为全量压缩的缓冲层
    if (tokenUsageRatio !== undefined && tokenUsageRatio >= this.tokenUsageThreshold && idleMinutes > 6) return true;

    return false;
  }

  /**
   * 对消息历史执行微压缩
   *
   * 遍历消息历史，找到所有可压缩工具的 functionResponse，
   * 将旧的工具结果替换为占位符，保留最近的 N 个。
   *
   * **就地修改** 传入的 history 数组中的消息 parts。
   *
   * @param history 对话历史（会被就地修改）
   * @param skipEnvironmentMessages 跳过前N条环境消息
   * @returns 微压缩结果
   */
  microCompactMessages(
    history: Content[],
    skipEnvironmentMessages: number = 2
  ): MicroCompactResult {
    if (!this.enabled) {
      return { applied: false, clearedCount: 0, reason: 'disabled' };
    }

    const idleMinutes = this.getIdleMinutes();

    // 收集所有可压缩工具的 functionResponse 位置（倒序以确定"最近"的）
    const compactableResults: Array<{
      msgIndex: number;
      partIndex: number;
      toolName: string;
    }> = [];

    for (let i = skipEnvironmentMessages; i < history.length; i++) {
      const msg = history[i];
      if (!msg.parts) continue;

      for (let j = 0; j < msg.parts.length; j++) {
        const part = msg.parts[j] as any;
        if (part.functionResponse) {
          const toolName = part.functionResponse.name;
          if (toolName && COMPACTABLE_TOOLS.has(toolName)) {
            // 检查是否已经被清除过（避免重复操作）
            const responseContent = part.functionResponse.response;
            const isAlreadyCleared = this.isAlreadyCleared(responseContent);
            if (!isAlreadyCleared) {
              compactableResults.push({ msgIndex: i, partIndex: j, toolName });
            }
          }
        }
      }
    }

    // 保留最近的 N 个工具结果
    const toKeep = this.keepRecentToolResults;
    const toClear = compactableResults.slice(0, Math.max(0, compactableResults.length - toKeep));

    if (toClear.length === 0) {
      return { applied: false, clearedCount: 0, reason: 'nothing to clear' };
    }

    // 执行清除
    let clearedCount = 0;
    for (const { msgIndex, partIndex, toolName } of toClear) {
      const part = history[msgIndex].parts![partIndex] as any;
      // 替换响应内容为占位符
      part.functionResponse = {
        name: toolName,
        response: { output: CLEARED_TOOL_RESULT_MARKER },
        id: part.functionResponse.id, // 保留关联 ID
      };
      clearedCount++;
    }

    console.log(`[MicroCompact] Cleared ${clearedCount} old tool results (idle ${idleMinutes.toFixed(0)} min, kept ${Math.min(toKeep, compactableResults.length)} recent)`);

    return {
      applied: true,
      clearedCount,
      reason: `idle ${idleMinutes.toFixed(0)} min >= ${this.idleThresholdMinutes} min threshold`,
    };
  }

  /**
   * 检查 functionResponse 内容是否已被清除过
   */
  private isAlreadyCleared(response: any): boolean {
    if (!response) return false;
    if (typeof response === 'string') {
      return response === CLEARED_TOOL_RESULT_MARKER;
    }
    if (typeof response === 'object') {
      const output = response.output || response.content || response.result;
      if (typeof output === 'string') {
        return output === CLEARED_TOOL_RESULT_MARKER;
      }
    }
    return false;
  }

  /**
   * 重置微压缩状态
   */
  reset(): void {
    this.lastAssistantMessageTime = Date.now();
  }

  /**
   * 启用/禁用微压缩
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * 获取当前配置
   */
  getConfig(): MicroCompactConfig {
    return {
      idleThresholdMinutes: this.idleThresholdMinutes,
      keepRecentToolResults: this.keepRecentToolResults,
      enabled: this.enabled,
      tokenUsageThreshold: this.tokenUsageThreshold,
    };
  }
}
