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
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  buildOrganizationInviteLink,
  resolveEnterprisePublicBaseUrl,
} from './publicInvite.js';

const DATA_DIR = process.env.OTTO_ENTERPRISE_DIR || path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');

export const DEFAULT_ORGANIZATION_ID = 'org_default';
export const ORGANIZATION_INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const ORGANIZATION_INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

  // 首次进入 B2B v2 schema 前保留一份只读回滚副本。已有备份不覆盖，避免反复占用磁盘。
  if (fs.existsSync(DB_PATH)) {
    const backupPath = `${DB_PATH}.pre-b2b-v2.bak`;
    if (!fs.existsSync(backupPath) && fs.statSync(DB_PATH).size > 0) {
      fs.copyFileSync(DB_PATH, backupPath, fs.constants.COPYFILE_EXCL);
    }
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      invite_secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS organization_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      created_by_account_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      invite_code TEXT,
      status TEXT DEFAULT 'active',
      personality TEXT,
      onboarded_at TEXT DEFAULT (datetime('now')),
      offboarded_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      employee_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      context TEXT,
      result TEXT,
      duration_min REAL,
      tokens_used INTEGER DEFAULT 0,
      cost_cny REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      department TEXT,
      category TEXT,
      content TEXT NOT NULL,
      contributor TEXT,
      confidence REAL DEFAULT 0.5,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      department TEXT NOT NULL,
      max_uses INTEGER DEFAULT 1,
      used_count INTEGER DEFAULT 0,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      event TEXT NOT NULL,
      employee_id TEXT,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
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
      FOREIGN KEY (employee_id) REFERENCES employees(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS account_tags (
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, tag),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS sms_login_challenges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      account_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempts_remaining INTEGER NOT NULL DEFAULT 5,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS sms_registration_challenges (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      phone TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      attempts_remaining INTEGER NOT NULL DEFAULT 5,
      consumed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS account_token_usage (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, message_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS it_tickets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      created_by_account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tags TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS ticket_deliveries (
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      ticket_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      PRIMARY KEY (ticket_id, account_id),
      FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_emp ON task_logs(employee_id);
    CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
    CREATE INDEX IF NOT EXISTS idx_organization_invites_active
      ON organization_invites(organization_id, expires_at_ms, revoked_at_ms);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON task_logs(task_type);
    CREATE INDEX IF NOT EXISTS idx_knowledge_dept ON knowledge(department);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_account_tags_tag ON account_tags(tag, account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sms_challenges_account_created
      ON sms_login_challenges(account_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_sms_registration_phone_created
      ON sms_registration_challenges(phone, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_ticket_deliveries_account ON ticket_deliveries(account_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_org_created
      ON account_token_usage(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_account_created
      ON account_token_usage(account_id, created_at);
  `);

  d.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, slug, invite_secret)
     VALUES (?, ?, ?, ?)`,
  ).run(
    DEFAULT_ORGANIZATION_ID,
    process.env.OTTO_DEFAULT_ORGANIZATION_NAME?.trim() || '默认企业',
    'default',
    randomBytes(32).toString('hex'),
  );

  // v1.8 以前的线上库没有手机号列。先探测再做幂等迁移，保留既有账号和会话。
  const accountColumns = d.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === 'phone')) {
    d.exec('ALTER TABLE accounts ADD COLUMN phone TEXT');
  }
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_phone_unique
      ON accounts(phone) WHERE phone IS NOT NULL;
  `);

  // B2B v2：旧库所有既有数据归入默认企业，密码、标签和会话继续有效。
  const ensureOrganizationColumn = (table: string): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'organization_id')) {
      d.exec(
        `ALTER TABLE ${table} ADD COLUMN organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}'`,
      );
    }
  };
  for (const table of [
    'employees',
    'task_logs',
    'knowledge',
    'invite_codes',
    'audit_logs',
    'accounts',
    'account_tags',
    'auth_sessions',
    'sms_login_challenges',
    'sms_registration_challenges',
    'it_tickets',
    'ticket_deliveries',
  ]) ensureOrganizationColumn(table);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_organization ON accounts(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_employees_organization ON employees(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_organization ON task_logs(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_organization ON knowledge(organization_id, department);
    CREATE INDEX IF NOT EXISTS idx_audit_organization ON audit_logs(organization_id, created_at);
    PRAGMA user_version = 2;
  `);
}

// ============================================================
// Organizations and time-boxed registration invites
// ============================================================

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface OrganizationInviteView {
  id: string;
  organizationId: string;
  code: string;
  link: string;
  status: 'active' | 'expired' | 'revoked';
  issuedAt: string;
  expiresAt: string;
  validHours: 168;

interface OrganizationInviteRow {
  id: string;
  organization_id: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
}

function toOrganizationView(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeOrganizationSlug(input: string): string {
  const slug = input.trim().toLocaleLowerCase('en-US').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 48) throw new Error('企业标识只能使用字母、数字和连字符');
  return slug;
}

export function createOrganization(input: {
  name: string;
  slug?: string;
  now?: number;
}): OrganizationView {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new Error('企业名称不能为空且不能超过 80 个字符');
  const slug = normalizeOrganizationSlug(
    input.slug || `company-${randomBytes(5).toString('hex')}`,
  );
  const id = `org_${randomUUID()}`;
  getDB().prepare(
    `INSERT INTO organizations (id, name, slug, invite_secret)
     VALUES (?, ?, ?, ?)`,
  ).run(id, name, slug, randomBytes(32).toString('hex'));
  logAudit('organization_create', null, `Organization ${slug} created`, id);
  return getOrganization(id)!;
}

export function getOrganization(id: string): OrganizationView | null {
  const row = getDB().prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
    | OrganizationRow
    | undefined;
  return row ? toOrganizationView(row) : null;
}

export function listOrganizations(): OrganizationView[] {
  return (getDB().prepare('SELECT * FROM organizations ORDER BY name, slug').all() as OrganizationRow[])
    .map(toOrganizationView);
}

function normalizeOrganizationInviteCode(code: string): string {
  return code.toLocaleUpperCase('en-US').replace(/[^A-Z2-9]/g, '');
}

function deriveOrganizationInviteCode(organization: OrganizationRow, nonce: string): string {
  const digest = createHmac('sha256', organization.invite_secret)
    .update(`${organization.id}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < 8; index += 1) {
    code += ORGANIZATION_INVITE_ALPHABET[digest[index]! % ORGANIZATION_INVITE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function toOrganizationInviteView(
  row: OrganizationInviteRow,
  organization: OrganizationRow,
  now: number,
): OrganizationInviteView {
  const status = row.revoked_at_ms != null
    ? 'revoked'
    : now >= row.expires_at_ms ? 'expired' : 'active';
  const code = deriveOrganizationInviteCode(organization, row.nonce);
  const publicBaseUrl = resolveEnterprisePublicBaseUrl({
    configuredUrl: process.env.OTTO_ENTERPRISE_PUBLIC_URL,
  });
  return {
    id: row.id,
    organizationId: row.organization_id,
    code,
    link: buildOrganizationInviteLink(publicBaseUrl, code),
    status,
    issuedAt: new Date(row.issued_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    validHours: 168,
  };
}

export type OrganizationInviteStatus = 'active' | 'expired' | 'revoked' | 'invalid';

export interface OrganizationInviteInspection {
  status: OrganizationInviteStatus;
  organizationId: string | null;
}

/**
 * Inspect one derived invite code without returning organization metadata.
 * Public landing pages use this to distinguish a missing link from a link that
 * existed but is no longer usable, while keeping tenant details private.
 */
export function inspectOrganizationInvite(
  code: string,
  now = Date.now(),
): OrganizationInviteInspection {
  const normalized = normalizeOrganizationInviteCode(code);
  if (normalized.length !== 8) return { status: 'invalid', organizationId: null };

  const rows = getDB().prepare(
    `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id`,
  ).all() as Array<OrganizationInviteRow & Omit<OrganizationRow, 'id'>>;
  const matches = rows.filter((row) => {
    const organization: OrganizationRow = {
      id: row.organization_id,
      name: row.name,
      slug: row.slug,
      invite_secret: row.invite_secret,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const expected = normalizeOrganizationInviteCode(
      deriveOrganizationInviteCode(organization, row.nonce),
    );
    return expected.length === normalized.length
      && timingSafeEqual(Buffer.from(expected), Buffer.from(normalized));
  });
  if (matches.length !== 1) return { status: 'invalid', organizationId: null };

  const match = matches[0]!;
  if (match.status !== 'active') return { status: 'invalid', organizationId: null };
  if (match.revoked_at_ms != null) {
    return { status: 'revoked', organizationId: match.organization_id };
  }
  if (now >= match.expires_at_ms) {
    return { status: 'expired', organizationId: match.organization_id };
  }
  return { status: 'active', organizationId: match.organization_id };
}

export function issueOrganizationInvite(
  organizationId: string,
  now = Date.now(),
  createdByAccountId?: string | null,
): OrganizationInviteView {
  const organization = getDB().prepare(
    'SELECT * FROM organizations WHERE id = ? AND status = ?',
  ).get(organizationId, 'active') as OrganizationRow | undefined;
  if (!organization) throw new Error('Organization not found');
  const id = `orginvite_${randomUUID()}`;
  const nonce = randomBytes(24).toString('base64url');
  const expiresAtMs = now + ORGANIZATION_INVITE_VALIDITY_MS;
  const database = getDB();
  database.prepare(
    `INSERT INTO organization_invites
       (id, organization_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, organizationId, nonce, now, expiresAtMs, createdByAccountId || null);
  database.prepare(
    `UPDATE organization_invites SET revoked_at_ms = ?
     WHERE organization_id = ? AND id <> ? AND revoked_at_ms IS NULL`,
  ).run(now, organizationId, id);
  logAudit('organization_invite_issue', null, 'Registration invite issued for 7 days', organizationId);
  const row = database.prepare('SELECT * FROM organization_invites WHERE id = ?').get(id) as OrganizationInviteRow;
  return toOrganizationInviteView(row, organization, now);
}

export function getOrganizationInvite(
  organizationId: string,
  now = Date.now(),
): OrganizationInviteView | null {
  const organization = getDB().prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId) as
    | OrganizationRow
    | undefined;
  if (!organization) return null;
  const row = getDB().prepare(
    `SELECT * FROM organization_invites
     WHERE organization_id = ? ORDER BY issued_at_ms DESC LIMIT 1`,
  ).get(organizationId) as OrganizationInviteRow | undefined;
  return row ? toOrganizationInviteView(row, organization, now) : null;
}

export function resolveOrganizationInvite(code: string, now = Date.now()): OrganizationView | null {
  const normalized = normalizeOrganizationInviteCode(code);
  if (normalized.length !== 8) return null;
  const rows = getDB().prepare(
    `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.revoked_at_ms IS NULL AND i.expires_at_ms > ? AND o.status = 'active'`,
  ).all(now) as Array<OrganizationInviteRow & Omit<OrganizationRow, 'id'>>;
  const matches = rows.filter((row) => {
    const organization: OrganizationRow = {
      id: row.organization_id,
      name: row.name,
      slug: row.slug,
      invite_secret: row.invite_secret,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const expected = normalizeOrganizationInviteCode(
      deriveOrganizationInviteCode(organization, row.nonce),
    );
    return expected.length === normalized.length
      && timingSafeEqual(Buffer.from(expected), Buffer.from(normalized));
  });
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return toOrganizationView({
    id: match.organization_id,
    name: match.name,
    slug: match.slug,
    invite_secret: match.invite_secret,
    status: match.status,
    created_at: match.created_at,
    updated_at: match.updated_at,
  });
}

// ============================================================
// Preset accounts, tags and sessions
// ============================================================

export interface AccountView {
  id: string;
  organizationId: string;
  organizationName: string;
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
  organization_id: string;
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

function tagsForAccount(accountId: string, organizationId: string): string[] {
  return (getDB().prepare(
    'SELECT tag FROM account_tags WHERE account_id = ? AND organization_id = ? ORDER BY tag',
  ).all(accountId, organizationId) as Array<{ tag: string }>).map((row) => row.tag);
}

function toAccountView(row: AccountRow): AccountView {
  const organization = getOrganization(row.organization_id);
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: organization?.name || '未知企业',
    employeeId: row.employee_id,
    username: row.username,
    phone: row.phone,
    name: row.name,
    role: row.role,
    department: row.department,
    isAdmin: row.is_admin === 1,
    status: row.status,
    tags: tagsForAccount(row.id, row.organization_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function replaceAccountTags(accountId: string, organizationId: string, tags: string[]): void {
  const database = getDB();
  database.prepare(
    'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
  ).run(accountId, organizationId);
  const insert = database.prepare(
    'INSERT INTO account_tags (organization_id, account_id, tag) VALUES (?, ?, ?)',
  );
  for (const tag of normalizeTags(tags)) insert.run(organizationId, accountId, tag);
}

export function createAccount(input: {
  organizationId?: string;
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
  const organizationId = input.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const username = normalizeUsername(input.username);
  const name = input.name.trim();
  if (!username || !name || !input.password) throw new Error('username, password and name required');
  const id = `acc_${randomUUID()}`;
  try {
    getDB().prepare(
    `INSERT INTO accounts
       (id, organization_id, employee_id, username, phone, password_hash, name, role, department, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      organizationId,
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
  replaceAccountTags(id, organizationId, input.tags ?? []);
  logAudit('account_create', input.employeeId || null, `Preset account ${username} created`, organizationId);
  return getAccount(id)!;
}

export function getAccount(id: string, organizationId?: string): AccountView | null {
  const row = (organizationId
    ? getDB().prepare('SELECT * FROM accounts WHERE id = ? AND organization_id = ?').get(id, organizationId)
    : getDB().prepare('SELECT * FROM accounts WHERE id = ?').get(id)) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function listAccounts(organizationId = DEFAULT_ORGANIZATION_ID): AccountView[] {
  return (getDB().prepare(
    'SELECT * FROM accounts WHERE organization_id = ? ORDER BY name, username',
  ).all(organizationId) as AccountRow[])
    .map(toAccountView);
}

export function authenticateAccount(identifier: string, password: string): AccountView | null {
  const normalized = normalizeUsername(identifier);
  let row = getDB().prepare(
    'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE',
  ).get(normalized) as AccountRow | undefined;
  if (!row) {
    try {
      row = getDB().prepare(
        'SELECT * FROM accounts WHERE phone = ?',
      ).get(normalizePhone(identifier)) as AccountRow | undefined;
    } catch {
      // 不是手机号时继续按“账号或密码错误”处理，避免泄露账号是否存在。
    }
  }
  if (!row || row.status !== 'active'
    || getOrganization(row.organization_id)?.status !== 'active'
    || !passwordMatches(password, row.password_hash)) return null;
  return toAccountView(row);
}

export function findAccountByPhone(phone: string): AccountView | null {
  const normalized = normalizePhone(phone);
  const row = getDB().prepare(
    'SELECT * FROM accounts WHERE phone = ?',
  ).get(normalized) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function findActiveAccountByPhone(phone: string): AccountView | null {
  const account = findAccountByPhone(phone);
  return account?.status === 'active' ? account : null;
}

export function createSelfRegisteredAccount(input: {
  organizationId: string;
  phone: string;
  name: string;
  password: string;
}): AccountView {
  const normalized = normalizePhone(input.phone);
  const existing = findAccountByPhone(normalized);
  if (existing) throw new Error('该手机号已注册，请直接登录');

  const digits = normalized.slice(3);
  try {
    return createAccount({
      organizationId: input.organizationId,
      username: `otto_${digits.slice(-4)}_${randomBytes(4).toString('hex')}`,
      password: input.password,
      name: input.name,
      phone: normalized,
      role: '成员',
      tags: ['普通成员'],
      isAdmin: false,
    });
  } catch (error) {
    // 两个有效验证码并发完成时，手机号唯一索引只允许一个账号落库。
    if (findAccountByPhone(normalized)) throw new Error('该手机号已注册，请直接登录');
    throw error;
  }
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
}, organizationId?: string): AccountView {
  const current = getAccount(id, organizationId);
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
      const sql = organizationId
        ? `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ? AND organization_id = ?`
        : `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`;
      getDB().prepare(sql).run(...values, id, ...(organizationId ? [organizationId] : []));
    } catch (error) {
      if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
        throw new Error('手机号已绑定其他账号');
      }
      throw error;
    }
  }
  if (patch.tags !== undefined) replaceAccountTags(id, current.organizationId, patch.tags);
  logAudit(
    'account_update',
    current.employeeId,
    `Preset account ${current.username} updated`,
    current.organizationId,
  );
  return getAccount(id, organizationId)!;
}

export function createAuthSession(accountId: string, ttlMs = 30 * 24 * 60 * 60 * 1000): {
  token: string;
  expiresAt: string;
} {
  const account = getAccount(accountId);
  if (!account || getOrganization(account.organizationId)?.status !== 'active') {
    throw new Error('Account not found');
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDB().prepare(
    `INSERT INTO auth_sessions (id, organization_id, account_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`session_${randomUUID()}`, account.organizationId, accountId, tokenHash(token), expiresAt);
  return { token, expiresAt };
}

export function getAccountBySession(token: string): AccountView | null {
  if (!token) return null;
  const row = getDB().prepare(
    `SELECT a.* FROM auth_sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN organizations o ON o.id = a.organization_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
       AND a.status = 'active' AND o.status = 'active'`,
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
       (id, organization_id, account_id, code_hash, expires_at_ms, attempts_remaining, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    challengeId,
    account.organizationId,
    accountId,
    passwordHash(code),
    expiresAtMs,
    SMS_CHALLENGE_MAX_ATTEMPTS,
    now,
  );
  logAudit(
    'sms_login_code_requested',
    account.employeeId,
    'SMS login code requested',
    account.organizationId,
  );
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

export function createSmsRegistrationChallenge(
  phone: string,
  code: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
  options: { now?: number } = {},
): SmsChallengeIssueResult {
  if (!/^\d{6}$/.test(code)) throw new Error('验证码必须是 6 位数字');
  const normalized = normalizePhone(phone);
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const now = options.now ?? Date.now();
  const recent = getDB().prepare(
    `SELECT created_at_ms FROM sms_registration_challenges
     WHERE phone = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC`,
  ).all(normalized, now - 60 * 60 * 1000) as Array<{ created_at_ms: number }>;
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

  const challengeId = `smsreg_${randomUUID()}`;
  const expiresAtMs = now + SMS_CHALLENGE_TTL_MS;
  getDB().prepare(
    `INSERT INTO sms_registration_challenges
       (id, organization_id, phone, code_hash, expires_at_ms, attempts_remaining, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    challengeId,
    organizationId,
    normalized,
    passwordHash(code),
    expiresAtMs,
    SMS_CHALLENGE_MAX_ATTEMPTS,
    now,
  );
  logAudit('sms_registration_code_requested', null, 'SMS registration code requested', organizationId);
  return {
    ok: true,
    challengeId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    retryAfterSeconds: SMS_CHALLENGE_COOLDOWN_MS / 1000,
  };
}

export function discardSmsRegistrationChallenge(challengeId: string): void {
  if (!challengeId) return;
  getDB().prepare(
    'DELETE FROM sms_registration_challenges WHERE id = ? AND consumed_at_ms IS NULL',
  ).run(challengeId);
}

export type SmsRegistrationVerifyResult =
  | { ok: true; phone: string; organizationId: string }
  | {
      ok: false;
      reason: 'invalid' | 'expired' | 'locked' | 'used';
      attemptsRemaining: number;
    };

export function verifySmsRegistrationChallenge(
  challengeId: string,
  code: string,
  now = Date.now(),
): SmsRegistrationVerifyResult {
  const row = getDB().prepare(
    `SELECT organization_id, phone, code_hash, expires_at_ms, attempts_remaining, consumed_at_ms
     FROM sms_registration_challenges WHERE id = ?`,
  ).get(challengeId) as {
    organization_id: string;
    phone: string;
    code_hash: string;
    expires_at_ms: number;
    attempts_remaining: number;
    consumed_at_ms: number | null;
  } | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (now > row.expires_at_ms) {
    getDB().prepare(
      'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
    ).run(now, challengeId);
    return { ok: false, reason: 'expired', attemptsRemaining: row.attempts_remaining };
  }
  if (!passwordMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    getDB().prepare(
      `UPDATE sms_registration_challenges
       SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
       WHERE id = ?`,
    ).run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  getDB().prepare(
    'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
  ).run(now, challengeId);
  logAudit('sms_registration_verified', null, 'SMS registration verified', row.organization_id);
  return { ok: true, phone: row.phone, organizationId: row.organization_id };
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
     WHERE a.organization_id = ? AND t.organization_id = ?
       AND a.status = 'active' AND t.tag IN (${placeholders})
     GROUP BY a.id
     HAVING COUNT(DISTINCT t.tag) = ?
     ORDER BY a.name, a.username`,
  ).all(
    creator.organizationId,
    creator.organizationId,
    ...targetTags,
    targetTags.length,
  ) as AccountRow[]).map(toAccountView);

  const id = `ticket_${randomUUID()}`;
  getDB().prepare(
    `INSERT INTO it_tickets
       (id, organization_id, created_by_account_id, title, description, target_tags)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, creator.organizationId, creator.id, title, description, JSON.stringify(targetTags));
  const deliver = getDB().prepare(
    `INSERT INTO ticket_deliveries (organization_id, ticket_id, account_id)
     VALUES (?, ?, ?)`,
  );
  for (const recipient of recipients) deliver.run(creator.organizationId, id, recipient.id);
  logAudit(
    'ticket_create',
    creator.employeeId,
    `Ticket ${id} delivered to ${recipients.length} account(s)`,
    creator.organizationId,
  );
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
     WHERE d.account_id = ? AND d.organization_id = t.organization_id
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
// Provider-reported Token usage (client_reported, idempotent)
// ============================================================

export interface AccountTokenUsageView {
  accountId: string;
  name: string;
  username: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface OrganizationUsageSummary {
  organizationId: string;
  periodDays: number;
  source: 'client_reported';
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  requestCount: number;
  byAccount: AccountTokenUsageView[];
}

function normalizeReportedTokenCount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Token 用量必须是非负数字');
  return Math.min(1_000_000_000, Math.floor(number));
}

export function recordTokenUsage(input: {
  accountId: string;
  sessionId: string;
  messageId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): boolean {
  const account = getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  const sessionId = input.sessionId.trim().slice(0, 160);
  const messageId = input.messageId.trim().slice(0, 160);
  if (!sessionId || !messageId) throw new Error('sessionId and messageId required');
  const inputTokens = normalizeReportedTokenCount(input.inputTokens);
  const outputTokens = normalizeReportedTokenCount(input.outputTokens);
  const totalTokens = Math.max(
    normalizeReportedTokenCount(input.totalTokens),
    inputTokens + outputTokens,
  );
  const result = getDB().prepare(
    `INSERT OR IGNORE INTO account_token_usage
       (id, organization_id, account_id, session_id, message_id, model,
        input_tokens, output_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `usage_${randomUUID()}`,
    account.organizationId,
    account.id,
    sessionId,
    messageId,
    input.model?.trim().slice(0, 120) || null,
    inputTokens,
    outputTokens,
    totalTokens,
  ) as { changes?: number | bigint };
  return Number(result.changes ?? 0) > 0;
}

export function getOrganizationUsageSummary(
  organizationId: string,
  periodDays = 30,
): OrganizationUsageSummary {
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const safePeriodDays = Math.min(365, Math.max(1, Math.floor(periodDays) || 30));
  const since = new Date(Date.now() - safePeriodDays * 86_400_000).toISOString();
  const rows = getDB().prepare(
    `SELECT a.id AS account_id, a.name, a.username,
            COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
            COUNT(u.id) AS request_count,
            MAX(u.created_at) AS last_used_at
     FROM accounts a
     LEFT JOIN account_token_usage u
       ON u.account_id = a.id
      AND u.organization_id = a.organization_id
      AND u.created_at >= ?
     WHERE a.organization_id = ?
     GROUP BY a.id, a.name, a.username
     ORDER BY total_tokens DESC, a.name, a.username`,
  ).all(since, organizationId) as Array<{
    account_id: string;
    name: string;
    username: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    request_count: number;
    last_used_at: string | null;
  }>;
  const byAccount = rows.map((row) => ({
    accountId: row.account_id,
    name: row.name,
    username: row.username,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    requestCount: Number(row.request_count),
    lastUsedAt: row.last_used_at,
  }));
  return {
    organizationId,
    periodDays: safePeriodDays,
    source: 'client_reported',
    totalInputTokens: byAccount.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: byAccount.reduce((sum, row) => sum + row.outputTokens, 0),
    totalTokens: byAccount.reduce((sum, row) => sum + row.totalTokens, 0),
    requestCount: byAccount.reduce((sum, row) => sum + row.requestCount, 0),
    byAccount,
  };
}

// ============================================================
// Employee operations
// ============================================================
export function createEmployee(emp: {
  id: string; name: string; role?: string;
  department?: string; invite_code?: string; personality?: string;
  organizationId?: string;
}): void {
  const organizationId = emp.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  getDB().prepare(
    `INSERT INTO employees
       (id, organization_id, name, role, department, invite_code, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    emp.id,
    organizationId,
    emp.name,
    emp.role || null,
    emp.department || null,
    emp.invite_code || null,
    emp.personality || null,
  );
  logAudit(
    'onboard',
    emp.id,
    `Employee ${emp.name} onboarded to ${emp.department || 'unassigned'}`,
    organizationId,
  );
}

export function getEmployee(id: string, organizationId?: string): any | null {
  // 1. 先查 SQLite（B套本地数据）
  const local = organizationId
    ? getDB().prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?').get(id, organizationId)
    : getDB().prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (local) return local;

  // 2. 降级查 OrgMemoryStore（A套飞书同步数据）
  // A 套历史数据没有租户字段，只能视为默认企业；绝不能并入其他企业。
  if (organizationId && organizationId !== DEFAULT_ORGANIZATION_ID) return null;
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

export function listEmployees(
  department?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  // 1. 先查 SQLite
  let local: any[];
  if (department) {
    local = getDB().prepare(
      `SELECT * FROM employees
       WHERE organization_id = ? AND department = ? AND status = ? ORDER BY onboarded_at`,
    ).all(organizationId, department, 'active');
  } else {
    local = getDB().prepare(
      'SELECT * FROM employees WHERE organization_id = ? AND status = ? ORDER BY onboarded_at',
    ).all(organizationId, 'active');
  }

  // 2. 合并 OrgMemoryStore 的飞书同步数据（去重）
  if (organizationId !== DEFAULT_ORGANIZATION_ID) return local;
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

export function offboardEmployee(id: string, organizationId?: string): boolean {
  const employee = getEmployee(id, organizationId);
  if (!employee || !employee.organization_id) return false;
  const result = getDB().prepare(
    `UPDATE employees SET status = ?, offboarded_at = datetime('now')
     WHERE id = ? AND organization_id = ?`,
  ).run('offboarded', id, employee.organization_id) as { changes?: number | bigint };
  const changed = Number(result.changes ?? 0) > 0;
  if (changed) logAudit('offboard', id, 'Employee offboarded', employee.organization_id);
  return changed;
}

// ============================================================
// Task logging
// ============================================================
export function logTask(task: {
  employee_id: string; task_type: string; context?: string;
  result?: string; duration_min?: number; tokens_used?: number; cost_cny?: number;
}): void {
  const employee = getDB().prepare(
    'SELECT organization_id FROM employees WHERE id = ?',
  ).get(task.employee_id) as { organization_id: string } | undefined;
  if (!employee) throw new Error('Employee not found');
  // 成本/token 口径归一：显式上报 0 或非正值时回落到默认估计，保证与 report 聚合口径一致，
  // 避免「多数任务 cost=0、少数有真实成本」时 totalCost 塌到极小、laborPerToken 爆表。
  const normalized = {
    ...task,
    tokens_used: normalizeTokens(task.tokens_used),
    cost_cny: normalizeCostCNY(task.cost_cny),
  };
  getDB().prepare(
    `INSERT INTO task_logs
       (organization_id, employee_id, task_type, context, result, duration_min, tokens_used, cost_cny)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
    ? getDB().prepare(
      `SELECT * FROM task_logs WHERE employee_id = ? AND organization_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(employeeId, organizationId, limit)
    : getDB().prepare(
      'SELECT * FROM task_logs WHERE employee_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(employeeId, limit);
}

// ============================================================
// Knowledge operations
// ============================================================
export function addKnowledge(k: {
  department?: string; category: string; content: string;
  contributor?: string; confidence?: number;
  organizationId?: string;
}): void {
  const organizationId = k.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  getDB().prepare(
    `INSERT INTO knowledge
       (organization_id, department, category, content, contributor, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    organizationId,
    k.department || null,
    k.category,
    k.content,
    k.contributor || null,
    k.confidence ?? 0.5,
  );
}

export function getKnowledge(
  department?: string,
  category?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: any[] = [organizationId];
  if (department) { sql += ' AND department = ?'; params.push(department); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY created_at DESC';
  return getDB().prepare(sql).all(...params);
}

export function searchKnowledge(
  query: string,
  department?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  // Match against both category (task_type is usually stored here, e.g. "contract_review")
  // and content (free-text description), otherwise knowledge tagged by category never
  // surfaces during recall when task_type doesn't literally appear in the Chinese content.
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ? AND (content LIKE ? OR category LIKE ?)';
  const params: any[] = [organizationId, `%${query}%`, `%${query}%`];
  if (department) { sql += ' AND department = ?'; params.push(department); }
  sql += ' ORDER BY confidence DESC LIMIT 20';
  return getDB().prepare(sql).all(...params);
}

// ============================================================
// Invite codes
// ============================================================
export function createInviteCode(
  department: string,
  createdBy?: string,
  maxUses = 1,
  organizationId = DEFAULT_ORGANIZATION_ID,
): string {
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const code = generateCode();
  getDB().prepare(
    `INSERT INTO invite_codes (code, organization_id, department, max_uses, created_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(code, organizationId, department, maxUses, createdBy || 'admin');
  logAudit('invite_create', null, `Code ${code} for ${department}`, organizationId);
  return code;
}

export function validateInviteCode(
  code: string,
  organizationId?: string,
): { valid: boolean; department?: string; organizationId?: string; error?: string } {
  const row: any = organizationId
    ? getDB().prepare(
      'SELECT * FROM invite_codes WHERE code = ? AND organization_id = ?',
    ).get(code, organizationId)
    : getDB().prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!row) return { valid: false, error: 'Invalid invite code' };
  if (row.used_count >= row.max_uses) return { valid: false, error: 'Invite code already used' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) return { valid: false, error: 'Invite code expired' };
  getDB().prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  return { valid: true, department: row.department, organizationId: row.organization_id };
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
    empFilter = ' AND employee_id IN (SELECT id FROM employees WHERE organization_id = ? AND department = ?)';
    params.push(organizationId, department);
  }

  const tasks: any[] = db.prepare(
    `SELECT * FROM task_logs WHERE created_at >= ? AND organization_id = ?${empFilter} ORDER BY created_at`,
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
export function logAudit(
  event: string,
  employeeId: string | null,
  detail: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): void {
  getDB().prepare(
    `INSERT INTO audit_logs (organization_id, event, employee_id, detail)
     VALUES (?, ?, ?, ?)`,
  ).run(organizationId, event, employeeId, detail);
}

export function getAuditLogs(limit = 50, organizationId = DEFAULT_ORGANIZATION_ID): any[] {
  return getDB().prepare(
    `SELECT * FROM audit_logs WHERE organization_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(organizationId, limit);
}

// ============================================================
// Export all (for backup)
// ============================================================
export function exportAll(organizationId = DEFAULT_ORGANIZATION_ID): any {
  return {
    // Full backup must include offboarded employees too, otherwise every
    // offboarding silently erases historical employee records from the
    // export — contradicting the "export ALL data" guarantee.
    employees: getDB().prepare(
      'SELECT * FROM employees WHERE organization_id = ? ORDER BY onboarded_at',
    ).all(organizationId),
    taskLogs: getDB().prepare(
      `SELECT * FROM task_logs WHERE organization_id = ?
       ORDER BY created_at DESC LIMIT 1000`,
    ).all(organizationId),
    knowledge: getKnowledge(undefined, undefined, organizationId),
    inviteCodes: getDB().prepare(
      'SELECT * FROM invite_codes WHERE organization_id = ?',
    ).all(organizationId),
    auditLogs: getAuditLogs(200, organizationId),
    // 账号导出不包含 password_hash / session token 摘要；备份可迁移组织信息，
    // 但不能把登录凭证扩散到普通数据导出文件。
    accounts: listAccounts(organizationId),
    accountTags: getDB().prepare(
      `SELECT account_id, tag, created_at FROM account_tags
       WHERE organization_id = ?`,
    ).all(organizationId),
    tickets: getDB().prepare(
      `SELECT * FROM it_tickets WHERE organization_id = ? ORDER BY created_at DESC`,
    ).all(organizationId),
    ticketDeliveries: getDB().prepare(
      `SELECT * FROM ticket_deliveries WHERE organization_id = ? ORDER BY delivered_at DESC`,
    ).all(organizationId),
  };
}
