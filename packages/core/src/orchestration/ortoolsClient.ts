/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * OR-Tools 任务分配优化客户端。
 *
 * 作为 taskOrchestrator 的数学优化层：
 * LLM 决策负责"谁适合干什么"（语义层），OR-Tools 负责"在约束下最优分配"（数学层）。
 *
 * 调用 Python OR-Tools 服务（scripts/ortools_allocator.py），
 * 如果服务不可用则降级到 LLM/规则分配。
 */

import type { TaskDefinition, EmployeeProfile, AllocationSuggestion } from '../orchestration/taskOrchestrator.js';

/** OR-Tools 服务地址 */
const ORTOOLS_URL = process.env.ORTOOLS_URL || 'http://127.0.0.1:7777';

/** OR-Tools 优化请求 */
interface OptimizeRequest {
  tasks: Array<{
    id: string;
    priority: number;
    estimated_minutes: number;
    required_skills: string[];
  }>;
  employees: Array<{
    id: string;
    skills: string[];
    current_load: number;
    efficiency: number;
  }>;
  constraints: {
    max_tasks_per_person: number;
    balance_threshold: number;
  };
}

/** OR-Tools 优化结果 */
interface OptimizeResponse {
  assignments: Array<{
    task_id: string;
    employee_id: string;
    score: number;
    skill_match: number;
  }>;
  load_balance: Record<string, number>;
  explanation: string;
  optimal: boolean;
}

/**
 * 调用 OR-Tools 服务做最优任务分配。
 * 如果服务不可用，返回 null（调用方降级到 LLM/规则分配）。
 */
export async function optimizeAllocation(
  tasks: TaskDefinition[],
  employees: EmployeeProfile[],
  options: {
    maxTasksPerPerson?: number;
    balanceThreshold?: number;
  } = {},
): Promise<OptimizeResponse | null> {
  const req: OptimizeRequest = {
    tasks: tasks.map(t => ({
      id: t.id,
      priority: priorityToNumber(t.priority),
      estimated_minutes: 30, // 默认30分钟，后续可从历史数据估算
      required_skills: extractSkills(t.requirements),
    })),
    employees: employees.map(e => ({
      id: e.id,
      skills: e.skills,
      current_load: e.currentLoad,
      efficiency: e.efficiencyScore,
    })),
    constraints: {
      max_tasks_per_person: options.maxTasksPerPerson ?? 5,
      balance_threshold: options.balanceThreshold ?? 30,
    },
  };

  try {
    const response = await fetch(`${ORTOOLS_URL}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(8000), // 8秒超时
    });

    if (!response.ok) {
      console.warn(`[OR-Tools] Service returned ${response.status}`);
      return null;
    }

    return (await response.json()) as OptimizeResponse;
  } catch (error) {
    console.warn(`[OR-Tools] Service unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * 检查 OR-Tools 服务是否可用。
 */
export async function checkOrToolsHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${ORTOOLS_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 双层分配：LLM 语义匹配 + OR-Tools 数学优化。
 *
 * 流程：
 * 1. 如果 OR-Tools 可用 → 用数学优化做全局最优分配
 * 2. 如果 OR-Tools 不可用 → 降级到 LLM/规则分配
 */
export async function dualLayerAllocate(
  task: TaskDefinition,
  employees: EmployeeProfile[],
  llmSuggestion?: AllocationSuggestion,
): Promise<AllocationSuggestion> {
  // 尝试 OR-Tools
  const orToolsResult = await optimizeAllocation([task], employees);

  if (orToolsResult && orToolsResult.assignments.length > 0) {
    const assignment = orToolsResult.assignments[0];
    const emp = employees.find(e => e.id === assignment.employee_id);
    if (emp) {
      return {
        assigneeId: emp.id,
        assigneeName: emp.name,
        reason: `OR-Tools optimal: score=${assignment.score}, skill_match=${assignment.skill_match}, load_balanced. ${orToolsResult.explanation}`,
        confidence: Math.min(1, assignment.score / 100),
        estimatedMinutes: 30,
      };
    }
  }

  // 降级到 LLM 建议
  if (llmSuggestion) {
    return llmSuggestion;
  }

  // 最终降级：规则匹配（在 taskOrchestrator 里实现）
  throw new Error('All allocation methods failed');
}

// ============================================================
// 辅助函数
// ============================================================

function priorityToNumber(priority: string): number {
  const map: Record<string, number> = {
    urgent: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return map[priority] ?? 2;
}

function extractSkills(requirements: string): string[] {
  // 从需求文本中提取技能关键词
  const commonSkills = [
    'python', 'javascript', 'typescript', 'java', 'go', 'rust',
    'react', 'vue', 'node', 'docker', 'kubernetes', 'sql',
    '运营', '文案', '设计', '数据分析', '项目管理', 'hr', '行政',
    '飞书', 'excel', 'ppt', '文档',
  ];

  const lower = requirements.toLowerCase();
  return commonSkills.filter(s => lower.includes(s));
}
