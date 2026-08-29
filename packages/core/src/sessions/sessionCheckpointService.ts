/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * SessionCheckpointService — 会话检查点与恢复服务。
 *
 * 能力：
 *   1. 会话状态快照：在关键时刻自动保存会话上下文
 *   2. 恢复：从最近的检查点恢复会话
 *   3. 跨进程持久化：检查点落盘，进程重启后可恢复
 *   4. 自动清理：过期检查点自动回收
 *
 * 存储路径：~/.otto-user/checkpoints/
 *   格式：{sessionId}.cp.json — 单个会话的最新检查点
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCheckpoint {
  sessionId: string;
  /** 检查点时间戳 ISO */
  timestamp: string;
  /** 会话标题 */
  title: string;
  /** 会话话题标签 */
  topics: string[];
  /** 任务摘要：最后一段有意义的用户任务 */
  lastTaskSummary: string;
  /** 对话轮次 */
  turnCount: number;
  /** 上下文摘要（压缩前生成） */
  contextSummary: string;
  /** 是否处于压缩状态 */
  wasCompressed: boolean;
  /** 最后活跃时间 */
  lastActiveAt: string;
  /** 项目路径 */
  projectRoot?: string;
  /** 飞书 chatId */
  feishuChatId?: string;
  /** 渠道 */
  channel: string;
}

export interface CheckpointStatus {
  /** 检查点总数 */
  totalCheckpoints: number;
  /** 最近检查点 */
  latest: SessionCheckpoint | null;
  /** 是否存在未完成任务 */
  hasPendingTask: boolean;
  /** 未完成任务摘要 */
  pendingTaskSummary: string | null;
}

export interface ResumeResult {
  /** 是否成功恢复 */
  resumed: boolean;
  /** 检查点 */
  checkpoint: SessionCheckpoint | null;
  /** 恢复摘要 */
  summary: string;
}

// ---------------------------------------------------------------------------
// SessionCheckpointService
// ---------------------------------------------------------------------------

export class SessionCheckpointService {
  private readonly checkpointsDir: string;
  constructor(baseDir?: string) {
    const dir = baseDir || process.env.OTTO_USER_DIR || path.join(homedir(), '.otto-user');
    this.checkpointsDir = path.join(dir, 'checkpoints');
  }

  // ── 1. save ──────────────────────────────────────────────────────────

  /**
   * 保存会话检查点。
   * 将当前会话的关键状态快照落盘。
   */
  async save(checkpoint: Omit<SessionCheckpoint, 'timestamp'>): Promise<SessionCheckpoint> {
    const full: SessionCheckpoint = {
      ...checkpoint,
      timestamp: new Date().toISOString(),
    };

    await fs.mkdir(this.checkpointsDir, { recursive: true });
    const filePath = path.join(this.checkpointsDir, `${checkpoint.sessionId}.cp.json`);
    await fs.writeFile(filePath, JSON.stringify(full, null, 2), 'utf-8');

    return full;
  }

  // ── 2. load ──────────────────────────────────────────────────────────

  /**
   * 加载指定会话的检查点。
   * 不存在返回 null。
   */
  async load(sessionId: string): Promise<SessionCheckpoint | null> {
    try {
      const filePath = path.join(this.checkpointsDir, `${sessionId}.cp.json`);
      const raw = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as SessionCheckpoint;
    } catch {
      return null;
    }
  }

  // ── 3. list all ──────────────────────────────────────────────────────

  /**
   * 列出所有检查点，按时间倒序。
   */
  async listAll(): Promise<SessionCheckpoint[]> {
    try {
      const files = await fs.readdir(this.checkpointsDir);
      const checkpoints: SessionCheckpoint[] = [];

      for (const file of files) {
        if (!file.endsWith('.cp.json')) continue;
        try {
          const raw = await fs.readFile(
            path.join(this.checkpointsDir, file),
            'utf-8',
          );
          const cp = JSON.parse(raw) as SessionCheckpoint;
          if (cp.sessionId && cp.timestamp) {
            checkpoints.push(cp);
          }
        } catch {
          // 坏文件跳过
        }
      }

      return checkpoints.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
    } catch {
      return [];
    }
  }

  // ── 4. status ────────────────────────────────────────────────────────

  /**
   * 获取检查点总览状态。
   */
  async status(): Promise<CheckpointStatus> {
    const all = await this.listAll();

    return {
      totalCheckpoints: all.length,
      latest: all.length > 0 ? all[0] : null,
      hasPendingTask: all.length > 0 && this.isStalled(all[0]),
      pendingTaskSummary: all.length > 0
        ? this.getPendingTaskSummary(all[0])
        : null,
    };
  }

  /**
   * 格式化状态为人类可读文本。
   */
  async formatStatus(): Promise<string> {
    const s = await this.status();
    const lines: string[] = [];
    lines.push('💾 Checkpoint Status');
    lines.push(`  Total checkpoints: ${s.totalCheckpoints}`);

    if (s.latest) {
      lines.push(`  Latest: ${s.latest.timestamp}`);
      lines.push(`    Session: ${s.latest.title || s.latest.sessionId.slice(0, 8)}`);
      lines.push(`    Last task: ${s.latest.lastTaskSummary || '(none)'}`);
      lines.push(`    Turns: ${s.latest.turnCount}`);
    }

    if (s.hasPendingTask) {
      lines.push(`  ⚠️  Pending task detected: ${s.pendingTaskSummary}`);
    } else {
      lines.push('  ✅ No pending tasks');
    }

    return lines.join('\n');
  }

  // ── 5. delete ────────────────────────────────────────────────────────

  /**
   * 删除指定会话的检查点。
   */
  async delete(sessionId: string): Promise<boolean> {
    try {
      const filePath = path.join(this.checkpointsDir, `${sessionId}.cp.json`);
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ── 6. clean expired ─────────────────────────────────────────────────

  /**
   * 清除超过 maxAgeDays 天的旧检查点。
   */
  async cleanExpired(maxAgeDays: number = 30): Promise<number> {
    const all = await this.listAll();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const cp of all) {
      if (new Date(cp.timestamp).getTime() < cutoff) {
        await this.delete(cp.sessionId);
        cleaned++;
      }
    }

    return cleaned;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * 判断检查点是否表示会话被"卡住"
   * 规则：最后活跃时间 > 30 分钟前、turnCount > 0
   */
  private isStalled(cp: SessionCheckpoint): boolean {
    const lastActive = new Date(cp.lastActiveAt).getTime();
    const minutesSinceActive = (Date.now() - lastActive) / 60000;
    return cp.turnCount > 0 && minutesSinceActive > 30;
  }

  /**
   * 获取未完成任务摘要。
   */
  private getPendingTaskSummary(cp: SessionCheckpoint): string | null {
    if (cp.lastTaskSummary && cp.lastTaskSummary.length > 0) {
      return cp.lastTaskSummary;
    }
    if (cp.contextSummary && cp.contextSummary.length > 0) {
      const firstLine = cp.contextSummary.split('\n')[0];
      return firstLine.slice(0, 200);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

let globalCheckpointService: SessionCheckpointService | null = null;

export function getCheckpointService(): SessionCheckpointService {
  if (!globalCheckpointService) {
    globalCheckpointService = new SessionCheckpointService();
  }
  return globalCheckpointService;
}

export function resetCheckpointService(): void {
  globalCheckpointService = null;
}
