/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 语义保留权重排序器 (SemanticRetention)
 *
 * 对对话历史中的每条消息按重要性打分 (0-1)，并在 token 预算下加权保留。
 * 确保系统规则、用户约定、活跃目标、未解决错误等关键信息不被压缩丢失。
 */

import { Content } from '../types/extendedContent.js';
import { estimateContentTokens } from '../utils/tokenEstimator.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';

/**
 * 保留上下文
 */
export interface RetentionContext {
  /** 当前任务目标 */
  goal?: string;
  /** 系统规则片段 */
  systemRules: string[];
  /** 未完成事项 */
  activeTodos: string[];
  /** 最近错误 */
  recentErrors: string[];
}

/**
 * 语义保留权重排序器
 *
 * 评分规则（优先级从高到低）：
 *   - 系统规则与用户约定: 1.0 (must keep)
 *   - 当前任务目标 (goal): 1.0 (must keep)
 *   - 未完成事项和错误: 0.9
 *   - 最近对话 (最后3轮): 0.8
 *   - 语义相关的历史: 0.5-0.7
 *   - 旧工具输出: 0.1-0.3
 */
export class SemanticRetention {
  private context: RetentionContext;

  /** 被标记为"必须保留"的索引集合 */
  private mustKeepIndices: Set<number> = new Set();

  constructor(context: RetentionContext) {
    this.context = context;
  }

  /**
   * 对每条消息按重要性打分(0-1)
   *
   * @param msg 消息内容
   * @param index 消息在历史中的索引
   * @param totalCount 历史总条数
   * @returns 重要性分数 (0-1)
   */
  scoreMessage(msg: Content, index: number, totalCount: number): number {
    const text = this.extractText(msg);
    const textLower = text.toLowerCase();

    // ──────────────────────────────────────────────
    // 1. 系统规则与用户约定: 1.0 (must keep)
    // ──────────────────────────────────────────────
    if (this.matchesSystemRules(textLower)) {
      this.mustKeepIndices.add(index);
      return 1.0;
    }

    // ──────────────────────────────────────────────
    // 2. 当前任务目标 (goal): 1.0 (must keep)
    // ──────────────────────────────────────────────
    if (this.context.goal && this.matchesGoal(textLower, this.context.goal)) {
      this.mustKeepIndices.add(index);
      return 1.0;
    }

    // ──────────────────────────────────────────────
    // 3. 未完成事项和错误: 0.9
    // ──────────────────────────────────────────────
    if (this.matchesActiveTodos(textLower) || this.matchesRecentErrors(textLower)) {
      return 0.9;
    }

    // ──────────────────────────────────────────────
    // 4. 最近对话 (最后3轮): 0.8
    // ──────────────────────────────────────────────
    // 一轮 = 一条 user + 一条 model 消息对，最后3轮 ≈ 最后6条
    if (index >= totalCount - 6) {
      return 0.8;
    }

    // ──────────────────────────────────────────────
    // 5. 语义相关的历史: 0.5-0.7
    // ──────────────────────────────────────────────
    const semanticScore = this.computeSemanticRelevance(text);
    if (semanticScore > 0.3) {
      return 0.5 + semanticScore * 0.2; // 映射到 0.5-0.7
    }

    // ──────────────────────────────────────────────
    // 6. 工具输出: 0.1-0.3
    // ──────────────────────────────────────────────
    if (this.isToolOutput(msg)) {
      // 最近的工具输出保留价值更高
      const recencyFactor = index / Math.max(totalCount, 1);
      return 0.1 + recencyFactor * 0.2; // 0.1-0.3
    }

    // ──────────────────────────────────────────────
    // 7. 默认：根据消息在历史中的位置给分
    // ──────────────────────────────────────────────
    // 越新的消息分数越高
    const recencyScore = 0.3 + (index / Math.max(totalCount, 1)) * 0.3; // 0.3-0.6
    return Math.min(0.6, recencyScore);
  }

  /**
   * 加权保留：按分数排序，保留前 N 条直到 token 预算用完
   *
   * @param history 对话历史
   * @param tokenBudget token 预算
   * @returns 保留的消息列表（保持原始顺序）
   */
  retain(history: Content[], tokenBudget: number): Content[] {
    if (history.length === 0) return [];
    if (tokenBudget <= 0) return [];

    this.mustKeepIndices.clear();

    const totalCount = history.length;
    const scored: Array<{ index: number; score: number; tokens: number }> = [];

    // 1. 对所有消息打分
    let totalTokens = 0;
    for (let i = 0; i < history.length; i++) {
      const score = this.scoreMessage(history[i], i, totalCount);
      const tokens = estimateContentTokens(history[i]);
      scored.push({ index: i, score, tokens });
      totalTokens += tokens;
    }

    // 如果总 token 在预算内，返回全部
    if (totalTokens <= tokenBudget) {
      return [...history];
    }

    // 2. 先保留所有 must-keep 的消息
    const keepSet = new Set<number>();
    let usedTokens = 0;

    for (const item of scored) {
      if (this.mustKeepIndices.has(item.index)) {
        keepSet.add(item.index);
        usedTokens += item.tokens;
      }
    }

    // 3. 对剩余消息按分数排序（分数高的优先）
    const remainingBudget = tokenBudget - usedTokens;
    if (remainingBudget <= 0) {
      // 预算已用尽，只保留 must-keep
    } else {
      const remaining = scored
        .filter(item => !keepSet.has(item.index))
        .sort((a, b) => b.score - a.score);

      for (const item of remaining) {
        if (usedTokens + item.tokens > tokenBudget) {
          // 预算不足，跳过这条
          continue;
        }
        keepSet.add(item.index);
        usedTokens += item.tokens;
      }
    }

    // 4. 按原始索引排序输出
    const result: Content[] = [];
    for (let i = 0; i < history.length; i++) {
      if (keepSet.has(i)) {
        result.push(history[i]);
      }
    }

    // 5. 确保第一条消息是 user 角色
    if (result.length > 0 && result[0].role !== MESSAGE_ROLES.USER) {
      result.unshift({
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '[Earlier conversation context]' }],
      });
    }

    return result;
  }

  /**
   * 获取 must-keep 索引集（用于外部判断）
   */
  getMustKeepIndices(): Set<number> {
    return new Set(this.mustKeepIndices);
  }

  // ───────────────── 内部辅助方法 ─────────────────

  /**
   * 从 Content 中提取文本
   */
  private extractText(msg: Content): string {
    if (!msg.parts || msg.parts.length === 0) return '';
    return msg.parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
  }

  /**
   * 检查文本是否匹配系统规则
   */
  private matchesSystemRules(text: string): boolean {
    if (this.context.systemRules.length === 0) return false;

    return this.context.systemRules.some(rule => {
      // 提取规则中的关键词（取前 30 个字符的显著词）
      const keywords = rule.substring(0, 30)
        .split(/\s+/)
        .filter(w => w.length >= 3);

      // 如果至少 2 个关键词在文本中出现
      const matches = keywords.filter(kw =>
        text.includes(kw.toLowerCase())
      );
      return matches.length >= Math.min(2, keywords.length);
    });
  }

  /**
   * 检查文本是否匹配当前任务目标
   */
  private matchesGoal(text: string, goal: string): boolean {
    const goalKeywords = goal
      .substring(0, 60)
      .split(/\s+/)
      .filter(w => w.length >= 3);

    const matches = goalKeywords.filter(kw =>
      text.includes(kw.toLowerCase())
    );
    return matches.length >= Math.min(2, goalKeywords.length);
  }

  /**
   * 检查文本是否包含未完成事项
   */
  private matchesActiveTodos(text: string): boolean {
    if (this.context.activeTodos.length === 0) return false;

    return this.context.activeTodos.some(todo => {
      const keywords = todo
        .substring(0, 30)
        .split(/\s+/)
        .filter(w => w.length >= 3);

      const matches = keywords.filter(kw =>
        text.includes(kw.toLowerCase())
      );
      return matches.length >= 1;
    });
  }

  /**
   * 检查文本是否包含最近错误信息
   */
  private matchesRecentErrors(text: string): boolean {
    if (this.context.recentErrors.length === 0) return false;

    return this.context.recentErrors.some(error => {
      const errorSnippet = error.substring(0, 40).toLowerCase();
      // 精确或模糊匹配
      return text.includes(errorSnippet) ||
        text.includes(errorSnippet.substring(0, 20));
    });
  }

  /**
   * 计算语义相关性分数 (0-1)
   *
   * 当前使用简单的关键词匹配，未来可升级为 embedding 相似度
   */
  private computeSemanticRelevance(text: string): number {
    if (!text || text.trim().length === 0) return 0;

    // 从上下文提取所有有意义的词
    const contextWords = new Set<string>();

    for (const rule of this.context.systemRules) {
      for (const word of rule.split(/\s+/).filter(w => w.length >= 3)) {
        contextWords.add(word.toLowerCase());
      }
    }

    for (const todo of this.context.activeTodos) {
      for (const word of todo.split(/\s+/).filter(w => w.length >= 3)) {
        contextWords.add(word.toLowerCase());
      }
    }

    for (const error of this.context.recentErrors) {
      for (const word of error.split(/\s+/).filter(w => w.length >= 3)) {
        contextWords.add(word.toLowerCase());
      }
    }

    if (this.context.goal) {
      for (const word of this.context.goal.split(/\s+/).filter(w => w.length >= 3)) {
        contextWords.add(word.toLowerCase());
      }
    }

    if (contextWords.size === 0) return 0;

    // 计算文本中有多少上下文词出现了
    const textLower = text.toLowerCase();
    let matchCount = 0;
    for (const word of contextWords) {
      if (textLower.includes(word)) {
        matchCount++;
      }
    }

    return matchCount / contextWords.size;
  }

  /**
   * 判断消息是否为工具输出
   */
  private isToolOutput(msg: Content): boolean {
    if (!msg.parts || msg.parts.length === 0) return false;

    return msg.parts.some((p) =>
      p.functionResponse || (p as { toolResult?: unknown }).toolResult
    );
  }
}

/**
 * 从历史中提取 RetentionContext
 */
export function extractRetentionContext(
  history: Content[],
  goal?: string,
): RetentionContext {
  const systemRules: string[] = [];
  const activeTodos: string[] = [];
  const recentErrors: string[] = [];

  for (const msg of history) {
    if (!msg.parts) continue;

    for (const part of msg.parts) {
      const p = part as { text?: unknown };
      const text = typeof p.text === 'string' ? p.text : undefined;
      if (!text) continue;

      const textLower = text.toLowerCase();

      // 检测系统规则（role='user' 且包含 CRITICAL/SYSTEM/RULES 等关键词）
      if (msg.role === MESSAGE_ROLES.USER &&
          (textLower.includes('critical system') ||
           textLower.includes('system prompt') ||
           textLower.includes('rules') ||
           textLower.includes('safety'))) {
        // 提取规则行
        const lines = text.split('\n').filter(line =>
          line.trim().length > 20 &&
          (line.includes(':') || line.includes('•') || line.includes('-'))
        );
        systemRules.push(...lines.map(l => l.trim()).slice(0, 10));
      }

      // 检测 TODO / 未完成事项
      if (textLower.includes('[ ]') ||
          textLower.includes('todo') ||
          textLower.includes('to do') ||
          textLower.includes('pending')) {
        const todoLines = text.split('\n').filter(line =>
          line.includes('[ ]') ||
          line.toLowerCase().includes('todo') ||
          line.toLowerCase().includes('pending')
        );
        activeTodos.push(...todoLines.map(l => l.trim()).slice(0, 5));
      }

      // 检测错误信息
      if (textLower.includes('error') ||
          textLower.includes('failed') ||
          textLower.includes('exception') ||
          textLower.includes('traceback')) {
        const errorLines = text.split('\n').filter(line =>
          line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('failed') ||
          line.toLowerCase().includes('exception')
        );
        recentErrors.push(...errorLines.map(l => l.trim()).slice(0, 5));
      }
    }
  }

  return {
    goal,
    systemRules,
    activeTodos,
    recentErrors,
  };
}
