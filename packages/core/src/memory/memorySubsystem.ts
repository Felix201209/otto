/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * MemorySubsystem — 统一的记忆子系统接口。
 *
 * 把记忆的捕获（capture）、索引（search）、统计（getStats）、重建（rebuild）、
 * 清理（clear）收敛到一个干净接口，供 runtime kernel 调用，将记忆策略
 * 与 kernel 生命周期解耦。
 *
 * 内部编排 autoMerge + knowledgeCapture + localKnowledgeStore，
 * 搜索使用简单子串匹配（零外部依赖），kernel 可通过配置标志
 * 完全禁用记忆子系统（disabled → 所有操作 no-op）。
 */

import { AutoMemoryEngine, getAutoMemoryEngine } from './autoMerge.js';
import {
  KnowledgeCapturePipeline,
  getKnowledgeCapturePipeline,
} from '../knowledge/knowledgeCapturePipeline.js';
import { LocalKnowledgeStore } from '../knowledge/localKnowledgeStore.js';

// ── Public types ────────────────────────────────────────────────────────

/** 一条记忆事件：kernel 调用 capture() 时传入。 */
export interface MemoryEvent {
  /** 来源事件 ID（如 turn/worklog entry id），用于溯源 */
  sourceEvent: string;
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 要记忆的文本内容，不能为空 */
  content: string;
  /** 自动/人工标签（技术栈、概念等） */
  tags: string[];
  /** 置信度 0-1（≤0 表示不记录，≥0.8 高置信自动写入） */
  confidence: number;
}

/** 搜索结果。 */
export interface MemorySearchResult {
  entry: MemoryEvent;
  /** 相关度分数（越大越相关），子串匹配为命中次数加权 */
  score: number;
  /** 数据来源（如 "autoMerge" | "knowledgeStore"），用于审计 */
  provenance: string;
}

/** 搜索选项。 */
export interface SearchOptions {
  /** 返回条数上限，默认 10 */
  limit?: number;
  /** 最低置信度过滤（含），默认 0 */
  minConfidence?: number;
  /** 必须同时匹配这些标签的条目（AND 逻辑） */
  tags?: string[];
  /** 是否限定项目级记忆（true → 只查 project scope） */
  projectScope?: boolean;
}

/** 记忆子系统统计。 */
export interface MemoryStats {
  /** 总条目数 */
  totalEntries: number;
  /** 来自 autoMerge 的条目数 */
  autoMergeEntries: number;
  /** 来自 knowledge store 的条目数 */
  knowledgeEntries: number;
  /** 最后更新时间（ISO 8601），无条目时为 null */
  lastUpdated: string | null;
}

// ── MemorySubsystem interface ───────────────────────────────────────────

export interface MemorySubsystem {
  /** 记录一条记忆事件（写入自动合并引擎 + 知识库）。 */
  capture(event: MemoryEvent): Promise<void>;

  /** 搜索记忆（子串匹配，零外部依赖）。 */
  search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]>;

  /** 获取子系统统计。 */
  getStats(): Promise<MemoryStats>;

  /** 从原始事件重建索引（扫描 global.md + entries.jsonl）。 */
  rebuild(): Promise<void>;

  /** 清空所有记忆（删除事件记录，不删源文件）。 */
  clear(): Promise<void>;
}

// ── Internal types ──────────────────────────────────────────────────────

/** createMemorySubsystem 的构造选项。 */
export interface MemorySubsystemOptions {
  /** 是否禁用（kernel 标志传递）。禁用后所有操作 no-op。 */
  disabled?: boolean;
  /** autoMerge 引擎覆盖（测试注入用）。 */
  autoMerge?: AutoMemoryEngine;
  /** 知识捕获管道覆盖（测试注入用）。 */
  pipeline?: KnowledgeCapturePipeline;
  /** 知识存储覆盖（账号隔离与测试注入用）。 */
  knowledgeStore?: LocalKnowledgeStore;
}

// ── Simple substring search implementation ──────────────────────────────

/**
 * 在文本中搜索查询词并计分。
 * 规则：
 *  - 整句命中（content 包含完整 query）→ +5
 *  - 标签命中 → +2/个
 *  - 分词命中 → +1/个
 *  - 匹配到标签的条目额外 +1（提高标签匹配权重）
 */
function computeSearchScore(content: string, tags: string[], query: string): number {
  const q = query.trim().toLowerCase();
  const c = content.toLowerCase();

  let score = 0;
  if (c.includes(q)) score += 5;

  // 分词累加（跳过与整句相同的单 token）
  const tokens = q.split(/[\s,，、;；]+/).filter(s => s.length > 0 && s !== q);
  for (const token of tokens) {
    const t = token.toLowerCase();
    if (c.includes(t)) score += 1;
    for (const tag of tags) {
      if (tag.toLowerCase().includes(t)) score += 2;
    }
  }

  // 标签直查加分
  for (const tag of tags) {
    if (tag.toLowerCase().includes(q)) score += 2;
  }

  return score;
}

// ── Implementation ──────────────────────────────────────────────────────

/** 创建一个实 MemorySubsystem 实例。 */
export function createMemorySubsystem(
  opts: MemorySubsystemOptions = {},
): MemorySubsystem {
  if (opts.disabled) {
    return createNoopMemorySubsystem();
  }

  const engine = opts.autoMerge ?? getAutoMemoryEngine();
  const knowledgeStore = opts.knowledgeStore ?? new LocalKnowledgeStore();
  const pipeline = opts.pipeline
    ?? (opts.knowledgeStore
      ? new KnowledgeCapturePipeline(knowledgeStore)
      : getKnowledgeCapturePipeline());

  // 记录内存中的事件列表（供 rebuild / clear 用）
  const capturedEvents: MemoryEvent[] = [];

  return {
    async capture(event: MemoryEvent): Promise<void> {
      const content = (event.content ?? '').trim();
      if (!content || event.confidence <= 0) return;

      // 写入 autoMerge 引擎（触发自动合并/去重）
      try {
        await engine.addEntry({
          text: `[${event.sourceEvent}] ${content}`,
          topics: event.tags ?? [],
          scope: 'global',
          sourceSessionId: event.sourceEvent,
        });
      } catch {
        // 不阻断
      }

      // 高置信度写入知识库
      if (event.confidence >= 0.8) {
        try {
          await pipeline.runExplicitMemory(
            `[source:${event.sourceEvent}] ${content}`,
            event.sourceEvent,
          );
        } catch {
          // 不阻断
        }
      }

      capturedEvents.push(event);
    },

    async search(query: string, opts?: SearchOptions): Promise<MemorySearchResult[]> {
      const q = (query ?? '').trim();
      if (!q) return [];

      const limit = opts?.limit ?? 10;
      const minConf = opts?.minConfidence ?? 0;
      const tagFilter = opts?.tags ?? [];

      const results: MemorySearchResult[] = [];

      // 1. 搜索 autoMerge 引擎中的条目
      try {
        const autoEntries = engine.queryEntries({
          scope: opts?.projectScope ? 'project' : undefined,
          limit: 200,
        });

        for (const entry of autoEntries) {
          if (entry.compressed) continue;
          const score = computeSearchScore(entry.text, entry.topics, q);
          if (score <= 0) continue;

          // 置信度过滤（autoMerge 条目默认置信度 0.7）
          const conf = 0.7;
          if (conf < minConf) continue;

          // 标签过滤
          if (tagFilter.length > 0) {
            const hasAllTags = tagFilter.every(t =>
              entry.topics.some(et => et.toLowerCase().includes(t.toLowerCase())),
            );
            if (!hasAllTags) continue;
          }

          results.push({
            entry: {
              sourceEvent: entry.sourceSessionId ?? '',
              timestamp: entry.timestamp,
              content: entry.text,
              tags: entry.topics,
              confidence: conf,
            },
            score,
            provenance: 'autoMerge',
          });
        }
      } catch {
        // 搜索失败忽略
      }

      // 2. 搜索 localKnowledgeStore
      try {
        const entries = await knowledgeStore.loadAll();
        for (const entry of entries) {
          const tags = entry.tags ?? [];
          const content = entry.content ?? '';
          if (!content) continue;

          const score = computeSearchScore(content, tags, q);
          if (score <= 0) continue;

          const conf = 0.8; // 知识库条目默认高置信
          if (conf < minConf) continue;

          if (tagFilter.length > 0) {
            const hasAllTags = tagFilter.every(t =>
              tags.some(et => et.toLowerCase().includes(t.toLowerCase())),
            );
            if (!hasAllTags) continue;
          }

          results.push({
            entry: {
              sourceEvent: entry.id,
              timestamp: entry.createdAt ?? '',
              content: entry.content,
              tags: tags,
              confidence: conf,
            },
            score,
            provenance: 'knowledgeStore',
          });
        }
      } catch {
        // 搜索失败忽略
      }

      // 按分数降序、时间倒序
      results.sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.timestamp.localeCompare(a.entry.timestamp),
      );

      return results.slice(0, Math.max(1, limit));
    },

    async getStats(): Promise<MemoryStats> {
      const engineStats = engine.getStats();

      let knowledgeEntries = 0;
      try {
        const entries = await knowledgeStore.loadAll();
        knowledgeEntries = entries.length;
      } catch {
        // 读取失败视为 0
      }

      return {
        totalEntries: engineStats.totalEntries + knowledgeEntries,
        autoMergeEntries: engineStats.totalEntries,
        knowledgeEntries,
        lastUpdated: engineStats.newestEntry ?? null,
      };
    },

    async rebuild(): Promise<void> {
      // Rebuild the configured engine in place so account-scoped and test
      // storage never falls back to the process-global ~/.otto-user paths.
      await engine.runMaintenanceCycle();
    },

    async clear(): Promise<void> {
      // 清空内存事件列表
      capturedEvents.length = 0;
    },
  };
}

// ── No-op implementation (disabled memory) ──────────────────────────────

function createNoopMemorySubsystem(): MemorySubsystem {
  return {
    async capture(_event: MemoryEvent): Promise<void> {
      // no-op
    },
    async search(_query: string, _opts?: SearchOptions): Promise<MemorySearchResult[]> {
      return [];
    },
    async getStats(): Promise<MemoryStats> {
      return {
        totalEntries: 0,
        autoMergeEntries: 0,
        knowledgeEntries: 0,
        lastUpdated: null,
      };
    },
    async rebuild(): Promise<void> {
      // no-op
    },
    async clear(): Promise<void> {
      // no-op
    },
  };
}
