/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto Insertion Engine — 任务进行中连续插入需求引擎。
 *
 * 核心能力:
 *   1. 任务中断与恢复: 在长任务执行期间接收新需求，挂起当前任务
 *   2. 需求排队: 新需求入队，当前任务完成后自动执行
 *   3. 需求插入: 紧急需求立即插入，中断当前任务，完成后回退
 *   4. 优先级调度: 根据优先级决定插入策略
 *   5. 增量上下文: 新需求自动携带当前执行上下文
 *
 * 场景示例:
 *   Otto 正在生成一份 30 页 PPT（"生成销售报告 PPT"）
 *   用户插入: "等一下，先帮我查一下今天张三的日程"
 *   → Otto 挂起 PPT 任务 → 查日程 → 恢复 PPT → 继续生成
 *
 *   或:
 *   Otto 正在写代码
 *   用户插入: "加上刚才那个日志功能"
 *   → Otto 记住这个需求 → 当前代码完成后 → 自动切到日志功能
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

// ============================================================
// 类型定义
// ============================================================

/** 插入需求优先级 */
export type InsertionPriority = 'asap' | 'high' | 'normal' | 'low';

/** 插入策略 */
export type InsertionStrategy =
  | 'interrupt_and_resume'  // 中断当前任务，插入执行，完成后恢复
  | 'queue_when_done'       // 排队，当前任务完成后执行
  | 'parallel_fork'         // 分叉并行执行（如果已有 runSideQuestion 机制）
  | 'append_to_context';    // 追加到当前任务的上下文中一起完成

/** 当前任务上下文 */
export interface CurrentTaskContext {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 已完成的步骤 */
  completedSteps: string[];
  /** 当前正在执行的步骤 */
  currentStep: string;
  /** 剩余步骤 */
  remainingSteps: string[];
  /** 任务开始时间 */
  startedAt: string;
  /** 任务截止时间（如果有） */
  deadline?: string;
  /** 关联 session ID */
  sessionId?: string;
  /** 已积累的上下文/产出物 */
  accumulatedContext: string;
}

/** 插入的请求 */
export interface InsertionRequest {
  id: string;
  /** 原始用户输入 */
  originalInput: string;
  /** 经过 LLM 解析后的意图 */
  parsedIntent: string;
  /** 策略 */
  strategy: InsertionStrategy;
  /** 优先级 */
  priority: InsertionPriority;
  /** 创建时间 */
  createdAt: string;
  /** 任务上下文快照（插入时抓取） */
  contextSnapshot: string;
  /** 执行状态 */
  status: InsertionStatus;
  /** 执行结果 */
  result?: string;
  /** 关联 session ID */
  sessionId?: string;
  /** 当前任务 ID（被中断的那个） */
  interruptedTaskId?: string;
  /** 完成时间 */
  completedAt?: string;
  /** 是否用户确认后才执行 */
  needsConfirmation?: boolean;
}

/** 插入需求状态 */
export type InsertionStatus =
  | 'pending'       // 等待处理
  | 'interrupting'  // 正在中断当前任务
  | 'executing'     // 正在执行
  | 'completed'     // 已完成
  | 'failed'        // 执行失败
  | 'skipped';      // 被跳过/取消

/** 插入决策（由 LLM 判断返回） */
export interface InsertionDecision {
  /** 建议的策略 */
  suggestedStrategy: InsertionStrategy;
  /** 理由 */
  reason: string;
  /** 是否需要用户确认 */
  needsConfirmation: boolean;
  /** 对用户友好的解释 */
  explanation: string;
}

/** 插入事件回调 */
export interface InsertionEventHandlers {
  /** 任务即将被中断 */
  onTaskInterrupted?: (context: CurrentTaskContext, request: InsertionRequest) => void;
  /** 任务已恢复 */
  onTaskResumed?: (context: CurrentTaskContext) => void;
  /** 插入需求开始执行 */
  onInsertionStarted?: (request: InsertionRequest) => void;
  /** 插入需求执行完毕 */
  onInsertionCompleted?: (request: InsertionRequest) => void;
  /** 优雅中断检查：返回是否可以安全中断当前任务 */
  canInterrupt?: (context: CurrentTaskContext) => boolean;
  /** 中断前的保存回调：返回序列化的上下文 */
  onSaveSnapshot?: (context: CurrentTaskContext) => Promise<string>;
  /** 恢复时的加载回调 */
  onRestoreSnapshot?: (snapshot: string) => Promise<CurrentTaskContext>;
}

/** 插入引擎配置 */
export interface InsertionEngineConfig {
  /** 存储路径 */
  storageDir: string;
  /** 是否自动决定策略（false 则总是询问用户） */
  autoDecideStrategy: boolean;
  /** 最大排队数 */
  maxQueueSize: number;
  /** 完成插入后是否自动提示恢复主任务 */
  autoResume: boolean;
  /** 是否启用分叉执行 */
  forkEnabled: boolean;
  /** 默认插入策略 */
  defaultStrategy: InsertionStrategy;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: InsertionEngineConfig = {
  storageDir: path.join(homedir(), '.otto-user', 'insertions'),
  autoDecideStrategy: true,
  maxQueueSize: 20,
  autoResume: true,
  forkEnabled: true,
  defaultStrategy: 'queue_when_done',
};

/**
 * 插入判定规则（基于关键词启发式，LLM 可覆盖）。
 * 实际运行时由 LLM 的 tool call 返回精确策略。
 */
function heuristicStrategy(
  input: string,
  currentContext?: CurrentTaskContext,
): InsertionDecision {
  const lower = input.toLowerCase();

  // 紧急关键词 → 中断并恢复
  const urgentPatterns = [
    /等一下/i, /先查/i, /紧急/i, /urgent/i, /asap/i,
    /立刻/i, /马上/i, /停一下/i, /暂停/i,
  ];
  for (const p of urgentPatterns) {
    if (p.test(lower)) {
      return {
        suggestedStrategy: 'interrupt_and_resume',
        reason: `匹配紧急模式: ${p.source}`,
        needsConfirmation: false,
        explanation: '检测到紧急关键词，将以中断-恢复模式执行',
      };
    }
  }

  // 追加关键词 → 追加到上下文
  const appendPatterns = [
    /加上/i, /补充/i, /追加/i, /顺便/i, /再加/i, /and also/i,
    /也帮我/i, /一起/i,
  ];
  for (const p of appendPatterns) {
    if (p.test(lower)) {
      return {
        suggestedStrategy: 'append_to_context',
        reason: `匹配追加模式: ${p.source}`,
        needsConfirmation: false,
        explanation: '检测到补充关键词，将追加到当前任务上下文',
      };
    }
  }

  // 询问类 → 分叉（不影响主流程）
  const forkPatterns = [
    /问一下/i, /查一下/i, /看一下/i, /check/i, /what/i,
    /when/i, /where/i, /who/i, /how/i,
    /有没有/i, /是不是/i, /能否/i,
  ];
  for (const p of forkPatterns) {
    if (p.test(lower)) {
      return {
        suggestedStrategy: 'parallel_fork',
        reason: `匹配查询模式: ${p.source}`,
        needsConfirmation: false,
        explanation: '检测到查询关键词，将以分叉模式并行执行',
      };
    }
  }

  // 有长任务进行中 → 默认排队
  if (currentContext && currentContext.remainingSteps.length > 3) {
    return {
      suggestedStrategy: 'queue_when_done',
      reason: '当前有长任务进行中，默认排队',
      needsConfirmation: true,
      explanation: `当前正在执行 "${currentContext.description}"，还有 ${currentContext.remainingSteps.length} 步，新需求将排队等待`,
    };
  }

  return {
    suggestedStrategy: DEFAULT_CONFIG.defaultStrategy,
    reason: '默认策略',
    needsConfirmation: false,
    explanation: '新需求将排队在当前任务之后执行',
  };
}

// ============================================================
// 插入引擎
// ============================================================

export class InsertionEngine {
  private queue: InsertionRequest[] = [];
  private currentTask: CurrentTaskContext | null = null;
  private interruptedTask: CurrentTaskContext | null = null;
  private config: InsertionEngineConfig;
  private handlers: InsertionEventHandlers;
  private initialized = false;

  constructor(
    config?: Partial<InsertionEngineConfig>,
    handlers?: InsertionEventHandlers,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.handlers = handlers || {};
  }

  // ── 初始化 ─────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const queuePath = path.join(this.config.storageDir, 'queue.json');
      const raw = await fs.readFile(queuePath, 'utf-8');
      this.queue = JSON.parse(raw) as InsertionRequest[];
      // 恢复时把执行中的标记为 pending（上次可能异常退出）
      for (const req of this.queue) {
        if (req.status === 'executing' || req.status === 'interrupting') {
          req.status = 'pending';
        }
      }
      console.log(`[InsertionEngine] Restored ${this.queue.length} pending requests`);
    } catch {
      console.log('[InsertionEngine] No pending requests, starting fresh');
    }
    this.initialized = true;
  }

  // ── 持久化 ─────────────────────────────────────────────

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const queuePath = path.join(this.config.storageDir, 'queue.json');
      await fs.writeFile(
        queuePath,
        JSON.stringify(this.queue, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[InsertionEngine] Persist failed:', err);
    }
  }

  // ── 核心流程 ─────────────────────────────────────────

  /**
   * 判断输入是否为插入需求（而非普通对话）。
   *
   * 调用时机: 每次用户输入时，在进入主 turn 之前调用。
   * 如果是插入需求，返回决策；否则返回 null 走正常流程。
   */
  async detectInsertion(
    input: string,
    currentContext?: CurrentTaskContext,
  ): Promise<InsertionDecision | null> {
    if (!input || input.trim().length === 0) return null;

    // 如果当前没有任务在执行，就没有"插入"一说
    if (!currentContext && !this.currentTask) return null;

    // 使用实时上下文
    const ctx = currentContext || this.currentTask;
    if (!ctx) return null;

    // 短查询或明显的"顺便问一下"
    const isShortQuery = input.length < 50;
    if (!isShortQuery) {
      // 长输入可能是新的主任务，不是插入
      return null;
    }

    // 启发式判断
    const heuristic = heuristicStrategy(input, ctx);

    // 如果 LLM 辅助可用，这里应该调用 LLM 确认
    // 简单实现先用启发式

    return heuristic;
  }

  /**
   * 安排一个插入请求。
   * 根据策略执行不同的行动。
   *
   * @returns 给用户的友好回复。
   */
  async scheduleInsertion(
    input: string,
    decision: InsertionDecision,
    sessionId?: string,
  ): Promise<{
    message: string;
    request: InsertionRequest;
  }> {
    if (this.queue.length >= this.config.maxQueueSize) {
      return {
        message: `⚠️ 插入队列已满（上限 ${this.config.maxQueueSize}），请等待当前任务完成后再提交新需求。`,
        request: this._createRequest(input, decision, 'skipped', sessionId),
      };
    }

    const request = this._createRequest(input, decision, 'pending', sessionId);
    request.needsConfirmation = decision.needsConfirmation;

    switch (decision.suggestedStrategy) {
      case 'interrupt_and_resume':
        return this._handleInterrupt(input, request, decision);
      case 'queue_when_done':
        return this._handleQueue(input, request, decision);
      case 'parallel_fork':
        return this._handleFork(input, request, decision);
      case 'append_to_context':
        return this._handleAppend(input, request, decision);
      default:
        return this._handleQueue(input, request, decision);
    }
  }

  /**
   * 设置当前正在执行的任务上下文。
   * 每次任务开始时调用。
   */
  setCurrentTask(context: CurrentTaskContext): void {
    this.currentTask = context;
    console.log(
      `[InsertionEngine] Task started: "${context.description}" (${context.taskId})`,
    );
  }

  /**
   * 清除当前任务上下文。
   * 任务完成/失败时调用。
   */
  clearCurrentTask(taskId: string): void {
    if (this.currentTask?.taskId === taskId) {
      console.log(
        `[InsertionEngine] Task completed: "${this.currentTask.description}"`,
      );
      this.currentTask = null;
    }
  }

  /**
   * 获取当前任务上下文。
   */
  getCurrentTask(): CurrentTaskContext | null {
    return this.currentTask;
  }

  /**
   * 获取待处理的插入请求队列。
   */
  getPendingQueue(): InsertionRequest[] {
    return this.queue.filter(r => r.status === 'pending');
  }

  /**
   * 获取当前是否有被中断的任务。
   */
  hasInterruptedTask(): boolean {
    return this.interruptedTask !== null;
  }

  /**
   * 恢复被中断的任务。
   * 插入需求执行完毕后调用。
   */
  async resumeInterruptedTask(): Promise<CurrentTaskContext | null> {
    if (!this.interruptedTask) return null;

    const task = this.interruptedTask;
    this.currentTask = task;
    this.interruptedTask = null;

    this.handlers.onTaskResumed?.(task);

    console.log(`[InsertionEngine] Resumed task: "${task.description}"`);
    return task;
  }

  /**
   * 标记一个请求为已完成。
   */
  async completeRequest(requestId: string, result: string): Promise<void> {
    const req = this.queue.find(r => r.id === requestId);
    if (!req) return;
    req.status = 'completed';
    req.result = result;
    req.completedAt = new Date().toISOString();
    await this.persist();
    this.handlers.onInsertionCompleted?.(req);
  }

  /**
   * 检查并自动执行下一个待处理请求。
   * 当前任务完成后调用此方法。
   */
  async processNextQueued(): Promise<InsertionRequest | null> {
    const next = this.queue.find(
      r => r.status === 'pending' && r.strategy === 'queue_when_done',
    );
    if (!next) return null;

    next.status = 'executing';
    await this.persist();
    this.handlers.onInsertionStarted?.(next);
    return next;
  }

  // ── 内部策略实现 ─────────────────────────────────────

  /**
   * 中断-恢复模式。
   */
  private async _handleInterrupt(
    input: string,
    request: InsertionRequest,
    decision: InsertionDecision,
  ): Promise<{ message: string; request: InsertionRequest }> {
    if (!this.currentTask) {
      return this._handleQueue(input, request, decision);
    }

    // 检查是否可以安全中断
    if (this.handlers.canInterrupt && !this.handlers.canInterrupt(this.currentTask)) {
      return {
        message: `⚠️ 当前任务 "${this.currentTask.description}" 正处于不可中断阶段（如文件写入），请稍后再试。`,
        request: this._createRequest(input, decision, 'skipped'),
      };
    }

    // 保存中断快照
    request.contextSnapshot = this.currentTask.accumulatedContext;
    request.interruptedTaskId = this.currentTask.taskId;

    // 保存当前任务到中断槽
    this.interruptedTask = { ...this.currentTask };

    request.status = 'executing';
    this.queue.push(request);
    await this.persist();

    this.handlers.onTaskInterrupted?.(this.interruptedTask, request);
    this.handlers.onInsertionStarted?.(request);

    return {
      message: `⏸️ 已中断 "${this.interruptedTask.description}"\n→ 执行: ${input}\n...完成后自动恢复主任务`,
      request,
    };
  }

  /**
   * 排队模式。
   */
  private async _handleQueue(
    input: string,
    request: InsertionRequest,
    _decision: InsertionDecision,
  ): Promise<{ message: string; request: InsertionRequest }> {
    request.status = 'pending';
    this.queue.push(request);
    await this.persist();

    const queuePos = this.queue.filter(r => r.status === 'pending').length;
    return {
      message: `📋 已加入队列（位置 #${queuePos}）\n当前任务完成后将自动执行: ${input}`,
      request,
    };
  }

  /**
   * 分叉模式（并行执行，不中断主流程）。
   */
  private async _handleFork(
    input: string,
    request: InsertionRequest,
    _decision: InsertionDecision,
  ): Promise<{ message: string; request: InsertionRequest }> {
    if (!this.config.forkEnabled) {
      return this._handleQueue(input, request, _decision);
    }

    request.status = 'executing';
    this.queue.push(request);
    await this.persist();

    this.handlers.onInsertionStarted?.(request);

    return {
      message: `🔀 已分叉执行（不中断主任务）:\n${input}\n结果将在此显示，主任务继续执行中...`,
      request,
    };
  }

  /**
   * 追加模式。
   */
  private async _handleAppend(
    input: string,
    request: InsertionRequest,
    _decision: InsertionDecision,
  ): Promise<{ message: string; request: InsertionRequest }> {
    if (!this.currentTask) {
      return this._handleQueue(input, request, _decision);
    }

    // 将需求追加到当前任务的剩余步骤中
    this.currentTask.remainingSteps.push(input);
    this.currentTask.accumulatedContext += `\n[追加需求] ${input}`;

    request.status = 'completed'; // 不需要单独执行
    request.result = `已追加到 "${this.currentTask.description}"`;
    request.completedAt = new Date().toISOString();
    this.queue.push(request);
    await this.persist();

    return {
      message: `📌 已追加到当前任务 "${this.currentTask.description}" 中:\n${input}`,
      request,
    };
  }

  // ── 工具 ─────────────────────────────────────────────

  private _createRequest(
    input: string,
    decision: InsertionDecision,
    status: InsertionStatus,
    sessionId?: string,
  ): InsertionRequest {
    return {
      id: `ins_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      originalInput: input,
      parsedIntent: decision.reason,
      strategy: decision.suggestedStrategy,
      priority: 'normal',
      createdAt: new Date().toISOString(),
      contextSnapshot: this.currentTask?.accumulatedContext || '',
      status,
      sessionId,
      interruptedTaskId: this.currentTask?.taskId,
      needsConfirmation: decision.needsConfirmation,
    };
  }

  // ── 状态查询 ─────────────────────────────────────────

  getStats(): {
    totalQueued: number;
    pending: number;
    executing: number;
    completed: number;
    failed: number;
    hasCurrentTask: boolean;
    hasInterruptedTask: boolean;
  } {
    return {
      totalQueued: this.queue.length,
      pending: this.queue.filter(r => r.status === 'pending').length,
      executing: this.queue.filter(r => r.status === 'executing').length,
      completed: this.queue.filter(r => r.status === 'completed').length,
      failed: this.queue.filter(r => r.status === 'failed').length,
      hasCurrentTask: this.currentTask !== null,
      hasInterruptedTask: this.interruptedTask !== null,
    };
  }

  /**
   * 清除已完成的请求。
   */
  async cleanCompleted(): Promise<number> {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      r => r.status !== 'completed' && r.status !== 'skipped',
    );
    const removed = before - this.queue.length;
    if (removed > 0) await this.persist();
    return removed;
  }
}

// ============================================================
// 全局单例
// ============================================================

let globalInsertionEngine: InsertionEngine | null = null;

export function getInsertionEngine(
  config?: Partial<InsertionEngineConfig>,
  handlers?: InsertionEventHandlers,
): InsertionEngine {
  if (!globalInsertionEngine) {
    globalInsertionEngine = new InsertionEngine(config, handlers);
  }
  return globalInsertionEngine;
}
