/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise SQLite database - all data stored on admin/owner device.
 * Zero cloud dependency. All data is local.
 * 存储层用 Node 内置 node:sqlite（见 sqlite-compat），无原生依赖。
 */

import { Database } from '../sqlite-compat.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DATA_DIR = process.env.OTTO_ENTERPRISE_DIR || path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');

/**
 * 读环境变量里的正数，非法/缺失则回落到默认值。集中做校验，避免各处写死。
 */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 人效换算假设——**这些是估算参数，不是真实计量**。
 * 看板会显式标注「估算」，避免把估值当实测。集中在此，保证全项目口径一致，
 * 且可用环境变量覆盖（消除写死感）。看板披露文案直接引用这里的常量，不再手写数字。
 */
export const ESTIMATE = {
  /**
   * 假设「同一件事纯人工做」耗时是 Otto 的几倍。默认 2（人工 2× → Otto 1×）。
   * 可用 OTTO_ESTIMATE_MANUAL_MULT 覆盖。
   * 真·省时 = 人工估时 − Otto 实际耗时 = ottoMinutes × (mult − 1)，不把 Otto 自己的耗时也算成节省。
   */
  manualTimeMultiplier: envNum('OTTO_ESTIMATE_MANUAL_MULT', 2),
  /** 折算人力成本（元/小时）。可用 OTTO_ESTIMATE_CNY_PER_HOUR 覆盖。 */
  cnyPerHour: envNum('OTTO_ESTIMATE_CNY_PER_HOUR', 50),
  /** 单任务默认 token 估计（未上报真实用量时）。 */
  defaultTokensPerTask: 2000,
  /** 单任务默认成本估计（元）。 */
  defaultCostPerTaskCNY: 0.028,
};

let db: Database | null = null;

export function getDB(): Database {
  if (db) return db;

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      invite_code TEXT,
      status TEXT DEFAULT 'active',
      personality TEXT,
      onboarded_at TEXT DEFAULT (datetime('now')),
      offboarded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      context TEXT,
      result TEXT,
      duration_min REAL,
      tokens_used INTEGER DEFAULT 0,
      cost_cny REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      department TEXT,
      category TEXT,
      content TEXT NOT NULL,
      contributor TEXT,
      confidence REAL DEFAULT 0.5,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      department TEXT NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      employee_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_emp ON task_logs(employee_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON task_logs(task_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_dept ON knowledge(department);
  `);
}

// ============================================================
// Employee operations
// ============================================================
export function createEmployee(emp: {
  id: string; name: string; role?: string;
  department?: string; invite_code?: string; personality?: string;
}): void {
  getDB().prepare(
    `INSERT INTO employees (id, name, role, department, invite_code, personality)
     VALUES (@id, @name, @role, @department, @invite_code, @personality)`
  ).run({ ...emp, role: emp.role || null, department: emp.department || null, invite_code: emp.invite_code || null, personality: emp.personality || null });
  logAudit('onboard', emp.id, `Employee ${emp.name} onboarded to ${emp.department || 'unassigned'}`);
}

export function getEmployee(id: string): any | null {
  return getDB().prepare('SELECT * FROM employees WHERE id = ?').get(id) || null;
}

export function listEmployees(department?: string): any[] {
  if (department) {
    return getDB().prepare('SELECT * FROM employees WHERE department = ? AND status = ? ORDER BY onboarded_at').all(department, 'active');
  }
  return getDB().prepare('SELECT * FROM employees WHERE status = ? ORDER BY onboarded_at').all('active');
}

export function offboardEmployee(id: string): void {
  getDB().prepare('UPDATE employees SET status = ?, offboarded_at = datetime(\'now\') WHERE id = ?').run('offboarded', id);
  logAudit('offboard', id, `Employee offboarded`);
}

// ============================================================
// Task logging
// ============================================================
export function logTask(task: {
  employee_id: string; task_type: string; context?: string;
  result?: string; duration_min?: number; tokens_used?: number; cost_cny?: number;
}): void {
  getDB().prepare(
    `INSERT INTO task_logs (employee_id, task_type, context, result, duration_min, tokens_used, cost_cny)
     VALUES (@employee_id, @task_type, @context, @result, @duration_min, @tokens_used, @cost_cny)`
  ).run(task);
  logAudit('learn', task.employee_id, `Task: ${task.task_type} (${task.duration_min || 0}min)`);
}

export function getTaskHistory(employeeId: string, limit = 20): any[] {
  return getDB().prepare(
    'SELECT * FROM task_logs WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(employeeId, limit);
}

// ============================================================
// Knowledge operations
// ============================================================
export function addKnowledge(k: {
  department?: string; category: string; content: string;
  contributor?: string; confidence?: number;
}): void {
  getDB().prepare(
    `INSERT INTO knowledge (department, category, content, contributor, confidence)
     VALUES (@department, @category, @content, @contributor, @confidence)`
  ).run(k);
}

export function getKnowledge(department?: string, category?: string): any[] {
  let sql = 'SELECT * FROM knowledge WHERE 1=1';
  const params: any[] = [];
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY created_at DESC';
  return getDB().prepare(sql).all(...params);
}

export function searchKnowledge(query: string, department?: string): any[] {
  // Match against both category (task_type is usually stored here, e.g. "contract_review")
  // and content (free-text description), otherwise knowledge tagged by category never
  // surfaces during recall when task_type doesn't literally appear in the Chinese content.
  let sql = 'SELECT * FROM knowledge WHERE (content LIKE ? OR category LIKE ?)';
  const params: any[] = [`%${query}%`, `%${query}%`];
  if (department) { sql += ' AND department = ?'; params.push(department); }
  sql += ' ORDER BY confidence DESC LIMIT 20';
  return getDB().prepare(sql).all(...params);
}

// ============================================================
// Invite codes
// ============================================================
export function createInviteCode(department: string, createdBy?: string, maxUses = 1): string {
  const code = generateCode();
  getDB().prepare(
    'INSERT INTO invite_codes (code, department, max_uses, created_by) VALUES (?, ?, ?, ?)'
  ).run(code, department, maxUses, createdBy || 'admin');
  logAudit('invite_create', null, `Code ${code} for ${department}`);
  return code;
}

export function validateInviteCode(code: string): { valid: boolean; department?: string; error?: string } {
  const row: any = getDB().prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!row) return { valid: false, error: 'Invalid invite code' };
  if (row.used_count >= row.max_uses) return { valid: false, error: 'Invite code already used' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false, error: 'Invite code expired' };
  getDB().prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  return { valid: true, department: row.department };
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ============================================================
// Reports
// ============================================================
export function getReport(periodDays = 30, department?: string): any {
  const db = getDB();
  const since = new Date(Date.now() - periodDays * 86400000).toISOString();

  let empFilter = '';
  const params: any[] = [since];
  if (department) {
    empFilter = ' AND employee_id IN (SELECT id FROM employees WHERE department = ?)';
    params.push(department);
  }

  const tasks: any[] = db.prepare(
    `SELECT * FROM task_logs WHERE created_at >= ?${empFilter} ORDER BY created_at`
  ).all(...params);

  const totalTasks = tasks.length;
  // ottoMin = Otto 实际记录的耗时（这就是「用了 Otto 之后花的时间」）。
  const ottoMin = tasks.reduce((s, t) => s + (t.duration_min || 0), 0);
  const totalTokens = tasks.reduce((s, t) => s + (t.tokens_used || 0), 0);
  const totalCost = tasks.reduce((s, t) => s + (t.cost_cny || 0), 0);

  // 真·省时：人工估时 − Otto 实际耗时，不双算。
  //   manualMin = ottoMin × mult；savedMin = manualMin − ottoMin = ottoMin × (mult − 1)。
  const mult = ESTIMATE.manualTimeMultiplier;
  const savedMin = ottoMin * Math.max(mult - 1, 0);
  const laborSavedCNY = (savedMin / 60) * ESTIMATE.cnyPerHour; // 省下的人力成本（元）
  // 净收益 = 省下的人力成本 − 花掉的 token 成本。诚实口径，可为负。
  const netBenefitCNY = laborSavedCNY - totalCost;
  // 「每花 ¥1 token 估算省下 ¥X 人力」——比「省钱÷token成本」的纯倍率更可解释，
  // 且不会因 token 成本极小而爆表到几百倍。仍是估算，前端需标注。
  const laborPerTokenCNY = totalCost > 0 ? laborSavedCNY / totalCost : 0;

  // By task type
  const byType: Record<string, { count: number; min: number; tokens: number; cost: number }> = {};
  for (const t of tasks) {
    if (!byType[t.task_type]) byType[t.task_type] = { count: 0, min: 0, tokens: 0, cost: 0 };
    byType[t.task_type].count++;
    byType[t.task_type].min += t.duration_min || 0;
    byType[t.task_type].tokens += t.tokens_used || 0;
    byType[t.task_type].cost += t.cost_cny || 0;
  }

  const activeEmployees = listEmployees(department).length;

  return {
    period: `${periodDays}d`,
    totalTasks,
    totalMinutes: Math.round(ottoMin),
    totalTokens,
    timeSavedHours: Math.round((savedMin / 60) * 10) / 10,
    laborSavedCNY: Math.round(laborSavedCNY),
    netBenefitCNY: Math.round(netBenefitCNY),
    tokenCostCNY: Math.round(totalCost * 100) / 100,
    // 保留 laborPerTokenCNY 作为「诚实版 ROI」——每 ¥1 token 省下多少人力（估算）。
    laborPerTokenCNY: Math.round(laborPerTokenCNY * 10) / 10,
    activeEmployees,
    // 省时/省钱/净收益/每元产出 均为估算值，前端需明示。
    estimated: true,
    assumptions: {
      manualTimeMultiplier: mult,
      cnyPerHour: ESTIMATE.cnyPerHour,
    },
    byType: Object.entries(byType).map(([type, d]) => ({
      taskType: type, count: d.count, minutes: Math.round(d.min),
      tokens: d.tokens, costCNY: Math.round(d.cost * 100) / 100,
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
  const out: Array<{ i: number; at: string; cumTasks: number; cumSavedHours: number }> = [];
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
  byType: Record<string, { count: number; min: number; tokens: number; cost: number }>,
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
  const mostFrequent = entries.reduce((a, b) => (b[1].count > a[1].count ? b : a));
  const slowestAvg = entries.reduce((a, b) => {
    const avgA = a[1].count ? a[1].min / a[1].count : 0;
    const avgB = b[1].count ? b[1].min / b[1].count : 0;
    return avgB > avgA ? b : a;
  });
  return {
    slowestTotal: { taskType: slowestTotal[0], minutes: Math.round(slowestTotal[1].min) },
    mostFrequent: { taskType: mostFrequent[0], count: mostFrequent[1].count },
    slowestAvg: {
      taskType: slowestAvg[0],
      avgMinutes: Math.round((slowestAvg[1].min / (slowestAvg[1].count || 1)) * 10) / 10,
    },
  };
}

// ============================================================
// Audit
// ============================================================
export function logAudit(event: string, employeeId: string | null, detail: string): void {
  getDB().prepare(
    'INSERT INTO audit_logs (event, employee_id, detail) VALUES (?, ?, ?)'
  ).run(event, employeeId, detail);
}

export function getAuditLogs(limit = 50): any[] {
  return getDB().prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ============================================================
// Export all (for backup)
// ============================================================
export function exportAll(): any {
  return {
    // Full backup must include offboarded employees too, otherwise every
    // offboarding silently erases historical employee records from the
    // export — contradicting the "export ALL data" guarantee.
    employees: getDB().prepare('SELECT * FROM employees ORDER BY onboarded_at').all(),
    taskLogs: getDB().prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT 1000').all(),
    knowledge: getKnowledge(),
    inviteCodes: getDB().prepare('SELECT * FROM invite_codes').all(),
    auditLogs: getAuditLogs(200),
  };
}
