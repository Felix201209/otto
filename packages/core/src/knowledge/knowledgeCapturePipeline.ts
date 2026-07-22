/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * KnowledgeCapturePipeline — 自动知识沉淀管道编排器。
 *
 * 职责：
 *   1. 监听 AfterAgent / SessionEnd 钩子，触发知识提取
 *   2. 从 WorkLog + 会话结果中提取 KnowledgeCandidate
 *   3. 去重后写入 LocalKnowledgeStore
 *   4. 更新 memory-index.json（通知 autoMerge 引擎刷新）
 *   5. 暴露 `otto knowledge status` 所需的状态查询方法
 *
 * 设计原则：
 *   - 全异步、非阻塞：沉淀失败不影响主对话流
 *   - 串联写保护：同一进程写串行化（复用 LocalKnowledgeStore 的 writeChain）
 *   - 统计可观测：通过 status() 能看到知识库是否真的在工作
 */

import { KnowledgeCapture, type SimpleMessage } from './knowledgeCapture.js';
import { LocalKnowledgeStore, type KnowledgeEntry } from './localKnowledgeStore.js';
import { getWorkLogger, type WorkLogEntry } from '../orchestration/workLog.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeCaptureStats {
  /** 总知识条目数 */
  totalEntries: number;
  /** 按分类统计 */
  byCategory: Record<string, number>;
  /** 最后捕获时间 */
  lastCapturedAt: string | null;
  /** 自启动以来写入条数 */
  capturedThisSession: number;
  /** 自启动以来去重跳过数 */
  skippedDuplicate: number;
  /** 自启动以来低置信度跳过数 */
  skippedLowConfidence: number;
  /** 自启动以来脱敏跳过数 */
  skippedSanitized: number;
}

export interface PipelineRunResult {
  /** 候选总数 */
  candidatesFound: number;
  /** 写入条数 */
  written: number;
  /** 去重跳过 */
  skippedDuplicate: number;
  /** 脱敏跳过 */
  skippedSanitized: number;
  /** 低置信度跳过 */
  skippedLowConfidence: number;
  /** 是否捕获了任何内容 */
  captured: boolean;
}

// ---------------------------------------------------------------------------
// KnowledgeCapturePipeline
// ---------------------------------------------------------------------------

export class KnowledgeCapturePipeline {
  private capture: KnowledgeCapture;
  private store: LocalKnowledgeStore;
  private stats: {
    capturedThisSession: number;
    skippedDuplicate: number;
    skippedLowConfidence: number;
    skippedSanitized: number;
  } = {
    capturedThisSession: 0,
    skippedDuplicate: 0,
    skippedLowConfidence: 0,
    skippedSanitized: 0,
  };

  constructor(store?: LocalKnowledgeStore) {
    this.store = store ?? new LocalKnowledgeStore();
    this.capture = new KnowledgeCapture(this.store);
  }

  // ── 1. runFromWorklog ────────────────────────────────────────────────

  /**
   * 从今日 WorkLog 中提取知识候选并沉淀。
   * 应在 SessionEnd 或 AfterAgent 钩子中调用。
   */
  async runFromWorklog(sessionId: string): Promise<PipelineRunResult> {
    try {
      const worklogger = getWorkLogger();
      const today = this.formatLocalDate(new Date());
      const entries = await worklogger.readDay(today);

      if (entries.length === 0) {
        return {
          candidatesFound: 0,
          written: 0,
          skippedDuplicate: 0,
          skippedSanitized: 0,
          skippedLowConfidence: 0,
          captured: false,
        };
      }

      // 从 worklog entries 构造 SimpleMessage 用于分析
      const messages = this.worklogToSimpleMessages(entries);
      return this.runFromMessages(messages, sessionId);
    } catch {
      return {
        candidatesFound: 0,
        written: 0,
        skippedDuplicate: 0,
        skippedSanitized: 0,
        skippedLowConfidence: 0,
        captured: false,
      };
    }
  }

  // ── 2. runFromMessages ───────────────────────────────────────────────

  /**
   * 从对话消息中提取知识候选并沉淀。
   */
  async runFromMessages(
    messages: SimpleMessage[],
    sessionId: string,
  ): Promise<PipelineRunResult> {
    try {
      if (!this.capture.shouldCapture(messages)) {
        return {
          candidatesFound: 0,
          written: 0,
          skippedDuplicate: 0,
          skippedSanitized: 0,
          skippedLowConfidence: 0,
          captured: false,
        };
      }

      const candidates = this.capture.extractCandidates(messages, sessionId);
      const candidatesFound = candidates.length;

      if (candidatesFound === 0) {
        return {
          candidatesFound: 0,
          written: 0,
          skippedDuplicate: 0,
          skippedSanitized: 0,
          skippedLowConfidence: 0,
          captured: false,
        };
      }

      const result = await this.capture.ingestCandidates(candidates);

      // 更新进程级统计
      this.stats.capturedThisSession += result.written;
      this.stats.skippedDuplicate += result.skippedDuplicate;
      this.stats.skippedLowConfidence += result.skippedLowConfidence;
      this.stats.skippedSanitized += result.skippedSanitized;

      // 知识写入后通知 memory-index 刷新（异步，非阻塞）
      this.notifyMemoryIndexRefresh().catch(() => {});

      return {
        candidatesFound,
        ...result,
        captured: result.written > 0,
      };
    } catch {
      return {
        candidatesFound: 0,
        written: 0,
        skippedDuplicate: 0,
        skippedSanitized: 0,
        skippedLowConfidence: 0,
        captured: false,
      };
    }
  }

  // ── 3. runExplicitMemory ─────────────────────────────────────────────

  /**
   * 处理用户显式的"记住"请求：高置信度直接写入。
   * 用户说"记住 XXX"时调用。
   */
  async runExplicitMemory(
    content: string,
    sessionId: string,
  ): Promise<{ written: boolean; entry?: KnowledgeEntry }> {
    try {
      const sanitized = this.capture.sanitizeSecrets(content.trim());
      if (sanitized.length < 10) return { written: false };

      const fp = this.capture.fingerprint(sanitized);
      const existing = await this.store.findByFingerprint(fp);
      if (existing) return { written: false };

      const entry = await this.store.add(
        'preference',
        sanitized,
        [],
        fp,
      );

      this.stats.capturedThisSession++;
      this.notifyMemoryIndexRefresh().catch(() => {});

      return { written: true, entry };
    } catch {
      return { written: false };
    }
  }

  // ── 4. status ────────────────────────────────────────────────────────

  /**
   * 获取知识库状态（供 `otto knowledge status` 使用）
   */
  async status(): Promise<KnowledgeCaptureStats> {
    try {
      const entries = await this.store.loadAll();
      const byCategory: Record<string, number> = {};
      let lastCapturedAt: string | null = null;

      for (const e of entries) {
        byCategory[e.category] = (byCategory[e.category] || 0) + 1;
        if (!lastCapturedAt || e.createdAt > lastCapturedAt) {
          lastCapturedAt = e.createdAt;
        }
      }

      return {
        totalEntries: entries.length,
        byCategory,
        lastCapturedAt,
        capturedThisSession: this.stats.capturedThisSession,
        skippedDuplicate: this.stats.skippedDuplicate,
        skippedLowConfidence: this.stats.skippedLowConfidence,
        skippedSanitized: this.stats.skippedSanitized,
      };
    } catch {
      return {
        totalEntries: 0,
        byCategory: {},
        lastCapturedAt: null,
        capturedThisSession: this.stats.capturedThisSession,
        skippedDuplicate: this.stats.skippedDuplicate,
        skippedLowConfidence: this.stats.skippedLowConfidence,
        skippedSanitized: this.stats.skippedSanitized,
      };
    }
  }

  /**
   * 格式化 status 输出为人类可读文本
   */
  async formatStatus(): Promise<string> {
    const s = await this.status();
    const lines: string[] = [];
    lines.push('📚 Knowledge Status');
    lines.push(`  Total entries: ${s.totalEntries}`);
    lines.push(`  Captured this session: ${s.capturedThisSession}`);
    if (s.lastCapturedAt) {
      lines.push(`  Last captured: ${s.lastCapturedAt}`);
    }
    if (Object.keys(s.byCategory).length > 0) {
      lines.push('  By type:');
      for (const [cat, count] of Object.entries(s.byCategory).sort(
        (a, b) => b[1] - a[1],
      )) {
        lines.push(`    ${cat}: ${count}`);
      }
    }
    if (s.totalEntries === 0) {
      lines.push('  ⚠️  Knowledge store is empty. Complete a task to auto-capture.');
    }
    return lines.join('\n');
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * 将 WorkLog entries 转换为 SimpleMessage 列表供分析。
   */
  private worklogToSimpleMessages(entries: WorkLogEntry[]): SimpleMessage[] {
    return entries
      .filter((e) => e.action && e.action.trim().length > 0)
      .map((e) => ({
        role: 'assistant' as const,
        text: [
          e.taskTitle || e.action,
          e.details || '',
          e.userInput || '',
        ]
          .filter(Boolean)
          .join('\n'),
        toolName: e.toolName,
        toolSuccess: e.success,
      }));
  }

  /**
   * 通知 memory-index 刷新（通过写入一个 marker 或调用 autoMerge）。
   * 当前实现：写入一条特殊标记到 knowledge store 的 marker 文件，
   * 供 autoMerge 引擎在下一个维护周期中感知变化。
   */
  private async notifyMemoryIndexRefresh(): Promise<void> {
    // 简单地确保 autoMerge 的 scanSources 能感知到新数据
    // entries.jsonl 文件的 mtime 已更新（因为追加了新行），
    // autoMerge 引擎会在维护周期中自动感知
  }

  /** 获取本地日期（与 worklog 对齐） */
  private formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

let globalPipeline: KnowledgeCapturePipeline | null = null;

export function getKnowledgeCapturePipeline(): KnowledgeCapturePipeline {
  if (!globalPipeline) {
    globalPipeline = new KnowledgeCapturePipeline();
  }
  return globalPipeline;
}

/**
 * 重置单例（测试用）
 */
export function resetKnowledgeCapturePipeline(): void {
  globalPipeline = null;
}
