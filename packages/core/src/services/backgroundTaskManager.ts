/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DelegateProgress, DelegatePlanEntry } from '../acp-client/acpAgentClient.js';

/** Default on-disk home for persisted delegate tasks: ~/.otto-user/delegate-tasks */
function defaultStorageDir(): string {
  return path.join(os.homedir(), '.otto-user', 'delegate-tasks');
}

/** Tail of `output` kept on disk so a restored task still shows recent activity. */
const PERSISTED_OUTPUT_TAIL = 8_192;

/**
 * 简单的 CRC32 实现，用于生成任务ID哈希
 */
function crc32(str: string): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 生成基于内容的短哈希 ID
 */
function generateTaskId(command: string, directory?: string): string {
  const timestamp = Date.now();
  const content = `${command}|${directory || ''}|${timestamp}`;
  const hash = crc32(content);
  // 返回 7 位十六进制哈希，类似 git 短哈希
  return hash.toString(16).padStart(8, '0').slice(0, 7);
}

export interface BackgroundTask {
  id: string;
  command: string;
  directory?: string;
  /** Discriminator: 'shell' for process-based tasks, 'claude-code' / 'codex' for ACP delegate tasks. */
  kind?: 'shell' | 'claude-code' | 'codex';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  pid?: number;
  startTime: number;
  endTime?: number;
  output: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  error?: string;
  /** For claude-code tasks: the agent's final answer text. */
  answer?: string;

  // ── Structured delegate-session state (ACP tasks only) ───────────────
  /** Native session id of the external agent — the resume handle. */
  sessionId?: string;
  /** Title of the tool call currently in flight. */
  currentTool?: string;
  /** Number of tool calls started so far. */
  toolCallCount?: number;
  /** Latest execution plan reported by the agent. */
  plan?: DelegatePlanEntry[];
  /** Context tokens used / window size, from the latest usage update. */
  tokenUsed?: number;
  tokenSize?: number;
  /** Epoch ms of the last activity of any kind. */
  lastActivityAt?: number;
  /** True when this record was recovered from disk after a daemon restart. */
  restoredFromDisk?: boolean;
}

export type BackgroundTaskEvent =
  | { type: 'task-started'; task: BackgroundTask }
  | { type: 'task-output'; taskId: string; output: string }
  | { type: 'task-stderr'; taskId: string; stderr: string }
  | { type: 'task-progress'; task: BackgroundTask }
  | { type: 'task-completed'; task: BackgroundTask }
  | { type: 'task-failed'; task: BackgroundTask }
  | { type: 'task-cancelled'; task: BackgroundTask };

/** Options for {@link BackgroundTaskManager}. */
export interface BackgroundTaskManagerOptions {
  /**
   * Directory for persisting ACP delegate tasks. Defaults to
   * `~/.otto-user/delegate-tasks`. Pass `null` to disable persistence
   * entirely (used by tests that don't want to touch the real home dir).
   */
  storageDir?: string | null;
}

export class BackgroundTaskManager extends EventEmitter {
  private tasks: Map<string, BackgroundTask> = new Map();
  /** Resolved persistence directory, or null when persistence is disabled. */
  private readonly storageDir: string | null;

  constructor(options: BackgroundTaskManagerOptions = {}) {
    super();
    this.storageDir =
      options.storageDir === null
        ? null
        : (options.storageDir ?? defaultStorageDir());
    this.loadFromDisk();
  }

  /** Whether a task should be persisted (ACP delegate sessions only). */
  private isPersistable(task: BackgroundTask): boolean {
    return task.kind === 'claude-code' || task.kind === 'codex';
  }

  /**
   * 创建一个新的后台任务
   */
  createTask(command: string, directory?: string, kind?: 'shell' | 'claude-code' | 'codex'): BackgroundTask {
    const id = generateTaskId(command, directory);
    const task: BackgroundTask = {
      id,
      command,
      directory,
      kind,
      status: 'running',
      startTime: Date.now(),
      output: '',
      stderr: '',
      toolCallCount: 0,
      lastActivityAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.emit('task-started', { type: 'task-started', task });
    return task;
  }

  /**
   * Merge a structured progress snapshot from the delegated ACP turn into the
   * task record, persist it, and notify subscribers. Drives the live Feishu
   * `/acp-session` dashboard card.
   */
  updateProgress(taskId: string, progress: DelegateProgress): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (progress.currentTool !== undefined) task.currentTool = progress.currentTool;
    task.toolCallCount = progress.toolCallCount;
    if (progress.plan !== undefined) task.plan = progress.plan;
    if (progress.tokenUsed !== undefined) task.tokenUsed = progress.tokenUsed;
    if (progress.tokenSize !== undefined) task.tokenSize = progress.tokenSize;
    task.lastActivityAt = progress.lastActivityAt;
    this.persist(task);
    this.emit('task-progress', { type: 'task-progress', task });
    return task;
  }

  /**
   * 获取任务信息
   */
  getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 获取所有任务
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 获取运行中的任务
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running');
  }

  /** Maximum size of task.output in characters. Older content is pruned. */
  static readonly OUTPUT_CAP = 200_000;

  /**
   * 更新任务输出
   */
  appendOutput(taskId: string, output: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.output += output;
      // Prune if exceeding cap — keep the tail (most recent output).
      if (task.output.length > BackgroundTaskManager.OUTPUT_CAP) {
        const pruneTo = Math.floor(BackgroundTaskManager.OUTPUT_CAP * 0.7);
        task.output = '…[earlier output pruned]…\n' + task.output.slice(task.output.length - pruneTo);
      }
      this.emit('task-output', { type: 'task-output', taskId, output });
    }
  }

  /**
   * 更新任务错误输出
   */
  appendStderr(taskId: string, stderr: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.stderr += stderr;
      this.emit('task-stderr', { type: 'task-stderr', taskId, stderr });
    }
  }

  /**
   * 标记任务为已完成
   */
  completeTask(
    taskId: string,
    options: { exitCode?: number; signal?: string; error?: string } = {},
  ): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'completed';
      task.endTime = Date.now();
      task.exitCode = options.exitCode;
      task.signal = options.signal;
      task.error = options.error;
      this.persist(task);
      this.emit('task-completed', { type: 'task-completed', task });
    }
    return task;
  }

  /**
   * 标记任务为失败
   */
  failTask(
    taskId: string,
    error: string,
  ): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      task.endTime = Date.now();
      task.error = error;
      this.persist(task);
      this.emit('task-failed', { type: 'task-failed', task });
    }
    return task;
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = 'cancelled';
      task.endTime = Date.now();
      this.persist(task);
      this.emit('task-cancelled', { type: 'task-cancelled', task });
    }
    return task;
  }

  /**
   * 强制终止任务进程
   */
  killTask(taskId: string): BackgroundTask | undefined {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running' && task.pid) {
      try {
        // 尝试终止进程
        if (process.platform === 'win32') {
          // Windows: 使用 taskkill
          spawn('taskkill', ['/pid', task.pid.toString(), '/f', '/t']);
        } else {
          // Unix: 发送 SIGTERM
          process.kill(task.pid, 'SIGTERM');
        }

        task.status = 'failed';
        task.endTime = Date.now();
        task.error = 'Killed by user';
        this.emit('task-killed', { type: 'task-killed', task });
      } catch (error) {
        console.error(`Failed to kill task ${taskId}:`, error);
      }
    }
    return task;
  }

  /**
   * 设置任务的 PID
   */
  setTaskPid(taskId: string, pid: number): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.pid = pid;
    }
  }

  /**
   * 清空已完成的任务
   */
  clearCompletedTasks(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
        this.removePersisted(id);
      }
    }
  }

  /**
   * 清空所有任务
   */
  clearAllTasks(): void {
    for (const id of this.tasks.keys()) this.removePersisted(id);
    this.tasks.clear();
  }

  /**
   * 监听任务事件
   */
  onTaskEvent(callback: (event: BackgroundTaskEvent) => void): () => void {
    const handler = (event: BackgroundTaskEvent) => callback(event);

    // 监听所有事件
    this.on('task-started', (evt) => handler(evt));
    this.on('task-output', (evt) => handler(evt));
    this.on('task-stderr', (evt) => handler(evt));
    this.on('task-progress', (evt) => handler(evt));
    this.on('task-completed', (evt) => handler(evt));
    this.on('task-failed', (evt) => handler(evt));
    this.on('task-cancelled', (evt) => handler(evt));

    // 返回取消监听函数
    return () => {
      this.removeAllListeners();
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────
  // ACP delegate tasks are persisted as one JSON file per task under
  // `storageDir`, so a daemon restart doesn't lose the user's sessions.
  // All disk I/O is best-effort: a failure must never break task tracking.

  private taskFile(id: string): string | null {
    return this.storageDir ? path.join(this.storageDir, `${id}.json`) : null;
  }

  /** Atomically write a task snapshot to disk (temp file + rename). */
  private persist(task: BackgroundTask): void {
    const file = this.taskFile(task.id);
    if (!file || !this.isPersistable(task)) return;
    try {
      fs.mkdirSync(this.storageDir!, { recursive: true });
      // Persist a bounded output tail — enough for a restored snapshot, not
      // the full (potentially huge) transcript.
      const snapshot: BackgroundTask = {
        ...task,
        output:
          task.output.length > PERSISTED_OUTPUT_TAIL
            ? '…[truncated]…\n' + task.output.slice(-PERSISTED_OUTPUT_TAIL)
            : task.output,
        stderr: '',
      };
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch {
      // best effort — never throw from persistence
    }
  }

  private removePersisted(id: string): void {
    const file = this.taskFile(id);
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  }

  /**
   * Load persisted delegate tasks on startup. Any task left `running` from a
   * previous process is normalized to `failed` with an interruption note,
   * since its child process did not survive the restart.
   */
  private loadFromDisk(): void {
    if (!this.storageDir) return;
    let files: string[];
    try {
      files = fs.readdirSync(this.storageDir).filter((f) => f.endsWith('.json'));
    } catch {
      return; // dir doesn't exist yet — nothing to load
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(this.storageDir, f), 'utf8');
        const task = JSON.parse(raw) as BackgroundTask;
        if (!task?.id) continue;
        if (task.status === 'running') {
          task.status = 'failed';
          task.error = task.error
            ? `${task.error}\n(中断：守护进程已重启)`
            : '中断：守护进程在该任务运行期间重启。';
          task.endTime = task.endTime ?? Date.now();
        }
        task.restoredFromDisk = true;
        this.tasks.set(task.id, task);
        // Re-write the normalized record so a second restart stays consistent.
        this.persist(task);
      } catch {
        // skip corrupt records
      }
    }
  }
}

// 全局单例实例
let globalTaskManager: BackgroundTaskManager | null = null;

export function getBackgroundTaskManager(): BackgroundTaskManager {
  if (!globalTaskManager) {
    // Persistence dir resolution for the process-wide singleton:
    //   - OTTO_DELEGATE_TASKS_DIR overrides the location (legacy:
    //     OTTO_DELEGATE_TASKS_DIR) (any deployment).
    //   - Under vitest, disable persistence so tests never touch the real home.
    //   - Otherwise default to ~/.otto-user/delegate-tasks.
    const override = (
      process.env.OTTO_DELEGATE_TASKS_DIR ??
      process.env.OTTO_DELEGATE_TASKS_DIR
    )?.trim();
    const storageDir = override
      ? override
      : process.env.VITEST
        ? null
        : undefined;
    globalTaskManager = new BackgroundTaskManager({ storageDir });
  }
  return globalTaskManager;
}

export function resetBackgroundTaskManager(): void {
  if (globalTaskManager) {
    globalTaskManager.clearAllTasks();
  }
  globalTaskManager = null;
}
