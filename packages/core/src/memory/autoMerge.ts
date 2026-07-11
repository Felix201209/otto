/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto Auto Memory Merge & Split — 记忆自动合并与分割引擎。
 *
 * 核心能力:
 *   1. 记忆自动合并: 检测相似/相关记忆条目，自动合并去重
 *   2. 记忆自动分割: 当单条记忆文件超过阈值时，按主题自动分割
 *   3. 记忆压缩: 对老旧记忆进行摘要压缩
 *   4. 记忆生命周期: 自动过期清理与归档
 *
 * 与现有 memoryProvider.ts 的关系:
 *   - memoryProvider.ts 是三层 CRUD 抽象
 *   - 本模块是在其之上的智能调度层，负责合并/分割/压缩决策
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

// ============================================================
// 类型定义
// ============================================================

/** 单条记忆条目 */
export interface MemoryEntry {
  id: string;
  /** 原始文本 */
  text: string;
  /** 时间戳 */
  timestamp: string;
  /** 主题标签 */
  topics: string[];
  /** 来源 session ID */
  sourceSessionId?: string;
  /** 来源 scope */
  scope: MemoryScope;
  /** 访问次数 */
  accessCount: number;
  /** 最后访问时间 */
  lastAccessedAt: string;
  /** 是否已压缩（由 older 记忆压缩产生） */
  compressed: boolean;
  /** 原始条目 ID（压缩时记录来源） */
  compressedFrom?: string[];
}

/** 记忆作用域（与 memoryProvider.ts 一致） */
export type MemoryScope = 'global' | 'project' | 'session';

/** 合并策略 */
export type MergeStrategy = 'auto_similarity' | 'auto_same_topic' | 'auto_same_session' | 'manual';

/** 分割策略 */
export type AutoSplitStrategy = 'by_topic' | 'by_time_range' | 'by_token_count';

/** 合并建议（供 LLM 或用户确认） */
export interface MergeSuggestion {
  entryIds: string[];
  /** 建议合并后的文本 */
  mergedText: string;
  /** 合并理由 */
  reason: string;
  confidence: number;
  strategy: MergeStrategy;
}

/** 分割建议 */
export interface SplitSuggestion {
  sourceEntryId: string;
  /** 建议分割出的子条目 */
  childEntries: Array<{ text: string; topic: string }>;
  reason: string;
}

/** 记忆压缩结果 */
export interface MemoryCompressionResult {
  originalEntryIds: string[];
  summary: string;
  preservedKeywords: string[];
  compressedAt: string;
}

/** 记忆统计 */
export interface MemoryStats {
  totalEntries: number;
  byScope: Record<string, number>;
  oldestEntry: string | null;
  newestEntry: string | null;
  totalEstimatedTokens: number;
  compressionRatio: number; // 0-1, 已压缩占比
}

/** 合并引擎配置 */
export interface AutoMemoryEngineConfig {
  /** 存储路径 */
  storageDir: string;
  /** 单个 scope 最大条目数（超过触发压缩） */
  maxEntriesPerScope: number;
  /** 相似度阈值（0-1），高于此值自动合并 */
  similarityThreshold: number;
  /** 是否自动执行合并（false 则仅生成建议） */
  autoMerge: boolean;
  /** 是否自动执行分割 */
  autoSplit: boolean;
  /** 记忆条目最老保留天数 */
  maxAgeDays: number;
  /** 是否启用 LLM 辅助合并 */
  llmAssistedMerge: boolean;
  /** 压缩时间阈值（超过 N 天的条目被压缩） */
  compressAfterDays: number;
}

/** 分词接口（用于 token 估算，可注入） */
export interface TokenEstimator {
  estimate(text: string): number;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: AutoMemoryEngineConfig = {
  storageDir: path.join(homedir(), '.otto-user', 'memory'),
  maxEntriesPerScope: 500,
  similarityThreshold: 0.75,
  autoMerge: true,
  autoSplit: true,
  maxAgeDays: 90,
  llmAssistedMerge: true,
  compressAfterDays: 30,
};

// 简单 token 估算（中文约 1.5 chars/token，英文约 4 chars/token）
const DEFAULT_TOKEN_ESTIMATOR: TokenEstimator = {
  estimate: (text: string): number => {
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const ascii = text.length - cjk;
    return Math.ceil(cjk * 1.5 + ascii / 4);
  },
};

// ============================================================
// 自动记忆合并/分割引擎
// ============================================================

export class AutoMemoryEngine {
  private entries: MemoryEntry[] = [];
  private config: AutoMemoryEngineConfig;
  private tokenEstimator: TokenEstimator;
  private initialized = false;

  constructor(
    config?: Partial<AutoMemoryEngineConfig>,
    tokenEstimator?: TokenEstimator,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenEstimator = tokenEstimator || DEFAULT_TOKEN_ESTIMATOR;
  }

  // ── 初始化 ─────────────────────────────────────────────

  /**
   * 从磁盘加载记忆条目。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const indexPath = path.join(this.config.storageDir, 'memory-index.json');
      const raw = await fs.readFile(indexPath, 'utf-8');
      this.entries = JSON.parse(raw) as MemoryEntry[];
      console.log(`[AutoMemory] Loaded ${this.entries.length} memory entries`);
    } catch {
      console.log('[AutoMemory] No existing memory index, starting fresh');
    }
    this.initialized = true;
  }

  // ── 持久化 ─────────────────────────────────────────────

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const indexPath = path.join(this.config.storageDir, 'memory-index.json');
      await fs.writeFile(
        indexPath,
        JSON.stringify(this.entries, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[AutoMemory] Persist failed:', err);
    }
  }

  // ── 条目管理 ─────────────────────────────────────────

  /**
   * 添加一条新记忆。
   * 添加后自动触发合并检测。
   */
  async addEntry(opts: {
    text: string;
    topics?: string[];
    scope: MemoryScope;
    sourceSessionId?: string;
  }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: opts.text,
      timestamp: new Date().toISOString(),
      topics: opts.topics || [],
      scope: opts.scope,
      sourceSessionId: opts.sourceSessionId,
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
      compressed: false,
    };
    this.entries.push(entry);
    await this.persist();

    // 自动合并检测
    if (this.config.autoMerge) {
      const suggestions = await this.detectMergeCandidates();
      if (suggestions.length > 0) {
        console.log(
          `[AutoMemory] ${suggestions.length} merge candidate(s) detected after adding entry`,
        );
        for (const s of suggestions.slice(0, 3)) {
          await this.applyMerge(s);
        }
      }
    }

    // 自动分割检测
    if (this.config.autoSplit) {
      const splits = await this.detectSplitCandidates();
      if (splits.length > 0) {
        console.log(
          `[AutoMemory] ${splits.length} split candidate(s) detected`,
        );
        for (const s of splits.slice(0, 2)) {
          await this.applySplit(s);
        }
      }
    }

    return entry;
  }

  /**
   * 查询记忆条目（支持过滤）。
   */
  queryEntries(filter?: {
    scope?: MemoryScope;
    topic?: string;
    keywords?: string[];
    limit?: number;
  }): MemoryEntry[] {
    let result = [...this.entries];
    if (filter?.scope) {
      result = result.filter(e => e.scope === filter.scope);
    }
    if (filter?.topic) {
      result = result.filter(e =>
        e.topics.some(t => t.includes(filter!.topic!)),
      );
    }
    if (filter?.keywords && filter.keywords.length > 0) {
      result = result.filter(e =>
        filter!.keywords!.some(kw => e.text.includes(kw)),
      );
    }
    // 按最后访问时间降序
    result.sort(
      (a, b) =>
        new Date(b.lastAccessedAt).getTime() -
        new Date(a.lastAccessedAt).getTime(),
    );
    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }
    return result;
  }

  // ── 自动合并 ─────────────────────────────────────────

  /**
   * 检测可合并的记忆条目。
   *
   * 策略:
   *   - 同一 scope、相同主题、文本相似度高
   *   - 同一来源 session 的条目
   *   - 时间上连续的同类条目
   */
  async detectMergeCandidates(): Promise<MergeSuggestion[]> {
    const suggestions: MergeSuggestion[] = [];

    // 按 scope + topics 分组
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of this.entries) {
      if (entry.compressed) continue;
      for (const topic of entry.topics) {
        const key = `${entry.scope}::${topic}`;
        const group = groups.get(key) || [];
        group.push(entry);
        groups.set(key, group);
      }
    }

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      // 在同主题组内计算两两相似度
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const similarity = this.computeSimilarity(a.text, b.text);

          if (similarity >= this.config.similarityThreshold) {
            // 检查是否已经建议合并过
            if (this.wasRecentlyMerged(a.id, b.id)) continue;

            const mergedText = this.mergeTexts(a.text, b.text);
            suggestions.push({
              entryIds: [a.id, b.id],
              mergedText,
              reason: `同一主题"${a.topics.join(',')}"，相似度 ${(similarity * 100).toFixed(0)}%`,
              confidence: similarity,
              strategy: 'auto_similarity',
            });
          }
        }
      }
    }

    // 按置信度降序
    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions;
  }

  /**
   * 执行一次合并。
   */
  async applyMerge(suggestion: MergeSuggestion): Promise<MemoryEntry | null> {
    if (suggestion.entryIds.length < 2) return null;

    const sourceEntries = this.entries.filter(e =>
      suggestion.entryIds.includes(e.id),
    );
    if (sourceEntries.length < 2) return null;

    // 创建合并后的新条目
    const mergedEntry: MemoryEntry = {
      id: `mem_merged_${Date.now()}`,
      text: suggestion.mergedText,
      timestamp: new Date().toISOString(),
      topics: [
        ...new Set(sourceEntries.flatMap(e => e.topics)),
      ],
      scope: sourceEntries[0].scope,
      sourceSessionId: sourceEntries[0].sourceSessionId,
      accessCount: sourceEntries.reduce((sum, e) => sum + e.accessCount, 0),
      lastAccessedAt: new Date().toISOString(),
      compressed: false,
      compressedFrom: suggestion.entryIds,
    };

    // 从源条目记录压缩来源
    for (const src of sourceEntries) {
      src.compressed = true;
      src.compressedFrom = [mergedEntry.id];
    }

    this.entries.push(mergedEntry);
    await this.persist();

    // 记录合并操作
    const logPath = path.join(
      this.config.storageDir,
      'merge-history.jsonl',
    );
    const logEntry = JSON.stringify({
      type: 'merge',
      timestamp: mergedEntry.timestamp,
      sourceIds: suggestion.entryIds,
      targetId: mergedEntry.id,
      reason: suggestion.reason,
    });
    await fs.appendFile(logPath, logEntry + '\n', 'utf-8');

    console.log(
      `[AutoMemory] Merged ${suggestion.entryIds.length} entries → ${mergedEntry.id}`,
    );
    return mergedEntry;
  }

  // ── 自动分割 ─────────────────────────────────────────

  /**
   * 检测需要分割的记忆条目。
   *
   * 策略:
   *   - 单条文本包含过多不同主题
   *   - 单条文本 token 数超过阈值
   *   - 用户合并过的记忆可能太宽泛
   */
  async detectSplitCandidates(): Promise<SplitSuggestion[]> {
    const suggestions: SplitSuggestion[] = [];
    const MAX_TOKENS_PER_ENTRY = 2000;

    for (const entry of this.entries) {
      if (entry.compressed) continue;
      const tokens = this.tokenEstimator.estimate(entry.text);

      if (tokens > MAX_TOKENS_PER_ENTRY && entry.topics.length > 1) {
        // 按主题分割
        const children = this.splitByTopics(entry.text, entry.topics);
        if (children.length > 1) {
          suggestions.push({
            sourceEntryId: entry.id,
            childEntries: children,
            reason: `条目含 ${entry.topics.length} 个主题，${tokens} tokens，建议按主题分割`,
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * 执行一次分割。
   */
  async applySplit(suggestion: SplitSuggestion): Promise<MemoryEntry[]> {
    const sourceEntry = this.entries.find(
      e => e.id === suggestion.sourceEntryId,
    );
    if (!sourceEntry) return [];

    const children: MemoryEntry[] = [];
    for (const child of suggestion.childEntries) {
      const childEntry: MemoryEntry = {
        id: `mem_split_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: child.text,
        timestamp: sourceEntry.timestamp,
        topics: [child.topic],
        scope: sourceEntry.scope,
        sourceSessionId: sourceEntry.sourceSessionId,
        accessCount: sourceEntry.accessCount,
        lastAccessedAt: new Date().toISOString(),
        compressed: false,
        compressedFrom: [sourceEntry.id],
      };
      children.push(childEntry);
    }

    // 标记源条目为已压缩
    sourceEntry.compressed = true;
    sourceEntry.compressedFrom = children.map(c => c.id);

    this.entries.push(...children);
    await this.persist();

    // 记录分割操作
    const logPath = path.join(
      this.config.storageDir,
      'split-history.jsonl',
    );
    const logEntry = JSON.stringify({
      type: 'split',
      timestamp: new Date().toISOString(),
      sourceId: suggestion.sourceEntryId,
      childIds: children.map(c => c.id),
      reason: suggestion.reason,
    });
    await fs.appendFile(logPath, logEntry + '\n', 'utf-8');

    console.log(
      `[AutoMemory] Split ${suggestion.sourceEntryId} into ${children.length} entries`,
    );
    return children;
  }

  // ── 记忆压缩 ─────────────────────────────────────────

  /**
   * 压缩老旧记忆。
   * 对超过 compressAfterDays 的条目，按主题生成摘要。
   */
  async compressOldMemories(): Promise<MemoryCompressionResult[]> {
    const results: MemoryCompressionResult[] = [];
    const cutoff = Date.now() - this.config.compressAfterDays * 24 * 60 * 60 * 1000;

    // 按 scope+主题 分组
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of this.entries) {
      if (entry.compressed) continue;
      if (new Date(entry.timestamp).getTime() > cutoff) continue;
      for (const topic of entry.topics) {
        const key = `${entry.scope}::${topic}`;
        const group = groups.get(key) || [];
        group.push(entry);
        groups.set(key, group);
      }
    }

    for (const [, group] of groups) {
      if (group.length < 3) continue; // 少于三条不压缩

      const keywords = this.extractKeywords(group.map(e => e.text));
      const summary = this.generateSummary(group.map(e => e.text));
      const originalIds = group.map(e => e.id);

      const compressed: MemoryCompressionResult = {
        originalEntryIds: originalIds,
        summary,
        preservedKeywords: keywords,
        compressedAt: new Date().toISOString(),
      };

      // 标记原条目为已压缩
      for (const entry of group) {
        entry.compressed = true;
      }

      // 创建压缩摘要条目
      const summaryEntry: MemoryEntry = {
        id: `mem_compressed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: `[COMPRESSED] ${summary}`,
        timestamp: new Date().toISOString(),
        topics: [...new Set(group.flatMap(e => e.topics))],
        scope: group[0].scope,
        accessCount: group.reduce((s, e) => s + e.accessCount, 0),
        lastAccessedAt: new Date().toISOString(),
        compressed: true,
        compressedFrom: originalIds,
      };

      this.entries.push(summaryEntry);
      results.push(compressed);
    }

    if (results.length > 0) {
      await this.persist();
      console.log(`[AutoMemory] Compressed ${results.length} memory group(s)`);
    }

    return results;
  }

  /**
   * 清理过期记忆。
   */
  async cleanExpiredMemories(): Promise<number> {
    const cutoff = Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      // 保留未压缩的活跃条目
      if (!e.compressed) return true;
      // 已压缩的条目超过 maxAgeDays 可以删除
      return new Date(e.timestamp).getTime() >= cutoff;
    });
    const after = this.entries.length;
    const removed = before - after;
    if (removed > 0) {
      await this.persist();
      console.log(`[AutoMemory] Cleaned ${removed} expired entries`);
    }
    return removed;
  }

  // ── 生命周期管理 ─────────────────────────────────────

  /**
   * 执行完整的记忆维护周期。
   * 可由定时器或 idle 时调用。
   */
  async runMaintenanceCycle(): Promise<{
    merges: number;
    splits: number;
    compressions: number;
    cleanups: number;
  }> {
    const mergeSuggestions = await this.detectMergeCandidates();
    let merges = 0;
    if (this.config.autoMerge) {
      for (const s of mergeSuggestions.slice(0, 5)) {
        const result = await this.applyMerge(s);
        if (result) merges++;
      }
    }

    const splitSuggestions = await this.detectSplitCandidates();
    let splits = 0;
    if (this.config.autoSplit) {
      for (const s of splitSuggestions.slice(0, 3)) {
        const result = await this.applySplit(s);
        if (result.length > 0) splits++;
      }
    }

    const compressions = (await this.compressOldMemories()).length;
    const cleanups = await this.cleanExpiredMemories();

    return { merges, splits, compressions, cleanups };
  }

  // ── 统计 ─────────────────────────────────────────────

  getStats(): MemoryStats {
    const byScope: Record<string, number> = {};
    let oldest: string | null = null;
    let newest: string | null = null;

    for (const e of this.entries) {
      byScope[e.scope] = (byScope[e.scope] || 0) + 1;
      if (!oldest || e.timestamp < oldest) oldest = e.timestamp;
      if (!newest || e.timestamp > newest) newest = e.timestamp;
    }

    const totalTokens = this.entries.reduce(
      (sum, e) => sum + this.tokenEstimator.estimate(e.text),
      0,
    );
    const compressedCount = this.entries.filter(e => e.compressed).length;

    return {
      totalEntries: this.entries.length,
      byScope,
      oldestEntry: oldest,
      newestEntry: newest,
      totalEstimatedTokens: totalTokens,
      compressionRatio: this.entries.length > 0 ? compressedCount / this.entries.length : 0,
    };
  }

  // ── 内部算法 ─────────────────────────────────────────

  /**
   * 计算两条文本的相似度（0-1）。
   * 使用基于 Jaccard 和 TF 的轻量相似度。
   */
  private computeSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
    const union = new Set([...tokensA, ...tokensB]);

    // Jaccard similarity
    const jaccard = intersection.size / union.size;

    // 长度相近加分
    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

    return jaccard * 0.7 + lenRatio * 0.3;
  }

  /**
   * 简单分词。
   */
  private tokenize(text: string): Set<string> {
    const tokens = new Set<string>();
    // 中文二元组
    for (let i = 0; i < text.length - 1; i++) {
      const char = text[i];
      if (/[\u4e00-\u9fff]/.test(char)) {
        tokens.add(text.substring(i, i + 2));
      }
    }
    // 英文单词
    const words = text.match(/[a-zA-Z_]\w{2,}/g) || [];
    for (const w of words) tokens.add(w.toLowerCase());
    return tokens;
  }

  /**
   * 合并两条文本（保留完整信息）。
   */
  private mergeTexts(a: string, b: string): string {
    // 如果包含关系，直接返回长的
    if (a.includes(b) || b.includes(a)) {
      return a.length >= b.length ? a : b;
    }
    return `${a}\n${b}`;
  }

  /**
   * 检查两条条目是否最近已被合并（避免重复操作）。
   */
  private wasRecentlyMerged(idA: string, idB: string): boolean {
    // 简单检查：是否互为 compressedFrom
    const entryA = this.entries.find(e => e.id === idA);
    const entryB = this.entries.find(e => e.id === idB);
    if (!entryA || !entryB) return false;
    return entryA.compressedFrom?.includes(idB) ||
      entryB.compressedFrom?.includes(idA) ||
      false;
  }

  /**
   * 按主题分割文本。
   */
  private splitByTopics(
    text: string,
    topics: string[],
  ): Array<{ text: string; topic: string }> {
    // 简单的启发式分割：为每个主题分配部分文本
    if (topics.length === 0) return [{ text, topic: 'general' }];
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length <= 1) return [{ text, topic: topics[0] }];

    // 按行均分到各主题
    const perTopic = Math.ceil(lines.length / topics.length);
    const children: Array<{ text: string; topic: string }> = [];
    for (let i = 0; i < topics.length; i++) {
      const start = i * perTopic;
      const end = Math.min(start + perTopic, lines.length);
      if (start >= lines.length) break;
      children.push({
        text: lines.slice(start, end).join('\n'),
        topic: topics[i],
      });
    }
    return children;
  }

  /**
   * 提取关键词。
   */
  private extractKeywords(texts: string[]): string[] {
    const wordFreq = new Map<string, number>();
    for (const t of texts) {
      const tokens = this.tokenize(t);
      for (const token of tokens) {
        wordFreq.set(token, (wordFreq.get(token) || 0) + 1);
      }
    }
    return [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  /**
   * 生成摘要（基于提取式的简单摘要）。
   */
  private generateSummary(texts: string[]): string {
    if (texts.length === 0) return '';
    // 取第一条 + 最后一条 + 关键词
    const first = texts[0].substring(0, 100);
    const keywords = this.extractKeywords(texts);
    const kwStr = keywords.slice(0, 5).join(', ');
    return `${first}… [关键词: ${kwStr}, 共 ${texts.length} 条]`;
  }

  /**
   * 获取未压缩的原始条目（用于 LLM assisted merge）。
   */
  getUncompressedEntries(scope?: MemoryScope): MemoryEntry[] {
    return this.entries.filter(e => {
      if (scope && e.scope !== scope) return false;
      return !e.compressed;
    });
  }
}

// ============================================================
// 全局单例
// ============================================================

let globalAutoMemory: AutoMemoryEngine | null = null;

export function getAutoMemoryEngine(
  config?: Partial<AutoMemoryEngineConfig>,
): AutoMemoryEngine {
  if (!globalAutoMemory) {
    globalAutoMemory = new AutoMemoryEngine(config);
  }
  return globalAutoMemory;
}
