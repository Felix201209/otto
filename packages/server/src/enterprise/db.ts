/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise SQLite database - all data stored on admin/owner device.
 * Zero cloud dependency. All data is local.
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DATA_DIR = path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');

let db: Database.Database | null = null;

export function getDB(): Database.Database {
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

function initSchema(d: Database.Database): void {
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
  ).run(emp);
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
  let sql = 'SELECT * FROM knowledge WHERE content LIKE ?';
  const params: any[] = [`%${query}%`];
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
  const totalMin = tasks.reduce((s, t) => s + (t.duration_min || 0), 0);
  const totalTokens = tasks.reduce((s, t) => s + (t.tokens_used || 0), 0);
  const totalCost = tasks.reduce((s, t) => s + (t.cost_cny || 0), 0);
  const savedMin = totalMin * 2; // estimated: manual takes 3x, Otto takes 1x, saved = 2x
  const moneySaved = (savedMin / 60) * 50; // 50 CNY/hour

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
    totalMinutes: Math.round(totalMin),
    timeSavedHours: Math.round(savedMin / 60 * 10) / 10,
    moneySavedCNY: Math.round(moneySaved),
    tokenCostCNY: Math.round(totalCost * 100) / 100,
    roi: totalCost > 0 ? Math.round(moneySaved / totalCost) : 0,
    activeEmployees,
    byType: Object.entries(byType).map(([type, d]) => ({
      taskType: type, count: d.count, minutes: Math.round(d.min),
      tokens: d.tokens, costCNY: Math.round(d.cost * 100) / 100,
    })),
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
    employees: listEmployees(),
    taskLogs: getDB().prepare('SELECT * FROM task_logs ORDER BY created_at DESC LIMIT 1000').all(),
    knowledge: getKnowledge(),
    inviteCodes: getDB().prepare('SELECT * FROM invite_codes').all(),
    auditLogs: getAuditLogs(200),
  };
}
