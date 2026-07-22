/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * SessionMemoryInjector — 会话级记忆注入器。
 *
 * 新会话启动时，自动搜索 MemorySubsystem，将相关的历史记忆摘要注入到上下文。
 * 低 token 成本 — 仅返回摘要和引用，不做全量回放。
 *
 * 核心策略：
 *  - 从用户消息提取关键词（分词 + 停用词过滤）
 *  - 通过 MemorySubsystem.search() 检索相关记忆
 *  - 时间衰减加权：越旧的记忆分数越低
 *  - 限制：最多 5 条、总 token 数 < 500
 *  - 项目级/全局级作用域区分
 */

import {
  MemorySubsystem,
  MemorySearchResult,
} from './memorySubsystem.js';

// ── 常量 ────────────────────────────────────────────────────────────────

/** 记忆注入条数上限 */
const MAX_ENTRIES = 5;

/** 记忆注入总 token 数上限 */
const MAX_TOKENS = 500;

/** 时间衰减半衰期（天），14 天后分数降为原来的 50% */
const TIME_DECAY_HALF_LIFE_DAYS = 14;

/** 中/英停用词列表 */
const STOP_WORDS = new Set([
  // 中文
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  '什么', '怎么', '如何', '为什么', '因为', '所以', '但是', '虽然',
  '可以', '这个', '那个', '如果', '还是', '或者', '还有', '只是',
  // 英文
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'she', 'it', 'they', 'them', 'this', 'that', 'these',
  'those', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'about', 'like', 'through', 'after', 'over', 'between', 'out',
  'against', 'during', 'without', 'before', 'under', 'around', 'among',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'because', 'then', 'now', 'also', 'here', 'there', 'when', 'where', 'why',
  'how', 'who', 'whom', 'which', 'what',
]);

// ── 公开类型 ────────────────────────────────────────────────────────────

/** 记忆注入结果 */
export interface MemoryInjection {
  /** 匹配到的记忆条目 */
  entries: MemorySearchResult[];
  /** 人类可读的摘要文本（可注入到 system prompt 或首条 user message） */
  summary: string;
  /** summary 的估算 token 数 */
  tokenCount: number;
  /** 检索到的总条目数（含被过滤的），用于 UI 展示 "Found N relevant memories" */
  totalFound: number;
  /** 项目级条目数 */
  projectCount: number;
  /** 全局级条目数 */
  globalCount: number;
}

// ── SessionMemoryInjector ───────────────────────────────────────────────

export class SessionMemoryInjector {
  private memorySubsystem: MemorySubsystem;

  constructor(memorySubsystem: MemorySubsystem) {
    this.memorySubsystem = memorySubsystem;
  }

  /**
   * 注入新会话的记忆上下文。
   *
   * @param sessionId  当前会话 ID（保留，未来可用于会话级记忆过滤）
   * @param userMessage 用户输入的第一条消息，用于提取关键词
   * @returns MemoryInjection — 包含筛选后的记忆条目、摘要和统计
   */
  async inject(
    _sessionId: string,
    userMessage: string,
  ): Promise<MemoryInjection> {
    if (!userMessage || !userMessage.trim()) {
      return this.emptyInjection();
    }

    // 1. 提取关键词
    const keywords = this.extractKeywords(userMessage);
    if (keywords.length === 0) {
      return this.emptyInjection();
    }

    // 2. 搜索全局记忆
    const query = keywords.join(' ');
    let allResults: MemorySearchResult[];

    try {
      allResults = await this.memorySubsystem.search(query, { limit: 50 });
    } catch {
      return this.emptyInjection();
    }

    if (allResults.length === 0) {
      return this.emptyInjection();
    }

    // 3. 按作用域分组
    const projectResults: MemorySearchResult[] = [];
    const globalResults: MemorySearchResult[] = [];
    for (const r of allResults) {
      // 通过 sourceEvent 或标签判断作用域
      if (this.isProjectScope(r)) {
        projectResults.push(r);
      } else {
        globalResults.push(r);
      }
    }

    // 4. 时间衰减加权
    const now = Date.now();
    const scored = allResults.map(r => ({
      result: r,
      score: this.applyTimeDecay(r.score, r.entry.timestamp, now),
    }));
    scored.sort((a, b) => b.score - a.score);

    // 5. 按 token 预算筛选
    const selected: MemorySearchResult[] = [];
    let tokenBudget = 0;
    for (const item of scored) {
      if (selected.length >= MAX_ENTRIES) break;
      const entryTokens = this.estimateTokens(item.result.entry.content);
      if (tokenBudget + entryTokens > MAX_TOKENS) continue;
      selected.push(item.result);
      tokenBudget += entryTokens;
    }

    // 6. 构建摘要
    const summary = this.buildSummary(selected);

    return {
      entries: selected,
      summary,
      tokenCount: this.estimateTokens(summary),
      totalFound: allResults.length,
      projectCount: projectResults.length,
      globalCount: globalResults.length,
    };
  }

  // ── 内部方法 ──────────────────────────────────────────────────────────

  /**
   * 从用户消息中提取关键词。
   * 简单策略：分词 → 去停用词 → 去重 → 取前 10 个。
   */
  extractKeywords(text: string): string[] {
    const cleaned = text
      .replace(/[^\p{L}\p{N}\s\-_.@/]/gu, ' ') // 保留字母数字和路径符号
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // 分词：按空白和常见分隔符
    const tokens = cleaned.split(/[\s,，、;；:：]+/).filter(t => t.length > 0);

    // 去停用词、去短词
    const meaningful = tokens.filter(t => {
      if (t.length < 2) return false;
      if (STOP_WORDS.has(t)) return false;
      return true;
    });

    // 去重 + 限制
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of meaningful) {
      if (seen.has(t)) continue;
      seen.add(t);
      result.push(t);
      if (result.length >= 10) break;
    }

    return result;
  }

  /**
   * 时间衰减函数。
   * 使用半衰期模型：score = originalScore × 0.5^(ageInDays / halfLife)
   */
  applyTimeDecay(score: number, timestamp: string, now: number): number {
    try {
      const ts = new Date(timestamp).getTime();
      if (isNaN(ts)) return score;
      const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
      if (ageDays < 0) return score; // 未来时间不衰减
      const decay = Math.pow(0.5, ageDays / TIME_DECAY_HALF_LIFE_DAYS);
      return score * decay;
    } catch {
      return score;
    }
  }

  /**
   * 判断记忆条目是否为项目级作用域。
   * 启发式：项目 scope 的条目 sourceEvent 通常不以 "global" 开头，
   *         且可能包含项目路径特征。
   */
  isProjectScope(result: MemorySearchResult): boolean {
    const entry = result.entry;
    // 直接检查标签
    if (entry.tags?.some(t => t.toLowerCase() === 'project')) return true;
    // 检查 content 和 sourceEvent 中的项目路径特征
    const haystack = `${entry.content} ${entry.sourceEvent}`.toLowerCase();
    // 包含路径分隔符、package.json、项目名等特征 → 可能是项目级
    const projectPatterns =
      /[\/\\]|package\.json|tsconfig|\.git|src[\/\\]|node_modules|project|repo/i;
    return projectPatterns.test(haystack);
  }

  /**
   * 简单 token 估算（与 memorySubsystem 一致的估算方式）。
   */
  estimateTokens(text: string): number {
    const cjk = (
      text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []
    ).length;
    const ascii = text.length - cjk;
    return Math.ceil(cjk * 1.5 + ascii / 4);
  }

  /**
   * 构建人类可读的摘要文本。
   */
  buildSummary(entries: MemorySearchResult[]): string {
    if (entries.length === 0) return '';

    const lines: string[] = [];
    lines.push('[Previous relevant context from memory]');

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const scope = this.isProjectScope(e) ? 'project' : 'global';
      // 截断长文本
      const content =
        e.entry.content.length > 200
          ? e.entry.content.substring(0, 200) + '…'
          : e.entry.content;
      lines.push(
        `- [${scope}] ${content} (relevance: ${e.score.toFixed(1)})`,
      );
    }

    return lines.join('\n');
  }

  /**
   * 返回空注入结果。
   */
  private emptyInjection(): MemoryInjection {
    return {
      entries: [],
      summary: '',
      tokenCount: 0,
      totalFound: 0,
      projectCount: 0,
      globalCount: 0,
    };
  }
}
