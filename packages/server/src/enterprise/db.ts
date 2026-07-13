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
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

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
  /**
   * 「每 ¥1 token 省下多少人力」的可解释上限（封顶倍数）。
   * 单任务成本兜底后本已一致，但为防极端稀疏数据仍爆表，加一道封顶双保险。
   * 命中封顶时看板/返回值会标注 capped=true。可用 OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP 覆盖。
   */
  laborPerTokenCap: envNum('OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP', 50),
};

/**
 * 成本口径归一：非正/缺失的单任务成本一律回落到默认成本估计，避免「显式上报 0」
 * 把整体成本口径拉塌，导致 laborSaved/totalCost 爆表。tokens 同理。
 * 集中在此，logTask 落库前与 report 聚合口径保持一致。
 */
export function normalizeCostCNY(cost: unknown): number {
  const n = typeof cost === 'number' ? cost : Number(cost);
  return Number.isFinite(n) && n > 0 ? n : ESTIMATE.defaultCostPerTaskCNY;
}

export function normalizeTokens(tokens: unknown): number {
  const n = typeof tokens === 'number' ? tokens : Number(tokens);
  return Number.isFinite(n) && n > 0 ? n : ESTIMATE.defaultTokensPerTask;
}

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

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      employee_id TEXT UNIQUE,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS account_tags (
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, tag),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sms_login_challenges (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempts_remaining INTEGER NOT NULL DEFAULT 5,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS it_tickets (
      id TEXT PRIMARY KEY,
      created_by_account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tags TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_deliveries (
      ticket_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      PRIMARY KEY (ticket_id, account_id),
      FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_emp ON task_logs(employee_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON task_logs(task_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_dept ON knowledge(department);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_account_tags_tag ON account_tags(tag, account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sms_challenges_account_created
      ON sms_login_challenges(account_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_ticket_deliveries_account ON ticket_deliveries(account_id, delivered_at);
  `);

  // v1.8 以前的线上库没有手机号列。先探测再做幂等迁移，保留既有账号和会话。
  const accountColumns = d.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === 'phone')) {
    d.exec('ALTER TABLE accounts ADD COLUMN phone TEXT');
  }
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_phone_unique
      ON accounts(phone) WHERE phone IS NOT NULL;
  `);
}

// ============================================================
// Preset accounts, tags and sessions
// ============================================================

export interface AccountView {
  id: string;
  employeeId: string | null;
  username: string;
  phone: string | null;
  name: string;
  role: string | null;
  department: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  employee_id: string | null;
  username: string;
  phone: string | null;
  password_hash: string;
  name: string;
  role: string | null;
  department: string | null;
  is_admin: number;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase('en-US');
}

/** 中国大陆手机号统一保存为 E.164；展示和下发短信时再去掉 +86。 */
export function normalizePhone(phone: string): string {
  let digits = phone.trim().replace(/[^\d]/g, '');
  if (digits.startsWith('0086')) digits = digits.slice(4);
  else if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2);
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('手机号格式不正确');
  return `+86${digits}`;
}

function normalizeOptionalPhone(phone: string | null | undefined): string | null {
  if (phone == null || !phone.trim()) return null;
  return normalizePhone(phone);
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
}

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  try {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tagsForAccount(accountId: string): string[] {
  return (getDB().prepare(
    'SELECT tag FROM account_tags WHERE account_id = ? ORDER BY tag',
  ).all(accountId) as Array<{ tag: string }>).map((row) => row.tag);
}

function toAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    role: row.role,
    department: row.department,
    isAdmin: row.is_admin === 1,
    status: row.status,
    tags: tagsForAccount(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function replaceAccountTags(accountId: string, tags: string[]): void {
  const database = getDB();
  database.prepare('DELETE FROM account_tags WHERE account_id = ?').run(accountId);
  const insert = database.prepare('INSERT INTO account_tags (account_id, tag) VALUES (?, ?)');
  for (const tag of normalizeTags(tags)) insert.run(accountId, tag);
}

export function createAccount(input: {
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  employeeId?: string | null;
  role?: string | null;
  department?: string | null;
  tags?: string[];
  isAdmin?: boolean;
}): AccountView {
  const username = normalizeUsername(input.username);
  const name = input.name.trim();
  if (!username || !name || !input.password) throw new Error('username, password and name required');
  const id = `acc_${randomUUID()}`;
  try {
    getDB().prepare(
    `INSERT INTO accounts
       (id, employee_id, username, phone, password_hash, name, role, department, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.employeeId || null,
      username,
      normalizeOptionalPhone(input.phone),
      passwordHash(input.password),
      name,
      input.role?.trim() || null,
      input.department?.trim() || null,
      input.isAdmin ? 1 : 0,
    );
  } catch (error) {
    if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
      throw new Error('手机号已绑定其他账号');
    }
    throw error;
  }
  replaceAccountTags(id, input.tags ?? []);
  logAudit('account_create', input.employeeId || null, `Preset account ${username} created`);
  return getAccount(id)!;
}

export function getAccount(id: string): AccountView | null {
  const row = getDB().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function listAccounts(): AccountView[] {
  return (getDB().prepare('SELECT * FROM accounts ORDER BY name, username').all() as AccountRow[])
    .map(toAccountView);
}

export function authenticateAccount(username: string, password: string): AccountView | null {
  const normalized = normalizeUsername(username);
  const row = getDB().prepare(
    'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE',
  ).get(normalized) as AccountRow | undefined;
  if (!row || row.status !== 'active' || !passwordMatches(password, row.password_hash)) return null;
  return toAccountView(row);
}

export function findActiveAccountByPhone(phone: string): AccountView | null {
  const normalized = normalizePhone(phone);
  const row = getDB().prepare(
    "SELECT * FROM accounts WHERE phone = ? AND status = 'active'",
  ).get(normalized) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function updateAccount(id: string, patch: {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  role?: string | null;
  department?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}): AccountView {
  const current = getAccount(id);
  if (!current) throw new Error('Account not found');

  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.username !== undefined) {
    const username = normalizeUsername(patch.username);
    if (!username) throw new Error('username required');
    set('username', username);
  }
  if (patch.phone !== undefined) set('phone', normalizeOptionalPhone(patch.phone));
  if (patch.password !== undefined) {
    if (!patch.password) throw new Error('password required');
    set('password_hash', passwordHash(patch.password));
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('name required');
    set('name', name);
  }
  if (patch.role !== undefined) set('role', patch.role?.trim() || null);
  if (patch.department !== undefined) set('department', patch.department?.trim() || null);
  if (patch.isAdmin !== undefined) set('is_admin', patch.isAdmin ? 1 : 0);
  if (patch.status !== undefined) set('status', patch.status);
  if (assignments.length > 0) {
    assignments.push("updated_at = datetime('now')");
    try {
      getDB().prepare(`UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
    } catch (error) {
      if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
        throw new Error('手机号已绑定其他账号');
      }
      throw error;
    }
  }
  if (patch.tags !== undefined) replaceAccountTags(id, patch.tags);
  logAudit('account_update', current.employeeId, `Preset account ${current.username} updated`);
  return getAccount(id)!;
}

export function createAuthSession(accountId: string, ttlMs = 7 * 24 * 60 * 60 * 1000): {
  token: string;
  expiresAt: string;
} {
  if (!getAccount(accountId)) throw new Error('Account not found');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDB().prepare(
    'INSERT INTO auth_sessions (id, account_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
  ).run(`session_${randomUUID()}`, accountId, tokenHash(token), expiresAt);
  return { token, expiresAt };
}

export function getAccountBySession(token: string): AccountView | null {
  if (!token) return null;
  const row = getDB().prepare(
    `SELECT a.* FROM auth_sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND a.status = 'active'`,
  ).get(tokenHash(token)) as AccountRow | undefined;
  if (!row) return null;
  const session = getDB().prepare(
    'SELECT expires_at FROM auth_sessions WHERE token_hash = ?',
  ).get(tokenHash(token)) as { expires_at: string } | undefined;
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  getDB().prepare(
    "UPDATE auth_sessions SET last_used_at = datetime('now') WHERE token_hash = ?",
  ).run(tokenHash(token));
  return toAccountView(row);
}

export function revokeAuthSession(token: string): void {
  if (!token) return;
  getDB().prepare(
    "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE token_hash = ?",
  ).run(tokenHash(token));
}

const SMS_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SMS_CHALLENGE_COOLDOWN_MS = 60 * 1000;
const SMS_CHALLENGE_HOURLY_LIMIT = 5;
const SMS_CHALLENGE_MAX_ATTEMPTS = 5;

export type SmsChallengeIssueResult =
  | { ok: true; challengeId: string; expiresAt: string; retryAfterSeconds: number }
  | { ok: false; reason: 'cooldown' | 'hourly_limit'; retryAfterSeconds: number };

export function createSmsLoginChallenge(
  accountId: string,
  code: string,
  options: { now?: number } = {},
): SmsChallengeIssueResult {
  if (!/^\d{6}$/.test(code)) throw new Error('验证码必须是 6 位数字');
  const account = getAccount(accountId);
  if (!account || account.status !== 'active' || !account.phone) throw new Error('Account not available for SMS login');

  const now = options.now ?? Date.now();
  const recent = getDB().prepare(
    `SELECT created_at_ms FROM sms_login_challenges
     WHERE account_id = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC`,
  ).all(accountId, now - 60 * 60 * 1000) as Array<{ created_at_ms: number }>;
  const latest = recent[0]?.created_at_ms;
  if (latest != null && now - latest < SMS_CHALLENGE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil((latest + SMS_CHALLENGE_COOLDOWN_MS - now) / 1000),
    };
  }
  if (recent.length >= SMS_CHALLENGE_HOURLY_LIMIT) {
    const oldest = recent[recent.length - 1]!.created_at_ms;
    return {
      ok: false,
      reason: 'hourly_limit',
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000)),
    };
  }

  const challengeId = `sms_${randomUUID()}`;
  const expiresAtMs = now + SMS_CHALLENGE_TTL_MS;
  getDB().prepare(
    `INSERT INTO sms_login_challenges
       (id, account_id, code_hash, expires_at_ms, attempts_remaining, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(challengeId, accountId, passwordHash(code), expiresAtMs, SMS_CHALLENGE_MAX_ATTEMPTS, now);
  logAudit('sms_login_code_requested', account.employeeId, 'SMS login code requested');
  return {
    ok: true,
    challengeId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    retryAfterSeconds: SMS_CHALLENGE_COOLDOWN_MS / 1000,
  };
}

/** 供应商未接收短信时撤销刚创建的挑战，避免失败请求占用冷却/小时额度。 */
export function discardSmsLoginChallenge(challengeId: string): void {
  if (!challengeId) return;
  getDB().prepare(
    'DELETE FROM sms_login_challenges WHERE id = ? AND consumed_at_ms IS NULL',
  ).run(challengeId);
}

export type SmsChallengeVerifyResult =
  | { ok: true; account: AccountView }
  | {
      ok: false;
      reason: 'invalid' | 'expired' | 'locked' | 'used';
      attemptsRemaining: number;
    };

export function verifySmsLoginChallenge(
  challengeId: string,
  code: string,
  now = Date.now(),
): SmsChallengeVerifyResult {
  const row = getDB().prepare(
    `SELECT c.account_id, c.code_hash, c.expires_at_ms, c.attempts_remaining, c.consumed_at_ms,
            a.status AS account_status
     FROM sms_login_challenges c
     JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ?`,
  ).get(challengeId) as {
    account_id: string;
    code_hash: string;
    expires_at_ms: number;
    attempts_remaining: number;
    consumed_at_ms: number | null;
    account_status: 'active' | 'disabled';
  } | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (row.account_status !== 'active') {
    getDB().prepare('UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?').run(now, challengeId);
    return { ok: false, reason: 'used', attemptsRemaining: 0 };
  }
  if (now > row.expires_at_ms) {
    getDB().prepare('UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?').run(now, challengeId);
    return { ok: false, reason: 'expired', attemptsRemaining: row.attempts_remaining };
  }
  if (!passwordMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    getDB().prepare(
      `UPDATE sms_login_challenges
       SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
       WHERE id = ?`,
    ).run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  getDB().prepare('UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?').run(now, challengeId);
  const account = getAccount(row.account_id);
  if (!account) return { ok: false, reason: 'used', attemptsRemaining: 0 };
  logAudit('sms_login_verified', account.employeeId, 'SMS login verified');
  return { ok: true, account };
}

export interface TicketView {
  id: string;
  title: string;
  description: string;
  targetTags: string[];
  status: string;
  createdAt: string;
  recipientCount: number;
  recipients: AccountView[];
}

export function createTicket(input: {
  createdByAccountId: string;
  title: string;
  description: string;
  targetTags?: string[];
}): TicketView {
  const creator = getAccount(input.createdByAccountId);
  if (!creator) throw new Error('Account not found');
  const title = input.title.trim();
  const description = input.description.trim();
  const targetTags = normalizeTags(input.targetTags?.length ? input.targetTags : ['IT', '报修']);
  if (!title || !description || targetTags.length === 0) {
    throw new Error('title, description and targetTags required');
  }

  const placeholders = targetTags.map(() => '?').join(', ');
  const recipients = (getDB().prepare(
    `SELECT a.* FROM accounts a
     JOIN account_tags t ON t.account_id = a.id
     WHERE a.status = 'active' AND t.tag IN (${placeholders})
     GROUP BY a.id
     HAVING COUNT(DISTINCT t.tag) = ?
     ORDER BY a.name, a.username`,
  ).all(...targetTags, targetTags.length) as AccountRow[]).map(toAccountView);

  const id = `ticket_${randomUUID()}`;
  getDB().prepare(
    `INSERT INTO it_tickets
       (id, created_by_account_id, title, description, target_tags)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, creator.id, title, description, JSON.stringify(targetTags));
  const deliver = getDB().prepare(
    'INSERT INTO ticket_deliveries (ticket_id, account_id) VALUES (?, ?)',
  );
  for (const recipient of recipients) deliver.run(id, recipient.id);
  logAudit('ticket_create', creator.employeeId, `Ticket ${id} delivered to ${recipients.length} account(s)`);
  const row = getDB().prepare('SELECT created_at, status FROM it_tickets WHERE id = ?').get(id) as {
    created_at: string;
    status: string;
  };
  return {
    id,
    title,
    description,
    targetTags,
    status: row.status,
    createdAt: row.created_at,
    recipientCount: recipients.length,
    recipients,
  };
}

export function listTicketInbox(accountId: string): Array<{
  id: string;
  title: string;
  description: string;
  status: string;
  deliveryStatus: string;
  createdAt: string;
  creatorName: string;
}> {
  const rows = getDB().prepare(
    `SELECT t.id, t.title, t.description, t.status,
            d.status AS delivery_status, t.created_at, a.name AS creator_name
     FROM ticket_deliveries d
     JOIN it_tickets t ON t.id = d.ticket_id
     JOIN accounts a ON a.id = t.created_by_account_id
     WHERE d.account_id = ?
     ORDER BY t.created_at DESC`,
  ).all(accountId) as Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    delivery_status: string;
    created_at: string;
    creator_name: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    creatorName: row.creator_name,
  }));
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
  // 1. 先查 SQLite（B套本地数据）
  const local = getDB().prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (local) return local;

  // 2. 降级查 OrgMemoryStore（A套飞书同步数据）
  try {
    const orgData = loadOrgMemoryStore();
    const user = orgData.users?.find((u: any) => u.id === id);
    if (user) {
      const team = orgData.teams?.find((t: any) => t.id === user.teamIds?.[0]);
      return {
        id: user.id,
        name: user.name,
        role: user.role,
        department: team?.name || null,
        status: 'active',
        onboarded_at: user.createdAt,
      };
    }
  } catch { /* A套数据不可用时降级返回null */ }

  return null;
}

export function listEmployees(department?: string): any[] {
  // 1. 先查 SQLite
  let local: any[];
  if (department) {
    local = getDB().prepare('SELECT * FROM employees WHERE department = ? AND status = ? ORDER BY onboarded_at').all(department, 'active');
  } else {
    local = getDB().prepare('SELECT * FROM employees WHERE status = ? ORDER BY onboarded_at').all('active');
  }

  // 2. 合并 OrgMemoryStore 的飞书同步数据（去重）
  try {
    const orgData = loadOrgMemoryStore();
    const localIds = new Set(local.map((e: any) => e.id));
    const orgUsers = (orgData.users || [])
      .filter((u: any) => !localIds.has(u.id))
      .map((u: any) => {
        const team = orgData.teams?.find((t: any) => t.id === u.teamIds?.[0]);
        return {
          id: u.id,
          name: u.name,
          role: u.role,
          department: team?.name || null,
          status: 'active',
          onboarded_at: u.createdAt,
        };
      })
      .filter((u: any) => !department || u.department === department);

    return [...local, ...orgUsers];
  } catch {
    return local;
  }
}

/**
 * 加载 A套（OrgMemoryStore）的数据。
 * 用于统一两套企业系统的员工数据。
 */
function loadOrgMemoryStore(): any {
  // 尝试几个可能的路径
  const candidates = [
    path.join(process.cwd(), '.otto', 'org', 'memory-store.json'),
    path.join(os.homedir(), '.otto-user', 'org', 'memory-store.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch { /* skip */ }
  }
  return { users: [], teams: [], companies: [], licenses: [] };
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
  // 成本/token 口径归一：显式上报 0 或非正值时回落到默认估计，保证与 report 聚合口径一致，
  // 避免「多数任务 cost=0、少数有真实成本」时 totalCost 塌到极小、laborPerToken 爆表。
  const normalized = {
    ...task,
    tokens_used: normalizeTokens(task.tokens_used),
    cost_cny: normalizeCostCNY(task.cost_cny),
  };
  getDB().prepare(
    `INSERT INTO task_logs (employee_id, task_type, context, result, duration_min, tokens_used, cost_cny)
     VALUES (@employee_id, @task_type, @context, @result, @duration_min, @tokens_used, @cost_cny)`
  ).run(normalized);
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
  // token/成本聚合时对每条也走归一化：即便有历史脏数据或绕过 logTask 直接写库的
  // cost=0 记录，成本口径也一致，不会把 totalCost 拖塌导致 laborPerToken 爆表。
  const totalTokens = tasks.reduce((s, t) => s + normalizeTokens(t.tokens_used), 0);
  const totalCost = tasks.reduce((s, t) => s + normalizeCostCNY(t.cost_cny), 0);

  // 真·省时：人工估时 − Otto 实际耗时，不双算。
  //   manualMin = ottoMin × mult；savedMin = manualMin − ottoMin = ottoMin × (mult − 1)。
  const mult = ESTIMATE.manualTimeMultiplier;
  const savedMin = ottoMin * Math.max(mult - 1, 0);
  const laborSavedCNY = (savedMin / 60) * ESTIMATE.cnyPerHour; // 省下的人力成本（元）
  // 净收益 = 省下的人力成本 − 花掉的 token 成本。诚实口径，可为负。
  const netBenefitCNY = laborSavedCNY - totalCost;
  // 「每花 ¥1 token 估算省下 ¥X 人力」——比「省钱÷token成本」的纯倍率更可解释。
  // 成本口径已归一（不再有 cost=0 拖塌），但仍对倍率封顶作双保险：命中封顶时标注
  // laborPerTokenCapped=true，看板可注明「已封顶」，避免展示不可解释的天文数字。
  const rawLaborPerToken = totalCost > 0 ? laborSavedCNY / totalCost : 0;
  const cap = ESTIMATE.laborPerTokenCap;
  const laborPerTokenCapped = rawLaborPerToken > cap;
  const laborPerTokenCNY = laborPerTokenCapped ? cap : rawLaborPerToken;

  // By task type（成本/token 同样归一，与顶层 totalCost/totalTokens 口径一致）
  const byType: Record<string, { count: number; min: number; tokens: number; cost: number }> = {};
  for (const t of tasks) {
    if (!byType[t.task_type]) byType[t.task_type] = { count: 0, min: 0, tokens: 0, cost: 0 };
    byType[t.task_type].count++;
    byType[t.task_type].min += t.duration_min || 0;
    byType[t.task_type].tokens += normalizeTokens(t.tokens_used);
    byType[t.task_type].cost += normalizeCostCNY(t.cost_cny);
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
    // 账号导出不包含 password_hash / session token 摘要；备份可迁移组织信息，
    // 但不能把登录凭证扩散到普通数据导出文件。
    accounts: listAccounts(),
    accountTags: getDB().prepare('SELECT account_id, tag, created_at FROM account_tags').all(),
    tickets: getDB().prepare('SELECT * FROM it_tickets ORDER BY created_at DESC').all(),
    ticketDeliveries: getDB().prepare('SELECT * FROM ticket_deliveries ORDER BY delivered_at DESC').all(),
  };
}
