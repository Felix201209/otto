/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_ORGANIZATION_ID,
  ESTIMATE,
  getDB,
  listEmployees,
  logAudit,
  normalizeCostCNY,
  normalizeTokens,
} from './db.js';

export function logTask(task: {
  employee_id: string;
  task_type: string;
  context?: string;
  result?: string;
  duration_min?: number;
  tokens_used?: number;
  cost_cny?: number;
}): void {
  const employee = getDB()
    .prepare('SELECT organization_id FROM employees WHERE id = ?')
    .get(task.employee_id) as { organization_id: string } | undefined;
  if (!employee) throw new Error('Employee not found');
  // 成本/token 口径归一：显式上报 0 或非正值时回落到默认估计，保证与 report 聚合口径一致，
  // 避免「多数任务 cost=0、少数有真实成本」时 totalCost 塌到极小、laborPerToken 爆表。
  const normalized = {
    ...task,
    tokens_used: normalizeTokens(task.tokens_used),
    cost_cny: normalizeCostCNY(task.cost_cny),
  };
  getDB()
    .prepare(
      `INSERT INTO task_logs
       (organization_id, employee_id, task_type, context, result, duration_min, tokens_used, cost_cny)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      employee.organization_id,
      normalized.employee_id,
      normalized.task_type,
      normalized.context || null,
      normalized.result || null,
      normalized.duration_min || 0,
      normalized.tokens_used,
      normalized.cost_cny,
    );
  logAudit(
    'learn',
    task.employee_id,
    `Task: ${task.task_type} (${task.duration_min || 0}min)`,
    employee.organization_id,
  );
}

export function getTaskHistory(
  employeeId: string,
  limit = 20,
  organizationId?: string,
): any[] {
  return organizationId
    ? getDB()
        .prepare(
          `SELECT * FROM task_logs WHERE employee_id = ? AND organization_id = ?
       ORDER BY created_at DESC LIMIT ?`,
        )
        .all(employeeId, organizationId, limit)
    : getDB()
        .prepare(
          'SELECT * FROM task_logs WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(employeeId, limit);
}

export function getReport(
  periodDays = 30,
  department?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any {
  const db = getDB();
  const since = new Date(Date.now() - periodDays * 86400000).toISOString();

  let empFilter = '';
  const params: any[] = [since, organizationId];
  if (department) {
    empFilter =
      ' AND employee_id IN (SELECT id FROM employees WHERE organization_id = ? AND department = ?)';
    params.push(organizationId, department);
  }

  const tasks: any[] = db
    .prepare(
      `SELECT * FROM task_logs WHERE created_at >= ? AND organization_id = ?${empFilter} ORDER BY created_at`,
    )
    .all(...params);

  const totalTasks = tasks.length;
  // ottoMin = Otto 实际记录的耗时（这就是「用了 Otto 之后花的时间」）。
  const ottoMin = tasks.reduce((s, t) => s + (t.duration_min || 0), 0);
  // token/成本聚合时对每条也走归一化：即便有历史脏数据或绕过 logTask 直接写库的
  // cost=0 记录，成本口径也一致，不会把 totalCost 拖塌导致 laborPerToken 爆表。
  const totalTokens = tasks.reduce(
    (s, t) => s + normalizeTokens(t.tokens_used),
    0,
  );
  const totalCost = tasks.reduce((s, t) => s + normalizeCostCNY(t.cost_cny), 0);

  // 真·省时：人工估时 - Otto 实际耗时，不双算。
  //   manualMin = ottoMin * mult；savedMin = manualMin - ottoMin = ottoMin * (mult - 1)。
  const mult = ESTIMATE.manualTimeMultiplier;
  const savedMin = ottoMin * Math.max(mult - 1, 0);
  const laborSavedCNY = (savedMin / 60) * ESTIMATE.cnyPerHour; // 省下的人力成本（元）
  // 净收益 = 省下的人力成本 - 花掉的 token 成本。诚实口径，可为负。
  const netBenefitCNY = laborSavedCNY - totalCost;
  // 「每花 ¥1 token 估算省下 ¥X 人力」-- 比「省钱÷token成本」的纯倍率更可解释。
  // 成本口径已归一（不再有 cost=0 拖塌），但仍对倍率封顶作双保险：命中封顶时标注
  // laborPerTokenCapped=true，看板可注明「已封顶」，避免展示不可解释的天文数字。
  const rawLaborPerToken = totalCost > 0 ? laborSavedCNY / totalCost : 0;
  const cap = ESTIMATE.laborPerTokenCap;
  const laborPerTokenCapped = rawLaborPerToken > cap;
  const laborPerTokenCNY = laborPerTokenCapped ? cap : rawLaborPerToken;

  // By task type（成本/token 同样归一，与顶层 totalCost/totalTokens 口径一致）
  const byType: Record<
    string,
    { count: number; min: number; tokens: number; cost: number }
  > = {};
  for (const t of tasks) {
    if (!byType[t.task_type])
      byType[t.task_type] = { count: 0, min: 0, tokens: 0, cost: 0 };
    byType[t.task_type].count++;
    byType[t.task_type].min += t.duration_min || 0;
    byType[t.task_type].tokens += normalizeTokens(t.tokens_used);
    byType[t.task_type].cost += normalizeCostCNY(t.cost_cny);
  }

  const activeEmployees = listEmployees(department, organizationId).length;

  return {
    period: `${periodDays}d`,
    totalTasks,
    totalMinutes: Math.round(ottoMin),
    totalTokens,
    timeSavedHours: Math.round((savedMin / 60) * 10) / 10,
    laborSavedCNY: Math.round(laborSavedCNY),
    netBenefitCNY: Math.round(netBenefitCNY),
    tokenCostCNY: Math.round(totalCost * 100) / 100,
    // 保留 laborPerTokenCNY 作为「诚实版 ROI」-- 每 ¥1 token 省下多少人力（估算）。
    laborPerTokenCNY: Math.round(laborPerTokenCNY * 10) / 10,
    // 是否命中封顶：为 true 时上面的值是封顶后的上限，看板据此标注「已封顶」。
    laborPerTokenCapped,
    activeEmployees,
    // 省时/省钱/净收益/每元产出 均为估算值，前端需明示。
    estimated: true,
    assumptions: {
      manualTimeMultiplier: mult,
      cnyPerHour: ESTIMATE.cnyPerHour,
      laborPerTokenCap: cap,
    },
    byType: Object.entries(byType).map(([type, d]) => ({
      taskType: type,
      count: d.count,
      minutes: Math.round(d.min),
      tokens: d.tokens,
      costCNY: Math.round(d.cost * 100) / 100,
    })),
    // 图表数据：任务累积趋势（按时间序累积任务数与省时分钟），以及瓶颈提示。
    trend: buildTrend(tasks, mult),
    bottlenecks: buildBottlenecks(byType),
  };
}

/**
 * 任务累积趋势：按 created_at 升序，逐条累积「任务数」和「累计省时(小时)」。
 * seed 数据常落在同一天，按天分组只会得到一个点，故用「按任务累积」口径，
 * 既满足趋势可视化，也对稀疏/同日数据成立。返回轻量点集供 SVG 折线图用。
 */
function buildTrend(
  tasks: Array<{ created_at?: string; duration_min?: number }>,
  mult: number,
): Array<{ i: number; at: string; cumTasks: number; cumSavedHours: number }> {
  const sorted = [...tasks].sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || '')),
  );
  const out: Array<{
    i: number;
    at: string;
    cumTasks: number;
    cumSavedHours: number;
  }> = [];
  let cumTasks = 0;
  let cumSavedMin = 0;
  for (let i = 0; i < sorted.length; i++) {
    cumTasks += 1;
    cumSavedMin += (sorted[i].duration_min || 0) * Math.max(mult - 1, 0);
    out.push({
      i: i + 1,
      at: String(sorted[i].created_at || ''),
      cumTasks,
      cumSavedHours: Math.round((cumSavedMin / 60) * 100) / 100,
    });
  }
  return out;
}

/**
 * 瓶颈提示：从 byType 聚合里挑「最耗时」「最频繁」「单次平均最慢」三类。
 */
function buildBottlenecks(
  byType: Record<
    string,
    { count: number; min: number; tokens: number; cost: number }
  >,
): {
  slowestTotal: { taskType: string; minutes: number } | null;
  mostFrequent: { taskType: string; count: number } | null;
  slowestAvg: { taskType: string; avgMinutes: number } | null;
} {
  const entries = Object.entries(byType);
  if (entries.length === 0) {
    return { slowestTotal: null, mostFrequent: null, slowestAvg: null };
  }
  const slowestTotal = entries.reduce((a, b) => (b[1].min > a[1].min ? b : a));
  const mostFrequent = entries.reduce((a, b) =>
    b[1].count > a[1].count ? b : a,
  );
  const slowestAvg = entries.reduce((a, b) => {
    const avgA = a[1].count ? a[1].min / a[1].count : 0;
    const avgB = b[1].count ? b[1].min / b[1].count : 0;
    return avgB > avgA ? b : a;
  });
  return {
    slowestTotal: {
      taskType: slowestTotal[0],
      minutes: Math.round(slowestTotal[1].min),
    },
    mostFrequent: { taskType: mostFrequent[0], count: mostFrequent[1].count },
    slowestAvg: {
      taskType: slowestAvg[0],
      avgMinutes:
        Math.round((slowestAvg[1].min / (slowestAvg[1].count || 1)) * 10) / 10,
    },
  };
}
