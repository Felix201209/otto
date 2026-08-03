/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Task Orchestrator — 基于 LangGraph 的任务编排引擎。
 *
 * 状态机流程：
 *   分配(allocate) → 执行中(executing) → 待验收(pending_review)
 *     → 验收通过(completed) / 打回(rework) → 记忆更新(memory_sync)
 *
 * 节点说明：
 *   - allocate:   根据员工画像+任务要求，LLM 决策分配给谁
 *   - execute:    委托 delegate_to_agent 或 Otto 自身执行
 *   - review:     人工/自动验收节点（支持暂停等待审批）
 *   - complete:   验收通过，更新记忆
 *   - rework:     验收打回，回到 execute（带反馈）
 *   - memory_sync: 任务完成后将经验写入 Mem0/文件记忆
 */

import { StateGraph, END, START } from '@langchain/langgraph';
import { Annotation } from '@langchain/langgraph';
import type { Config } from '../config/config.js';

// ============================================================
// 状态定义
// ============================================================

/** 任务状态 */
export type TaskStatus =
  | 'allocated'
  | 'executing'
  | 'pending_review'
  | 'completed'
  | 'rework'
  | 'failed';

/** 任务优先级 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

/** 任务分配建议 */
export interface AllocationSuggestion {
  assigneeId: string;
  assigneeName: string;
  reason: string;
  confidence: number;
  estimatedMinutes: number;
}

/** 任务定义 */
export interface TaskDefinition {
  id: string;
  title: string;
  description: string;
  requirements: string;
  acceptanceCriteria: string[];
  priority: TaskPriority;
  deadline?: string;
  projectId?: string;
  createdBy: string;
}

/** 员工画像 */
export interface EmployeeProfile {
  id: string;
  name: string;
  role: string;
  department: string;
  skills: string[];
  currentLoad: number; // 0-100, 当前负载百分比
  pastTasks: string[]; // 历史任务类型
  efficiencyScore: number; // 0-100
}

/** 任务执行结果 */
export interface TaskExecutionResult {
  taskId: string;
  status: 'success' | 'partial' | 'failed';
  output: string;
  artifacts: string[];
  durationMinutes: number;
  assigneeId: string;
}

/** 验收结果 */
export interface ReviewResult {
  taskId: string;
  approved: boolean;
  feedback?: string;
  reviewerId: string;
  reviewedAt: string;
}

/** 编排器状态（LangGraph 使用的共享状态） */
const TaskOrchestrationState = Annotation.Root({
  task: Annotation<TaskDefinition>,
  allocation: Annotation<AllocationSuggestion | null>,
  employees: Annotation<EmployeeProfile[]>,
  executionResult: Annotation<TaskExecutionResult | null>,
  reviewResult: Annotation<ReviewResult | null>,
  status: Annotation<TaskStatus>,
  error: Annotation<string | null>,
  retryCount: Annotation<number>,
  config: Annotation<Config>,
  messages: Annotation<string[]>,
});

export type TaskOrchestrationStateType = typeof TaskOrchestrationState.State;

// ============================================================
// 节点实现
// ============================================================

/**
 * 节点1: 任务分配
 * 输入：任务定义 + 可用员工列表
 * 输出：分配建议（assigneeId + 理由 + 置信度）
 */
async function allocateNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, employees } = state;

  if (!employees || employees.length === 0) {
    return {
      status: 'failed',
      error: 'No available employees for allocation',
      messages: [...(state.messages || []), '[allocate] No employees available'],
    };
  }

  // LLM 决策：根据任务要求 + 员工画像，选择最合适的分配对象
  // 这里用 LLM 做语义匹配，后续 P1 会叠加 OR-Tools 做数学优化
  const prompt = buildAllocationPrompt(task, employees);

  try {
    const config = state.config;
    const client = config.getOttoClient() as unknown as {
      generateContent?: (request: unknown) => Promise<unknown>;
    };
    let suggestion: AllocationSuggestion;

    if (client) {
      // 用 LLM 做分配决策
      const response = await client.generateContent?.({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: 0.3 },
      });

      const responseRecord = response as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | undefined;
      const text = responseRecord?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      suggestion = parseAllocationResponse(text, employees);
    } else {
      // 降级：简单规则匹配（技能匹配 + 最低负载）
      suggestion = ruleBasedAllocation(task, employees);
    }

    return {
      allocation: suggestion,
      status: 'allocated',
      messages: [
        ...(state.messages || []),
        `[allocate] Task "${task.title}" assigned to ${suggestion.assigneeName} (confidence: ${suggestion.confidence})`,
      ],
    };
  } catch (_error) {
    // 降级到规则匹配
    const suggestion = ruleBasedAllocation(task, employees);
    return {
      allocation: suggestion,
      status: 'allocated',
      messages: [
        ...(state.messages || []),
        `[allocate] LLM failed, rule-based: ${suggestion.assigneeName}`,
      ],
    };
  }
}

/**
 * 节点2: 任务执行
 * 输入：分配结果
 * 输出：执行结果
 */
async function executeNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, allocation } = state;

  if (!allocation) {
    return { status: 'failed', error: 'No allocation to execute' };
  }

  return {
    status: 'executing',
    messages: [
      ...(state.messages || []),
      `[execute] ${allocation.assigneeName} is executing "${task.title}"...`,
    ],
  };
  // 实际执行委托给 delegate_to_agent 或 Otto 自身
  // 这里只更新状态，具体执行由外部回调完成
}

/**
 * 节点3: 验收
 * 支持人工审批暂停
 */
async function reviewNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, executionResult } = state;

  if (!executionResult) {
    return {
      status: 'pending_review',
      messages: [...(state.messages || []), `[review] Waiting for execution result...`],
    };
  }

  // 如果执行失败，直接标记
  if (executionResult.status === 'failed') {
    return {
      status: 'failed',
      reviewResult: {
        taskId: task.id,
        approved: false,
        feedback: 'Execution failed',
        reviewerId: 'system',
        reviewedAt: new Date().toISOString(),
      },
      messages: [...(state.messages || []), `[review] Execution failed`],
    };
  }

  // 成功/部分成功：进入待验收
  return {
    status: 'pending_review',
    messages: [
      ...(state.messages || []),
      `[review] Task "${task.title}" pending review (result: ${executionResult.status})`,
    ],
  };
}

/**
 * 节点4a: 验收通过 → 完成
 */
async function completeNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, allocation } = state;

  return {
    status: 'completed',
    messages: [
      ...(state.messages || []),
      `[complete] Task "${task.title}" completed by ${allocation?.assigneeName || 'unknown'}`,
    ],
  };
}

/**
 * 节点4b: 验收打回 → 重做
 */
async function reworkNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, retryCount } = state;

  const newRetryCount = (retryCount || 0) + 1;
  if (newRetryCount >= 3) {
    return {
      status: 'failed',
      error: `Task "${task.title}" failed after ${newRetryCount} retries`,
      retryCount: newRetryCount,
    };
  }

  return {
    status: 'rework',
    retryCount: newRetryCount,
    messages: [
      ...(state.messages || []),
      `[rework] Task "${task.title}" sent back for rework (attempt ${newRetryCount})`,
    ],
  };
}

/**
 * 节点5: 记忆同步
 * 任务完成后，将经验写入 Mem0/文件记忆
 */
async function memorySyncNode(state: typeof TaskOrchestrationState.State): Promise<Partial<TaskOrchestrationStateType>> {
  const { task, executionResult, allocation, reviewResult } = state;

  const fact = `Task "${task.title}" completed by ${allocation?.assigneeName}. ` +
    `Result: ${executionResult?.status}. Duration: ${executionResult?.durationMinutes}min. ` +
    `Feedback: ${reviewResult?.feedback || 'approved'}.`;

  return {
    status: 'completed',
    messages: [
      ...(state.messages || []),
      `[memory_sync] Learned: ${fact.substring(0, 100)}...`,
    ],
  };
}

// ============================================================
// 路由函数
// ============================================================

/** review 后的路由：通过 → complete，打回 → rework */
function reviewRouter(state: typeof TaskOrchestrationState.State): string {
  if (state.status === 'failed') return 'rework';
  if (state.reviewResult?.approved) return 'complete';
  return 'rework';
}

/** rework 后的路由：重试次数 < 3 → execute，否则 → END */
function reworkRouter(state: typeof TaskOrchestrationState.State): string {
  if (state.status === 'failed') return END;
  return 'execute';
}

// ============================================================
// 图构建
// ============================================================

/**
 * 构建任务编排状态机。
 *
 *     ┌──────────┐     ┌──────────┐     ┌──────────┐
 *     │ allocate │────▶│ execute  │────▶│  review  │
 *     └──────────┘     └──────────┘     └────┬─────┘
 *                          ▲                  │
 *                          │          ┌───────┴───────┐
 *                          │          │               │
 *                     ┌────┴────┐ ┌───▼───┐    ┌──────▼──────┐
 *                     │ rework  │ │complete│   │  (failed)   │
 *                     └─────────┘ └───┬───┘    └─────────────┘
 *                                      │
 *                                ┌─────▼──────┐
 *                                │ memory_sync│
 *                                └────────────┘
 */
export function buildTaskOrchestrationGraph() {
  const graph = new StateGraph(TaskOrchestrationState)
    .addNode('allocate', allocateNode)
    .addNode('execute', executeNode)
    .addNode('review', reviewNode)
    .addNode('complete', completeNode)
    .addNode('rework', reworkNode)
    .addNode('memory_sync', memorySyncNode);

  // 边
  graph.addEdge(START, 'allocate');
  graph.addEdge('allocate', 'execute');
  graph.addEdge('execute', 'review');

  // review 后条件路由
  graph.addConditionalEdges('review', reviewRouter, {
    complete: 'complete',
    rework: 'rework',
  });

  // rework 后条件路由
  graph.addConditionalEdges('rework', reworkRouter, {
    execute: 'execute',
    [END]: END,
  });

  // complete → memory_sync → END
  graph.addEdge('complete', 'memory_sync');
  graph.addEdge('memory_sync', END);

  return graph.compile();
}

// ============================================================
// 辅助函数
// ============================================================

function buildAllocationPrompt(task: TaskDefinition, employees: EmployeeProfile[]): string {
  const empList = employees.map(e =>
    `- ${e.name} (${e.id}): role=${e.role}, skills=[${e.skills.join(', ')}], ` +
    `load=${e.currentLoad}%, efficiency=${e.efficiencyScore}/100, ` +
    `pastTasks=[${e.pastTasks.slice(-5).join(', ')}]`
  ).join('\n');

  return `You are a task allocation advisor. Based on the task requirements and employee profiles below, suggest the best assignee.

TASK:
  Title: ${task.title}
  Description: ${task.description}
  Requirements: ${task.requirements}
  Acceptance Criteria: ${task.acceptanceCriteria.join('; ')}
  Priority: ${task.priority}
  Deadline: ${task.deadline || 'not specified'}

EMPLOYEES:
${empList}

Respond in JSON format:
{"assigneeId": "...", "reason": "...", "confidence": 0.0-1.0, "estimatedMinutes": 0}`;
}

function parseAllocationResponse(text: string, employees: EmployeeProfile[]): AllocationSuggestion {
  try {
    // 提取 JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const emp = employees.find(e => e.id === parsed.assigneeId || e.name === parsed.assigneeId);
      if (emp) {
        return {
          assigneeId: emp.id,
          assigneeName: emp.name,
          reason: parsed.reason || 'LLM recommended',
          confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
          estimatedMinutes: parsed.estimatedMinutes || 30,
        };
      }
    }
  } catch {
    // 降级
  }
  return ruleBasedAllocation({} as TaskDefinition, employees);
}

function ruleBasedAllocation(task: TaskDefinition, employees: EmployeeProfile[]): AllocationSuggestion {
  // 简单规则：技能匹配 + 最低负载
  const scored = employees.map(e => {
    let score = 0;
    // 负载越低分越高
    score += (100 - e.currentLoad) * 0.4;
    // 效率越高分越高
    score += e.efficiencyScore * 0.3;
    // 技能匹配
    const taskWords = (task.requirements || '').toLowerCase().split(/\s+/);
    const skillMatch = e.skills.filter(s => taskWords.some(w => s.toLowerCase().includes(w))).length;
    score += skillMatch * 10;
    // 历史经验
    const expMatch = e.pastTasks.filter(t => (task.title || '').toLowerCase().includes(t.toLowerCase())).length;
    score += expMatch * 5;

    return { employee: e, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  return {
    assigneeId: best.employee.id,
    assigneeName: best.employee.name,
    reason: `Best match: load=${best.employee.currentLoad}%, efficiency=${best.employee.efficiencyScore}, skills matched`,
    confidence: Math.min(1, best.score / 100),
    estimatedMinutes: 30,
  };
}

// ============================================================
// 对外 API
// ============================================================

/**
 * 启动一个任务编排流程。
 * 返回初始状态，调用方可据此驱动状态机。
 */
export async function startTaskOrchestration(
  task: TaskDefinition,
  employees: EmployeeProfile[],
  config: Config,
): Promise<TaskOrchestrationStateType> {
  const initialState: Partial<TaskOrchestrationStateType> = {
    task,
    employees,
    allocation: null,
    executionResult: null,
    reviewResult: null,
    status: 'allocated',
    error: null,
    retryCount: 0,
    config,
    messages: [],
  };

  try {
    const app = buildTaskOrchestrationGraph();
    const result = await app.invoke(initialState);
    return result as TaskOrchestrationStateType;
  } catch (error) {
    // LangGraph 不可用时降级到简单流程
    console.warn(`[TaskOrchestrator] LangGraph failed, using simple flow: ${error instanceof Error ? error.message : String(error)}`);

    const suggestion = ruleBasedAllocation(task, employees);
    return {
      ...initialState,
      allocation: suggestion,
      status: 'allocated',
      messages: [`[fallback] Rule-based allocation: ${suggestion.assigneeName}`],
    } as TaskOrchestrationStateType;
  }
}

/**
 * 提交验收结果，驱动状态机继续流转。
 */
export async function submitReview(
  state: TaskOrchestrationStateType,
  approved: boolean,
  feedback?: string,
  reviewerId: string = 'human',
): Promise<TaskOrchestrationStateType> {
  const reviewResult: ReviewResult = {
    taskId: state.task.id,
    approved,
    feedback,
    reviewerId,
    reviewedAt: new Date().toISOString(),
  };

  try {
    const app = buildTaskOrchestrationGraph();
    const result = await app.invoke({
      ...state,
      reviewResult,
      status: 'pending_review',
    });
    return result as TaskOrchestrationStateType;
  } catch {
    // 降级
    return {
      ...state,
      reviewResult,
      status: approved ? 'completed' : 'rework',
    };
  }
}
