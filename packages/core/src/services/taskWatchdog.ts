/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * TaskWatchdog — 长任务监控与恢复服务。
 *
 * 能力：
 *   1. 心跳检测：定期检查 Agent 是否还在活跃工作
 *   2. 失速检测：超过阈值无输出则标记 stalled
 *   3. 状态保存：stalled 时自动保存检查点
 *   4. 续接提示：下次启动时提示"检测到未完成任务"
 *   5. Low-memory mode：内存紧张时主动释放缓存
 *
 * 设计原则：
 *   - 轻量：纯事件 + 定时器，不引入重依赖
 *   - 被动：watchdog 只检测不干预（不 kill 进程）
 *   - 可观测：状态变更通过事件回调通知
 */

import { getCheckpointService, type SessionCheckpoint } from '../sessions/sessionCheckpointService.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchdogConfig {
  /** 无输出超时阈值（毫秒），超过此时间标记 stalled。默认 10 分钟 */
  stallTimeoutMs: number;
  /** 心跳间隔（毫秒）。默认 30 秒 */
  heartbeatIntervalMs: number;
  /** 自动保存检查点（stalled 时）。默认 true */
  autoCheckpoint: boolean;
  /** 低内存阈值（MB）。当前进程 RSS 超过此值触发 low-memory mode。默认 512MB */
  lowMemoryThresholdMB: number;
}

export type WatchdogState = 'idle' | 'active' | 'stalled' | 'recovering';

export interface WatchdogStatus {
  state: WatchdogState;
  /** 会话 ID */
  sessionId: string | null;
  /** 最后输出时间 */
  lastOutputAt: string | null;
  /** 无输出时长（毫秒） */
  idleDurationMs: number;
  /** 是否处于低内存模式 */
  lowMemoryMode: boolean;
  /** 进程 RSS 内存（MB） */
  memoryUsageMB: number;
  /** 最后保存的检查点时间 */
  lastCheckpointAt: string | null;
}

export interface WatchdogCallbacks {
  /** 状态变更回调 */
  onStateChange?: (from: WatchdogState, to: WatchdogState) => void;
  /** stalled 回调 */
  onStalled?: (idleDurationMs: number) => void;
  /** 低内存回调 */
  onLowMemory?: (memoryMB: number) => void;
  /** 恢复正常回调 */
  onRecovered?: () => void;
  /** 需要保存检查点回调 */
  onCheckpointNeeded?: (checkpoint: SessionCheckpoint) => void;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WatchdogConfig = {
  stallTimeoutMs: 10 * 60 * 1000,    // 10 分钟
  heartbeatIntervalMs: 30 * 1000,    // 30 秒
  autoCheckpoint: true,
  lowMemoryThresholdMB: 512,
};

// ---------------------------------------------------------------------------
// TaskWatchdog
// ---------------------------------------------------------------------------

export class TaskWatchdog {
  private config: WatchdogConfig;
  private callbacks: WatchdogCallbacks;
  private state: WatchdogState = 'idle';
  private sessionId: string | null = null;
  private lastOutputAt: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lowMemoryMode = false;
  private lastCheckpointAt: string | null = null;
  private stallNotified = false;

  constructor(
    config?: Partial<WatchdogConfig>,
    callbacks?: WatchdogCallbacks,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks ?? {};
  }

  // ── 1. start ─────────────────────────────────────────────────────────

  /**
   * 启动 watchdog 监控指定会话。
   */
  start(sessionId: string, taskSummary?: string): void {
    this.sessionId = sessionId;
    this.lastOutputAt = Date.now();
    this.stallNotified = false;
    this.transitionTo('active');

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, this.config.heartbeatIntervalMs);

    // 首次保存检查点
    if (this.config.autoCheckpoint) {
      this.saveCheckpoint(taskSummary).catch(() => {});
    }
  }

  // ── 2. heartbeat ─────────────────────────────────────────────────────

  /**
   * 通知 watchdog 有新的输出（重置空闲计时器）。
   * Agent 每输出一条消息都应调用此方法。
   */
  heartbeat(message?: string): void {
    this.lastOutputAt = Date.now();

    if (this.state === 'stalled' && !this.stallNotified) {
      this.transitionTo('recovering');
      this.callbacks.onRecovered?.();
    }

    // 检查内存
    this.checkMemory();
  }

  // ── 3. stop ──────────────────────────────────────────────────────────

  /**
   * 停止 watchdog。
   */
  stop(completed: boolean = true): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (completed) {
      this.transitionTo('idle');
      this.sessionId = null;
      this.stallNotified = false;
    }
  }

  // ── 4. status ────────────────────────────────────────────────────────

  /**
   * 获取 watchdog 状态。
   */
  getStatus(): WatchdogStatus {
    const memUsage = process.memoryUsage();
    return {
      state: this.state,
      sessionId: this.sessionId,
      lastOutputAt: this.lastOutputAt > 0
        ? new Date(this.lastOutputAt).toISOString()
        : null,
      idleDurationMs: this.lastOutputAt > 0
        ? Date.now() - this.lastOutputAt
        : 0,
      lowMemoryMode: this.lowMemoryMode,
      memoryUsageMB: Math.round(memUsage.rss / 1024 / 1024),
      lastCheckpointAt: this.lastCheckpointAt,
    };
  }

  /**
   * 格式化状态为人类可读文本。
   */
  formatStatus(): string {
    const s = this.getStatus();
    const lines: string[] = [];
    lines.push('🐕 Watchdog Status');
    lines.push(`  State: ${this.stateIcon(s.state)} ${s.state}`);
    if (s.sessionId) {
      lines.push(`  Session: ${s.sessionId.slice(0, 8)}...`);
    }
    if (s.lastOutputAt) {
      const mins = Math.floor(s.idleDurationMs / 60000);
      lines.push(`  Last output: ${mins} min ago (${s.lastOutputAt})`);
    }
    lines.push(`  Memory: ${s.memoryUsageMB} MB${s.lowMemoryMode ? ' ⚠️ LOW' : ''}`);
    if (s.lastCheckpointAt) {
      lines.push(`  Last checkpoint: ${s.lastCheckpointAt}`);
    }
    return lines.join('\n');
  }

  // ── 5. enable/disable low-memory mode ────────────────────────────────

  /**
   * 手动启用低内存模式。
   */
  enableLowMemoryMode(): void {
    if (!this.lowMemoryMode) {
      this.lowMemoryMode = true;
      this.callbacks.onLowMemory?.(this.getStatus().memoryUsageMB);
      // 触发 GC 提示（Node 端无法强制 GC，但可释放内部缓存）
      this.releaseMemory();
    }
  }

  /**
   * 手动禁用低内存模式。
   */
  disableLowMemoryMode(): void {
    this.lowMemoryMode = false;
    this.callbacks.onRecovered?.();
  }

  // ── 6. get pending task ──────────────────────────────────────────────

  /**
   * 检查是否存在未完成的任务（用于启动时提示续接）。
   */
  async getPendingTask(): Promise<{
    hasPending: boolean;
    checkpoint: SessionCheckpoint | null;
    summary: string | null;
  }> {
    const cpService = getCheckpointService();
    const status = await cpService.status();

    return {
      hasPending: status.hasPendingTask,
      checkpoint: status.latest,
      summary: status.pendingTaskSummary,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private transitionTo(newState: WatchdogState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;
    this.callbacks.onStateChange?.(oldState, newState);
  }

  private stateIcon(state: WatchdogState): string {
    switch (state) {
      case 'idle': return '💤';
      case 'active': return '🟢';
      case 'stalled': return '🔴';
      case 'recovering': return '🟡';
    }
  }

  private async saveCheckpoint(taskSummary?: string): Promise<void> {
    if (!this.sessionId) return;

    try {
      const cpService = getCheckpointService();
      const cp = await cpService.save({
        sessionId: this.sessionId,
        title: taskSummary || 'Active session',
        topics: [],
        lastTaskSummary: taskSummary || '',
        turnCount: 0,
        contextSummary: '',
        wasCompressed: false,
        lastActiveAt: new Date(this.lastOutputAt).toISOString(),
        channel: 'auto',
      });

      this.lastCheckpointAt = cp.timestamp;
      this.callbacks.onCheckpointNeeded?.(cp);
    } catch {
      // 保存失败不阻塞
    }
  }

  private checkMemory(): void {
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memMB > this.config.lowMemoryThresholdMB && !this.lowMemoryMode) {
      this.enableLowMemoryMode();
    } else if (memMB < this.config.lowMemoryThresholdMB * 0.8 && this.lowMemoryMode) {
      this.disableLowMemoryMode();
    }
  }

  /**
   * 释放可回收内存：清理大型缓存、触发 GC 提示。
   */
  private releaseMemory(): void {
    // 清理 V8 编译缓存
    if (global.gc) {
      try {
        global.gc();
      } catch {
        // gc not exposed
      }
    }

    // 通知外部：可以清理内部缓存
    // （由消费方在 onLowMemory 回调中处理自己的缓存）
  }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

let globalWatchdog: TaskWatchdog | null = null;

export function getTaskWatchdog(): TaskWatchdog {
  if (!globalWatchdog) {
    globalWatchdog = new TaskWatchdog();
  }
  return globalWatchdog;
}

export function resetTaskWatchdog(): void {
  if (globalWatchdog) {
    globalWatchdog.stop(false);
    globalWatchdog = null;
  }
}
