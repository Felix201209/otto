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
 * 数据源（v2 — 方案 B）：
 *   本引擎不再依赖独立的 memory-index.json 作为唯一输入，而是直接扫描用户
 *   已有的记忆存储文件：
 *     - ~/.otto-user/memory/global.md   (save_memory 写入，## Otto Added Memories)
 *     - ~/.otto-user/knowledge/entries.jsonl (knowledge_base 写入，JSONL)
 *
 *   每个维护周期重新扫描这些源文件，构建内存索引，检测跨源重复和相似条目，
 *   执行合并/压缩/清理。源文件本身只读——合并结果写入 memory-index.json
 *   并通过 global.md 的原地去重来保持数据源清洁。
 *
 * 与现有 memoryProvider.ts 的关系:
 *   - memoryProvider.ts 是三层 CRUD 抽象
 *   - 本模块是在其之上的智能调度层，负责合并/分割/压缩决策
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import {
  atomicWriteTextFile,
  deduplicateGlobalMemoryContent,
  GLOBAL_MEMORY_SECTION_HEADER,
} from './globalMemoryMaintenance.js';
import { withMemoryFileWriteLock } from './memoryFileLock.js';

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
  /** 来源文件类型 */
  sourceType: 'global_md' | 'knowledge_jsonl' | 'merged';
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
  /** 知识库路径 */
  knowledgeDir: string;
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
  /** global.md 文件路径 */
  globalMdPath: string;
  /** knowledge entries.jsonl 路径 */
  knowledgeJsonlPath: string;
}

/** 分词接口（用于 token 估算，可注入） */
export interface TokenEstimator {
  estimate(text: string): number;
}

// ============================================================
// 默认配置
// ============================================================

const MEMORY_ROOT = path.join(homedir(), '.otto-user', 'memory');
const KNOWLEDGE_ROOT = path.join(homedir(), '.otto-user', 'knowledge');

const DEFAULT_CONFIG: AutoMemoryEngineConfig = {
  storageDir: MEMORY_ROOT,
  knowledgeDir: KNOWLEDGE_ROOT,
  maxEntriesPerScope: 500,
  similarityThreshold: 0.75,
  autoMerge: true,
  autoSplit: true,
  maxAgeDays: 90,
  llmAssistedMerge: true,
  compressAfterDays: 30,
  globalMdPath: path.join(MEMORY_ROOT, 'global.md'),
  knowledgeJsonlPath: path.join(KNOWLEDGE_ROOT, 'entries.jsonl'),
};

// 简单 token 估算（中文约 1.5 chars/token，英文约 4 chars/token）
const DEFAULT_TOKEN_ESTIMATOR: TokenEstimator = {
  estimate: (text: string): number => {
    const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    const ascii = text.length - cjk;
    return Math.ceil(cjk * 1.5 + ascii / 4);
  },
};

const MEMORY_SECTION_HEADER = GLOBAL_MEMORY_SECTION_HEADER;

// ============================================================
// 自动记忆合并/分割引擎
// ============================================================

export class AutoMemoryEngine {
  private entries: MemoryEntry[] = [];
  private config: AutoMemoryEngineConfig;
  private tokenEstimator: TokenEstimator;
  private initialized = false;
  /** 上次扫描时源文件的快照指纹（用于检测增量变更） */
  private lastSourceFingerprints: Map<string, string> = new Map();

  constructor(
    config?: Partial<AutoMemoryEngineConfig>,
    tokenEstimator?: TokenEstimator,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenEstimator = tokenEstimator || DEFAULT_TOKEN_ESTIMATOR;
  }

  // ── 初始化 ─────────────────────────────────────────────

  /**
   * 扫描所有源文件，构建内存条目索引。
   * 数据源：global.md (## Otto Added Memories) + entries.jsonl (JSONL)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.entries = await this.scanAllSources();
    await this.persistIndex();
    this.initialized = true;
    console.log(`[AutoMemory] Loaded ${this.entries.length} memory entries from source files`);
  }

  // ── 源文件扫描 ────────────────────────────────────────

  /**
   * 扫描所有数据源，解析为 MemoryEntry 数组。
   */
  private async scanAllSources(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = [];

    // 1. 扫描 global.md（save_memory 写入）
    try {
      const globalEntries = await this.parseGlobalMd();
      entries.push(...globalEntries);
      console.log(`[AutoMemory] Parsed ${globalEntries.length} entries from global.md`);
    } catch (e) {
      console.warn('[AutoMemory] Failed to parse global.md:', e);
    }

    // 2. 扫描 knowledge/entries.jsonl（knowledge_base 写入）
    try {
      const knowledgeEntries = await this.parseKnowledgeJsonl();
      entries.push(...knowledgeEntries);
      console.log(`[AutoMemory] Parsed ${knowledgeEntries.length} entries from entries.jsonl`);
    } catch (e) {
      console.warn('[AutoMemory] Failed to parse entries.jsonl:', e);
    }

    // 去重：同一文本可能同时出现在两个源中（取时间较新的）
    const deduped = this.deduplicateCrossSource(entries);
    if (deduped.length < entries.length) {
      console.log(
        `[AutoMemory] Cross-source dedup: ${entries.length - deduped.length} duplicates removed`,
      );
    }
    return deduped;
  }

  /**
   * 解析 global.md 中的记忆条目。
   * 格式：
   *   ## Otto Added Memories
   *   - fact 1
   *   - fact 2
   */
  private async parseGlobalMd(): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.config.globalMdPath, 'utf-8');
    } catch {
      return []; // 文件不存在
    }

    const entries: MemoryEntry[] = [];
    const headerIdx = raw.indexOf(MEMORY_SECTION_HEADER);
    if (headerIdx < 0) return entries;

    // 取出 header 之后、下一个 ## section 之前的所有内容
    const afterHeader = raw.substring(headerIdx + MEMORY_SECTION_HEADER.length);
    const nextSection = afterHeader.indexOf('\n## ');
    const sectionBody =
      nextSection >= 0 ? afterHeader.substring(0, nextSection) : afterHeader;

    // 解析每一行 "- fact" 条目
    const lines = sectionBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) continue;
      const fact = trimmed.replace(/^-\s*/, '').trim();
      if (!fact) continue;

      // 去重：已有相同文本的条目则跳过
      const dup = entries.find(e => e.text === fact);
      if (dup) continue;

      const topics = this.inferTopicsFromText(fact);
      entries.push({
        id: `md_${this.hashText(fact)}`,
        text: fact,
        timestamp: new Date().toISOString(), // global.md 无独立时间戳
        topics,
        scope: 'global',
        sourceType: 'global_md',
        accessCount: 0,
        lastAccessedAt: new Date().toISOString(),
        compressed: false,
      });
    }

    return entries;
  }

  /**
   * 解析 knowledge/entries.jsonl 中的知识条目。
   */
  private async parseKnowledgeJsonl(): Promise<MemoryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.config.knowledgeJsonlPath, 'utf-8');
    } catch {
      return []; // 文件不存在
    }

    const entries: MemoryEntry[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.id || !parsed.content) continue;
        const topics = this.inferTopicsFromText(parsed.content);
        if (parsed.category && !topics.includes(parsed.category)) {
          topics.push(parsed.category);
        }
        entries.push({
          id: `kb_${parsed.id}`,
          text: parsed.content,
          timestamp: parsed.createdAt || new Date().toISOString(),
          topics,
          scope: 'global',
          sourceType: 'knowledge_jsonl',
          accessCount: 0,
          lastAccessedAt: parsed.createdAt || new Date().toISOString(),
          compressed: false,
        });
      } catch {
        // 坏行跳过
      }
    }
    return entries;
  }

  /**
   * 跨源去重：同一文本或高度相似的文本只保留一个。
   */
  private deduplicateCrossSource(entries: MemoryEntry[]): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    for (const entry of entries) {
      // 检查是否与已有条目高度相似
      const similar = result.find(
        r => this.computeSimilarity(r.text, entry.text) >= 0.85,
      );
      if (similar) {
        // 保留时间较新的
        if (new Date(entry.timestamp) > new Date(similar.timestamp)) {
          result[result.indexOf(similar)] = entry;
        }
        continue;
      }
      result.push(entry);
    }
    return result;
  }

  // ── global.md 原地去重 ─────────────────────────────────

  /**
   * 对 global.md 执行原地去重：重写文件，移除重复记忆行。
   * 这保证了源文件本身保持清洁，不无限膨胀。
   */
  async deduplicateGlobalMd(): Promise<{
    before: number;
    after: number;
    removed: number;
  }> {
    return withMemoryFileWriteLock(this.config.globalMdPath, async () => {
      let raw: string;
      try {
        raw = await fs.readFile(this.config.globalMdPath, 'utf-8');
      } catch {
        return { before: 0, after: 0, removed: 0 };
      }

      const result = deduplicateGlobalMemoryContent(raw);
      if (result.removed === 0) {
        return { before: result.before, after: result.after, removed: 0 };
      }

      await atomicWriteTextFile(this.config.globalMdPath, result.content);
      console.log(
        `[AutoMemory] Deduplicated global.md: ${result.before} → ${result.after} facts (${result.removed} removed)`,
      );
      return {
        before: result.before,
        after: result.after,
        removed: result.removed,
      };
    });
  }

  // ── 持久化 ─────────────────────────────────────────────

  /**
   * 持久化当前内存索引到 memory-index.json（归一化缓存）。
   */
  private async persistIndex(): Promise<void> {
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
      sourceType: 'merged',
      sourceSessionId: opts.sourceSessionId,
      accessCount: 0,
      lastAccessedAt: new Date().toISOString(),
      compressed: false,
    };
    this.entries.push(entry);
    await this.persistIndex();

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

  async detectMergeCandidates(): Promise<MergeSuggestion[]> {
    const suggestions: MergeSuggestion[] = [];

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
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          const similarity = this.computeSimilarity(a.text, b.text);

          if (similarity >= this.config.similarityThreshold) {
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

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions;
  }

  async applyMerge(suggestion: MergeSuggestion): Promise<MemoryEntry | null> {
    if (suggestion.entryIds.length < 2) return null;

    const sourceEntries = this.entries.filter(e =>
      suggestion.entryIds.includes(e.id),
    );
    if (sourceEntries.length < 2) return null;

    const mergedEntry: MemoryEntry = {
      id: `mem_merged_${Date.now()}`,
      text: suggestion.mergedText,
      timestamp: new Date().toISOString(),
      topics: [...new Set(sourceEntries.flatMap(e => e.topics))],
      scope: sourceEntries[0].scope,
      sourceType: 'merged',
      sourceSessionId: sourceEntries[0].sourceSessionId,
      accessCount: sourceEntries.reduce((sum, e) => sum + e.accessCount, 0),
      lastAccessedAt: new Date().toISOString(),
      compressed: false,
      compressedFrom: suggestion.entryIds,
    };

    for (const src of sourceEntries) {
      src.compressed = true;
      src.compressedFrom = [mergedEntry.id];
    }

    this.entries.push(mergedEntry);
    await this.persistIndex();

    const logPath = path.join(this.config.storageDir, 'merge-history.jsonl');
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

  async detectSplitCandidates(): Promise<SplitSuggestion[]> {
    const suggestions: SplitSuggestion[] = [];
    const MAX_TOKENS_PER_ENTRY = 2000;

    for (const entry of this.entries) {
      if (entry.compressed) continue;
      const tokens = this.tokenEstimator.estimate(entry.text);
      if (tokens > MAX_TOKENS_PER_ENTRY && entry.topics.length > 1) {
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
        sourceType: 'merged',
        sourceSessionId: sourceEntry.sourceSessionId,
        accessCount: sourceEntry.accessCount,
        lastAccessedAt: new Date().toISOString(),
        compressed: false,
        compressedFrom: [sourceEntry.id],
      };
      children.push(childEntry);
    }

    sourceEntry.compressed = true;
    sourceEntry.compressedFrom = children.map(c => c.id);

    this.entries.push(...children);
    await this.persistIndex();

    const logPath = path.join(this.config.storageDir, 'split-history.jsonl');
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

  async compressOldMemories(): Promise<MemoryCompressionResult[]> {
    const results: MemoryCompressionResult[] = [];
    const cutoff = Date.now() - this.config.compressAfterDays * 24 * 60 * 60 * 1000;

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
      if (group.length < 3) continue;

      const keywords = this.extractKeywords(group.map(e => e.text));
      const summary = this.generateSummary(group.map(e => e.text));
      const originalIds = group.map(e => e.id);

      const compressed: MemoryCompressionResult = {
        originalEntryIds: originalIds,
        summary,
        preservedKeywords: keywords,
        compressedAt: new Date().toISOString(),
      };

      for (const entry of group) {
        entry.compressed = true;
      }

      const summaryEntry: MemoryEntry = {
        id: `mem_compressed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text: `[COMPRESSED] ${summary}`,
        timestamp: new Date().toISOString(),
        topics: [...new Set(group.flatMap(e => e.topics))],
        scope: group[0].scope,
        sourceType: 'merged',
        accessCount: group.reduce((s, e) => s + e.accessCount, 0),
        lastAccessedAt: new Date().toISOString(),
        compressed: true,
        compressedFrom: originalIds,
      };

      this.entries.push(summaryEntry);
      results.push(compressed);
    }

    if (results.length > 0) {
      await this.persistIndex();
      console.log(`[AutoMemory] Compressed ${results.length} memory group(s)`);
    }

    return results;
  }

  async cleanExpiredMemories(): Promise<number> {
    const cutoff = Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      if (!e.compressed) return true;
      return new Date(e.timestamp).getTime() >= cutoff;
    });
    const after = this.entries.length;
    const removed = before - after;
    if (removed > 0) {
      await this.persistIndex();
      console.log(`[AutoMemory] Cleaned ${removed} expired entries`);
    }
    return removed;
  }

  // ── 生命周期管理 ─────────────────────────────────────

  /**
   * 执行完整的记忆维护周期。
   * 1. 重新扫描源文件，增量合并新条目
   * 2. 对 global.md 执行原地去重
   * 3. 检测并合并相似条目
   * 4. 压缩老旧记忆
   * 5. 清理过期条目
   */
  async runMaintenanceCycle(): Promise<{
    merges: number;
    splits: number;
    compressions: number;
    cleanups: number;
    globalMdDeduped: number;
    newEntries: number;
  }> {
    // 1. 重新扫描源文件，合并增量
    const freshEntries = await this.scanAllSources();
    let newEntries = 0;
    const existingTexts = new Set(this.entries.map(e => e.text));
    for (const entry of freshEntries) {
      if (!existingTexts.has(entry.text)) {
        this.entries.push(entry);
        newEntries++;
      }
    }
    if (newEntries > 0) {
      console.log(`[AutoMemory] ${newEntries} new entries from source rescan`);
    }

    // 2. 原地去重 global.md
    let globalMdDeduped = 0;
    try {
      const dedupResult = await this.deduplicateGlobalMd();
      globalMdDeduped = dedupResult.removed;
    } catch (e) {
      console.warn('[AutoMemory] global.md dedup failed:', e);
    }

    // 3. 合并检测
    const mergeSuggestions = await this.detectMergeCandidates();
    let merges = 0;
    if (this.config.autoMerge) {
      for (const s of mergeSuggestions.slice(0, 5)) {
        const result = await this.applyMerge(s);
        if (result) merges++;
      }
    }

    // 4. 分割检测
    const splitSuggestions = await this.detectSplitCandidates();
    let splits = 0;
    if (this.config.autoSplit) {
      for (const s of splitSuggestions.slice(0, 3)) {
        const result = await this.applySplit(s);
        if (result.length > 0) splits++;
      }
    }

    // 5. 压缩 + 清理
    const compressions = (await this.compressOldMemories()).length;
    const cleanups = await this.cleanExpiredMemories();
    await this.persistIndex();

    return { merges, splits, compressions, cleanups, globalMdDeduped, newEntries };
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

  private computeSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
    const union = new Set([...tokensA, ...tokensB]);
    const jaccard = intersection.size / union.size;
    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

    return jaccard * 0.7 + lenRatio * 0.3;
  }

  private tokenize(text: string): Set<string> {
    const tokens = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) {
      const char = text[i];
      if (/[\u4e00-\u9fff]/.test(char)) {
        tokens.add(text.substring(i, i + 2));
      }
    }
    const words = text.match(/[a-zA-Z_]\w{2,}/g) || [];
    for (const w of words) tokens.add(w.toLowerCase());
    return tokens;
  }

  private mergeTexts(a: string, b: string): string {
    if (a.includes(b) || b.includes(a)) {
      return a.length >= b.length ? a : b;
    }
    return `${a}\n${b}`;
  }

  private wasRecentlyMerged(idA: string, idB: string): boolean {
    const entryA = this.entries.find(e => e.id === idA);
    const entryB = this.entries.find(e => e.id === idB);
    if (!entryA || !entryB) return false;
    return entryA.compressedFrom?.includes(idB) ||
      entryB.compressedFrom?.includes(idA) ||
      false;
  }

  private splitByTopics(
    text: string,
    topics: string[],
  ): Array<{ text: string; topic: string }> {
    if (topics.length === 0) return [{ text, topic: 'general' }];
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length <= 1) return [{ text, topic: topics[0] }];

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

  private generateSummary(texts: string[]): string {
    if (texts.length === 0) return '';
    const first = texts[0].substring(0, 100);
    const keywords = this.extractKeywords(texts);
    const kwStr = keywords.slice(0, 5).join(', ');
    return `${first}… [关键词: ${kwStr}, 共 ${texts.length} 条]`;
  }

  /**
   * 从文本推断主题标签。
   */
  private inferTopicsFromText(text: string): string[] {
    const topics: string[] = [];
    const hints: Array<[RegExp, string]> = [
      [/代码|编程|函数|bug|debug|error|ts|js|py|rust/i, 'coding'],
      [/项目|架构|设计|重构|monorepo/i, 'architecture'],
      [/飞书|日历|文档|会议|feishu|lark/i, 'feishu'],
      [/部署|上线|发布|ci|cd|docker/i, 'devops'],
      [/需求|PRD|产品|功能/i, 'product'],
      [/数据|分析|报表|统计/i, 'analytics'],
      [/学习|教程|文档|知识/i, 'learning'],
      [/Otto|桌面|Electron|desktop/i, 'otto'],
      [/VS Code|vscode|插件|扩展/i, 'vscode'],
      [/记忆|memory|存储|持久化/i, 'memory'],
    ];
    for (const [pattern, topic] of hints) {
      if (pattern.test(text) && !topics.includes(topic)) {
        topics.push(topic);
      }
    }
    return topics.length > 0 ? topics : ['general'];
  }

  /**
   * 简单文本哈希（用于生成稳定 id）。
   */
  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      hash = ((hash << 5) - hash + c) | 0;
    }
    return Math.abs(hash).toString(36);
  }

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
