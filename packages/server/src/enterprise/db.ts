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
  randomInt,
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
export const ENTERPRISE_SCHEMA_VERSION = 4;
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

const USAGE_DAILY_RECORD_LIMIT = Math.min(
  100_000,
  Math.max(1, Math.floor(envNum('OTTO_ENTERPRISE_USAGE_DAILY_LIMIT', 10_000))),
);

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

/** 释放当前企业数据库连接；服务关闭或隔离测试清理时调用。 */
export function closeEnterpriseDatabase(): void {
  if (!db) return;
  const database = db;
  db = null;
  database.close();
}

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

  const database = new Database(DB_PATH);
  try {
    const existingSchema = database.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined;
    const existingSchemaVersion = Number(existingSchema?.user_version ?? 0);
    if (
      Number.isInteger(existingSchemaVersion)
      && existingSchemaVersion > ENTERPRISE_SCHEMA_VERSION
    ) {
      throw new Error(
        `Enterprise database schema version ${existingSchemaVersion} is newer than `
        + `current version ${ENTERPRISE_SCHEMA_VERSION}; refusing downgrade`,
      );
    }
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    initSchema(database);
    db = database;
    return database;
  } catch (error) {
    // 迁移失败时绝不能把半初始化连接留在模块单例中；后续请求应重新执行完整初始化。
    try {
      database.close();
    } catch {
      // 保留原始迁移异常。
    }
    throw error;
  }
}

/** 执行真实读查询，供 HTTP readiness 判断数据库与 schema 是否可用。 */
export function getDatabaseReadiness(): { ready: true; schemaVersion: number } {
  const database = getDB();
  const probe = database.prepare('SELECT 1 AS ready').get() as { ready?: number } | undefined;
  if (probe?.ready !== 1) throw new Error('Enterprise database readiness probe failed');
  const schema = database.prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | undefined;
  const schemaVersion = Number(schema?.user_version);
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error('Enterprise database schema version is unavailable');
  }
  return { ready: true, schemaVersion };
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
      default_department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      default_role TEXT,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
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
      source_id TEXT,
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
      account_type TEXT NOT NULL DEFAULT 'enterprise',
      employee_id TEXT UNIQUE,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT,
      feishu_open_id TEXT,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      deleted_at TEXT,
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

    CREATE TABLE IF NOT EXISTS direct_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      sender_account_id TEXT NOT NULL,
      recipient_account_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation
      ON direct_messages(organization_id, sender_account_id, recipient_account_id, created_at);

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
      organization_invite_id TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      role TEXT,
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
      service_id TEXT NOT NULL DEFAULT 'repair',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tags TEXT NOT NULL,
      form_data TEXT,
      category TEXT,
      location TEXT,
      urgency TEXT,
      contact TEXT,
      contact_phone TEXT,
      response_type TEXT,
      response_text TEXT,
      response_at TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      closed_at TEXT,
      status TEXT NOT NULL DEFAULT '待接单',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS park_publications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('announcement', 'satisfaction')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS park_publication_recipients (
      organization_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      read_at TEXT,
      submitted_at TEXT,
      response_data TEXT,
      PRIMARY KEY (publication_id, account_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (publication_id) REFERENCES park_publications(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS ticket_notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      recipient_account_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('otto', 'sms', 'feishu')),
      event TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
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
    -- Otto Enterprise Credits System
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT 'org_default',
      account_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('topup','redeem','consume','refund')),
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      redeem_code_id TEXT,
      model TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (redeem_code_id) REFERENCES redeem_codes(id)
    );

    -- Enterprise Redeem Codes
    CREATE TABLE IF NOT EXISTS redeem_codes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL DEFAULT 'org_default',
      code TEXT NOT NULL UNIQUE,
      credit_amount INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','redeemed','revoked')),
      redeemed_by TEXT,
      redeemed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (created_by) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_credit_trans_org ON credit_transactions(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_redeem_codes_code ON redeem_codes(code);

    CREATE INDEX IF NOT EXISTS idx_ticket_deliveries_account ON ticket_deliveries(account_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_notifications_ticket
      ON ticket_notifications(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_park_publications_org_created
      ON park_publications(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_park_publication_recipients_account
      ON park_publication_recipients(account_id, publication_id);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_org_created
      ON account_token_usage(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_account_created
      ON account_token_usage(account_id, created_at);
  `);

  const organizationColumns = d.prepare(
    'PRAGMA table_info(organizations)',
  ).all() as Array<{ name: string }>;
  if (!organizationColumns.some((column) => column.name === 'credit_balance')) {
    d.exec('ALTER TABLE organizations ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0');
  }

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
  if (!accountColumns.some((column) => column.name === 'feishu_open_id')) {
    d.exec('ALTER TABLE accounts ADD COLUMN feishu_open_id TEXT');
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
    'ticket_notifications',
    'park_publications',
    'park_publication_recipients',
  ]) ensureOrganizationColumn(table);

  const ticketColumns = d.prepare('PRAGMA table_info(it_tickets)').all() as Array<{ name: string }>;
  const ensureTicketColumn = (name: string, definition = 'TEXT'): void => {
    if (!ticketColumns.some((column) => column.name === name)) {
      d.exec(`ALTER TABLE it_tickets ADD COLUMN ${name} ${definition}`);
    }
  };
  for (const name of [
    'service_id', 'form_data',
    'category', 'location', 'urgency', 'contact', 'contact_phone',
    'response_type', 'response_text', 'response_at', 'accepted_at',
    'completed_at', 'closed_at',
  ]) ensureTicketColumn(name);
  d.exec("UPDATE it_tickets SET service_id = 'repair' WHERE service_id IS NULL OR service_id = ''");
  d.exec("UPDATE it_tickets SET status = '待接单' WHERE status = 'open'");

  // 自动知识捕获需要跨进程重试幂等。必须在旧库补 organization_id 之后建组织级索引，
  // 否则最早期的单组织 knowledge 表会因缺少该列而无法启动迁移。
  const knowledgeColumns = d.prepare('PRAGMA table_info(knowledge)').all() as Array<{ name: string }>;
  if (!knowledgeColumns.some((column) => column.name === 'source_id')) {
    d.exec('ALTER TABLE knowledge ADD COLUMN source_id TEXT');
  }
  const ensureTextColumn = (table: string, column: string): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  };
  ensureTextColumn('organization_invites', 'default_department');
  ensureTextColumn('organization_invites', 'department_id');
  ensureTextColumn('organization_invites', 'position_id');
  ensureTextColumn('organization_invites', 'position_title');
  ensureTextColumn('organization_invites', 'default_role');
  ensureTextColumn('sms_registration_challenges', 'department');
  ensureTextColumn('sms_registration_challenges', 'organization_invite_id');
  ensureTextColumn('sms_registration_challenges', 'department_id');
  ensureTextColumn('sms_registration_challenges', 'position_id');
  ensureTextColumn('sms_registration_challenges', 'position_title');
  ensureTextColumn('sms_registration_challenges', 'role');
  ensureTextColumn('accounts', 'position_id');
  ensureTextColumn('accounts', 'position_title');
  ensureTextColumn('accounts', 'department_id');
  ensureTextColumn('accounts', 'avatar_url');
  ensureTextColumn('employees', 'department_id');
  ensureTextColumn('employees', 'position_id');
  ensureTextColumn('employees', 'position_title');
  ensureTextColumn('accounts', 'account_type');
  ensureTextColumn('accounts', 'deleted_at');
  d.exec("UPDATE accounts SET account_type = 'enterprise' WHERE account_type IS NULL");
  backfillEnterpriseAccountEmployees(d);
  const ensureIntegerColumn = (table: string, column: string, ddl: string): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  ensureIntegerColumn('organization_invites', 'max_uses', 'INTEGER');
  ensureIntegerColumn('organization_invites', 'used_count', 'INTEGER NOT NULL DEFAULT 0');
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_unique
      ON knowledge(organization_id, source_id) WHERE source_id IS NOT NULL;
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_organization ON accounts(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_employees_organization ON employees(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_organization ON task_logs(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_organization ON knowledge(organization_id, department);
    CREATE INDEX IF NOT EXISTS idx_audit_organization ON audit_logs(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_accounts_feishu_open_id
      ON accounts(organization_id, feishu_open_id) WHERE feishu_open_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ticket_notifications_recipient
      ON ticket_notifications(recipient_account_id, created_at);
    PRAGMA user_version = ${ENTERPRISE_SCHEMA_VERSION};
  `);
}

/**
 * v4 之前的邀请码注册可能只创建了账号，或只把岗位写进 accounts。这里每次启动
 * 幂等对账，既修复已跑过早期 v4 的库，也不要求管理员手工重做员工档案。
 */
function backfillEnterpriseAccountEmployees(d: Database): void {
  interface MigrationAccountRow {
    id: string;
    organization_id: string;
    employee_id: string | null;
    name: string;
    role: string | null;
    department: string | null;
    department_id: string | null;
    position_id: string | null;
    position_title: string | null;
    status: 'active' | 'disabled';
    created_at: string;
  }
  interface MigrationEmployeeRow {
    id: string;
    organization_id: string;
  }

  const accounts = d.prepare(
    `SELECT id, organization_id, employee_id, name, role, department, department_id,
            position_id, position_title, status, created_at
     FROM accounts
     WHERE account_type = 'enterprise' AND deleted_at IS NULL`,
  ).all() as MigrationAccountRow[];
  const findEmployee = d.prepare(
    'SELECT id, organization_id FROM employees WHERE id = ?',
  );
  const insertEmployee = d.prepare(
    `INSERT INTO employees
       (id, organization_id, name, role, department, department_id, position_id,
        position_title, status, onboarded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const bindAccount = d.prepare(
    'UPDATE accounts SET employee_id = ? WHERE id = ? AND organization_id = ?',
  );
  const syncAccountAssignments = d.prepare(
    `UPDATE accounts SET department_id = ?, position_id = ?
     WHERE id = ? AND organization_id = ?`,
  );
  const syncEmployee = d.prepare(
    `UPDATE employees
     SET name = ?,
         role = COALESCE(?, role),
         department = COALESCE(?, department),
         department_id = COALESCE(?, department_id),
         position_id = COALESCE(?, position_id),
         position_title = COALESCE(?, position_title)
     WHERE id = ? AND organization_id = ?`,
  );
  const syncAccount = d.prepare(
    `UPDATE accounts
     SET role = COALESCE(role, (SELECT role FROM employees WHERE id = ?)),
         department = COALESCE(department, (SELECT department FROM employees WHERE id = ?)),
         department_id = COALESCE(
           department_id,
           (SELECT department_id FROM employees WHERE id = ?)
         ),
         position_id = COALESCE(position_id, (SELECT position_id FROM employees WHERE id = ?)),
         position_title = COALESCE(
           position_title,
           (SELECT position_title FROM employees WHERE id = ?)
         )
     WHERE id = ? AND organization_id = ?`,
  );

  d.exec('SAVEPOINT backfill_enterprise_account_employees');
  try {
    for (const account of accounts) {
      const departmentId = account.department_id
        ?? (account.department
          ? stableAssignmentId(
              'dept',
              account.organization_id,
              normalizeAssignmentName(account.department),
            )
          : null);
      const positionId = account.position_id
        ?? (account.position_title
          ? stableAssignmentId(
              'pos',
              account.organization_id,
              departmentId,
              normalizeAssignmentName(account.position_title),
            )
          : null);
      if (
        departmentId !== account.department_id
        || positionId !== account.position_id
      ) {
        syncAccountAssignments.run(
          departmentId,
          positionId,
          account.id,
          account.organization_id,
        );
        account.department_id = departmentId;
        account.position_id = positionId;
      }
      const linked = account.employee_id
        ? findEmployee.get(account.employee_id) as MigrationEmployeeRow | undefined
        : undefined;
      let employeeId = linked?.organization_id === account.organization_id
        ? linked.id
        : null;
      if (!employeeId) {
        employeeId = `emp_${randomUUID()}`;
        insertEmployee.run(
          employeeId,
          account.organization_id,
          account.name,
          account.role,
          account.department,
          account.department_id,
          account.position_id,
          account.position_title,
          account.status === 'active' ? 'active' : 'offboarded',
          account.created_at,
        );
        bindAccount.run(employeeId, account.id, account.organization_id);
      }
      syncEmployee.run(
        account.name,
        account.role,
        account.department,
        account.department_id,
        account.position_id,
        account.position_title,
        employeeId,
        account.organization_id,
      );
      syncAccount.run(
        employeeId,
        employeeId,
        employeeId,
        employeeId,
        employeeId,
        account.id,
        account.organization_id,
      );
    }
    d.exec('RELEASE SAVEPOINT backfill_enterprise_account_employees');
  } catch (error) {
    d.exec('ROLLBACK TO SAVEPOINT backfill_enterprise_account_employees');
    d.exec('RELEASE SAVEPOINT backfill_enterprise_account_employees');
    throw error;
  }
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
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
  maxUses: number | null;
  usedCount: number;
  issuedAt: string;
  expiresAt: string;
  validHours: 168;
}

interface OrganizationInviteRow {
  id: string;
  organization_id: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  default_department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  default_role: string | null;
  max_uses: number | null;
  used_count: number;
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

/**
 * 平台管理只列出真实企业租户。普通注册也会创建 organization 作为个人数据
 * 隔离容器，不能把这些个人空间混入平台企业清单。
 */
export function listEnterpriseOrganizations(): OrganizationView[] {
  return (getDB().prepare(
    `SELECT o.*
     FROM organizations o
     WHERE EXISTS (
       SELECT 1
       FROM accounts a
       WHERE a.organization_id = o.id
         AND a.account_type = 'enterprise'
         AND a.deleted_at IS NULL
     )
     ORDER BY o.name, o.slug`,
  ).all() as OrganizationRow[]).map(toOrganizationView);
}

/** 平台企业面板只能访问企业租户，个人空间按不存在处理。 */
export function getEnterpriseOrganization(id: string): OrganizationView | null {
  const row = getDB().prepare(
    `SELECT o.*
     FROM organizations o
     WHERE o.id = ?
       AND EXISTS (
         SELECT 1
         FROM accounts a
         WHERE a.organization_id = o.id
           AND a.account_type = 'enterprise'
           AND a.deleted_at IS NULL
       )
     LIMIT 1`,
  ).get(id) as OrganizationRow | undefined;
  return row ? toOrganizationView(row) : null;
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
    defaultDepartment: row.default_department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    defaultRole: row.default_role,
    maxUses: row.max_uses,
    usedCount: row.used_count ?? 0,
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

  // 邀请码由 nonce 动态派生，库中没有可直接索引的明文 code；必须保留已撤销/
  // 已过期记录，公开落地页才能正确区分 404 与 410。先在 SQL 层排除已停用企业，
  // 再恒定时间比对候选 code，不能引用 organization_invites 中不存在的 status 列。
  const rows = getDB().prepare(
    `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE o.status = 'active'
     ORDER BY i.issued_at_ms DESC`,
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
  if (match.max_uses != null && match.used_count >= match.max_uses) {
    return { status: 'revoked', organizationId: match.organization_id };
  }
  return { status: 'active', organizationId: match.organization_id };
}

export interface OrganizationInviteIssueInput {
  defaultDepartment?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  defaultRole?: string | null;
  maxUses?: number | null;
}

function normalizeOptionalText(value: string | null | undefined, label: string, maxLength = 80): string | null {
  const clean = value?.trim() || null;
  if (clean && clean.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return clean;
}

function normalizeAssignmentName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

function stableAssignmentId(
  prefix: 'dept' | 'pos',
  organizationId: string,
  ...parts: Array<string | null>
): string {
  const digest = createHash('sha256')
    .update([organizationId, ...parts.map((part) => part ?? '')].join('\0'))
    .digest('hex')
    .slice(0, 20);
  return `${prefix}_${digest}`;
}

interface AssignmentIdentity {
  department: string | null;
  departmentId: string | null;
  positionTitle: string | null;
  positionId: string | null;
}

/**
 * 中心企业服务没有另一套“只存在于前端”的组织节点。部门/职位显示名与 ID 在
 * 这里成对归一：已有真实 ID 会复用；旧调用方只传显示名时生成稳定租户内 ID。
 * 同一 ID 不允许在同一企业中指向不同名称，避免邀请码把员工挂到伪造节点。
 */
function resolveAssignmentIdentity(
  database: Database,
  organizationId: string,
  input: {
    department?: string | null;
    departmentId?: string | null;
    positionTitle?: string | null;
    positionId?: string | null;
  },
): AssignmentIdentity {
  const department = normalizeOptionalText(input.department, '部门名称');
  const requestedDepartmentId = normalizeOptionalText(input.departmentId, '部门 ID', 120);
  const positionTitle = normalizeOptionalText(input.positionTitle, '职位名称');
  const requestedPositionId = normalizeOptionalText(input.positionId, '职位 ID', 120);
  if (!department && requestedDepartmentId) throw new Error('设置部门 ID 时必须同时提供部门名称');
  if (!positionTitle && requestedPositionId) throw new Error('设置职位 ID 时必须同时提供职位名称');

  const departmentRows = database.prepare(
    `SELECT department_id AS id, department AS name FROM accounts
       WHERE organization_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT department_id AS id, department AS name FROM employees
       WHERE organization_id = ?
     UNION ALL
     SELECT department_id AS id, default_department AS name FROM organization_invites
       WHERE organization_id = ?`,
  ).all(organizationId, organizationId, organizationId) as Array<{
    id: string | null;
    name: string | null;
  }>;
  const normalizedDepartment = department ? normalizeAssignmentName(department) : null;
  const existingDepartment = normalizedDepartment
    ? departmentRows.find((row) => (
        row.id
        && row.name
        && normalizeAssignmentName(row.name) === normalizedDepartment
      ))
    : undefined;
  if (
    requestedDepartmentId
    && existingDepartment?.id
    && existingDepartment.id !== requestedDepartmentId
  ) {
    throw new Error('该部门名称已绑定其他部门 ID');
  }
  if (requestedDepartmentId) {
    const conflicting = departmentRows.find((row) => (
      row.id === requestedDepartmentId
      && row.name
      && normalizeAssignmentName(row.name) !== normalizedDepartment
    ));
    if (conflicting) throw new Error('该部门 ID 已绑定其他部门名称');
  }
  const departmentId = department
    ? requestedDepartmentId
      ?? existingDepartment?.id
      ?? stableAssignmentId('dept', organizationId, normalizedDepartment)
    : null;

  const positionRows = database.prepare(
    `SELECT position_id AS id, position_title AS title, department_id
       FROM accounts WHERE organization_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT position_id AS id, position_title AS title, department_id
       FROM employees WHERE organization_id = ?
     UNION ALL
     SELECT position_id AS id, position_title AS title, department_id
       FROM organization_invites WHERE organization_id = ?`,
  ).all(organizationId, organizationId, organizationId) as Array<{
    id: string | null;
    title: string | null;
    department_id: string | null;
  }>;
  const normalizedPosition = positionTitle ? normalizeAssignmentName(positionTitle) : null;
  const existingPosition = normalizedPosition
    ? positionRows.find((row) => (
        row.id
        && row.title
        && row.department_id === departmentId
        && normalizeAssignmentName(row.title) === normalizedPosition
      ))
    : undefined;
  if (
    requestedPositionId
    && existingPosition?.id
    && existingPosition.id !== requestedPositionId
  ) {
    throw new Error('该职位名称已绑定其他职位 ID');
  }
  if (requestedPositionId) {
    const conflicting = positionRows.find((row) => (
      row.id === requestedPositionId
      && (
        row.department_id !== departmentId
        || !row.title
        || normalizeAssignmentName(row.title) !== normalizedPosition
      )
    ));
    if (conflicting) throw new Error('该职位 ID 已绑定其他部门或职位名称');
  }
  const positionId = positionTitle
    ? requestedPositionId
      ?? existingPosition?.id
      ?? stableAssignmentId('pos', organizationId, departmentId, normalizedPosition)
    : null;

  return { department, departmentId, positionTitle, positionId };
}

export function issueOrganizationInvite(
  organizationId: string,
  now = Date.now(),
  createdByAccountId?: string | null,
  input?: string | OrganizationInviteIssueInput | null,
): OrganizationInviteView {
  const database = getDB();
  database.exec('SAVEPOINT issue_organization_invite');
  try {
    const organization = database.prepare(
      'SELECT * FROM organizations WHERE id = ? AND status = ?',
    ).get(organizationId, 'active') as OrganizationRow | undefined;
    if (!organization) throw new Error('Organization not found');
    const id = `orginvite_${randomUUID()}`;
    const nonce = randomBytes(24).toString('base64url');
    const expiresAtMs = now + ORGANIZATION_INVITE_VALIDITY_MS;
    const options = typeof input === 'string' ? { defaultDepartment: input } : input ?? {};
    const assignment = resolveAssignmentIdentity(database, organizationId, {
      department: options.defaultDepartment,
      departmentId: options.departmentId,
      positionId: options.positionId,
      positionTitle: options.positionTitle,
    });
    const defaultRole = normalizeOptionalText(options.defaultRole, '角色');
    const maxUses = options.maxUses == null ? null : Math.floor(Number(options.maxUses));
    if (maxUses != null && (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 10_000)) {
      throw new Error('邀请码可注册人数必须在 1 到 10000 之间');
    }
    database.prepare(
      `INSERT INTO organization_invites
         (id, organization_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id,
          default_department, department_id, position_id, position_title, default_role, max_uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      organizationId,
      nonce,
      now,
      expiresAtMs,
      createdByAccountId || null,
      assignment.department,
      assignment.departmentId,
      assignment.positionId,
      assignment.positionTitle,
      defaultRole,
      maxUses,
    );
    database.prepare(
      `UPDATE organization_invites SET revoked_at_ms = ?
       WHERE organization_id = ? AND id <> ? AND revoked_at_ms IS NULL`,
    ).run(now, organizationId, id);
    logAudit(
      'organization_invite_issue',
      null,
      [assignment.department, assignment.positionTitle, defaultRole].filter(Boolean).length
        ? `Position invite issued for ${[
          assignment.department,
          assignment.positionTitle,
          defaultRole,
        ].filter(Boolean).join(' / ')}`
        : 'Registration invite issued for 7 days',
      organizationId,
    );
    const row = database.prepare(
      'SELECT * FROM organization_invites WHERE id = ?',
    ).get(id) as OrganizationInviteRow;
    database.exec('RELEASE SAVEPOINT issue_organization_invite');
    return toOrganizationInviteView(row, organization, now);
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT issue_organization_invite');
    database.exec('RELEASE SAVEPOINT issue_organization_invite');
    throw error;
  }
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

export interface OrganizationInviteResolution {
  organization: OrganizationView;
  inviteId: string;
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
}

export function resolveOrganizationInviteWithDefaults(
  code: string,
  now = Date.now(),
): OrganizationInviteResolution | null {
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
  if (match.max_uses != null && match.used_count >= match.max_uses) return null;
  return {
    organization: toOrganizationView({
      id: match.organization_id,
      name: match.name,
      slug: match.slug,
      invite_secret: match.invite_secret,
      status: match.status,
      created_at: match.created_at,
      updated_at: match.updated_at,
    }),
    inviteId: match.id,
    defaultDepartment: match.default_department ?? null,
    departmentId: match.department_id ?? null,
    positionId: match.position_id ?? null,
    positionTitle: match.position_title ?? null,
    defaultRole: match.default_role ?? null,
  };
}

export function resolveOrganizationInvite(code: string, now = Date.now()): OrganizationView | null {
  return resolveOrganizationInviteWithDefaults(code, now)?.organization ?? null;
}

// ============================================================
// Preset accounts, tags and sessions
// ============================================================

export interface AccountView {
  id: string;
  organizationId: string;
  organizationName: string;
  accountType: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  phone: string | null;
  feishuOpenId: string | null;
  name: string;
  role: string | null;
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  id: string;
  organization_id: string;
  account_type: 'personal' | 'enterprise' | null;
  employee_id: string | null;
  username: string;
  phone: string | null;
  feishu_open_id: string | null;
  password_hash: string;
  name: string;
  role: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  avatar_url: string | null;
  is_admin: number;
  status: 'active' | 'disabled';
  deleted_at: string | null;
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

function normalizeOptionalFeishuOpenId(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const openId = value.trim();
  if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) throw new Error('飞书 open_id 格式不正确');
  return openId;
}

function normalizeOptionalAvatarUrl(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const avatarUrl = value.trim();
  if (/^https:\/\//i.test(avatarUrl)) {
    if (avatarUrl.length > 2_000) throw new Error('头像地址不能超过 2000 个字符');
    try {
      if (new URL(avatarUrl).protocol !== 'https:') throw new Error();
    } catch {
      throw new Error('头像地址格式不正确');
    }
    return avatarUrl;
  }
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(avatarUrl);
  if (!match) throw new Error('头像仅支持 HTTPS 或 PNG、JPEG、WebP、GIF 格式的 data:image');
  if (avatarUrl.length > 700_000 || Buffer.from(match[2]!, 'base64').byteLength > 512 * 1024) {
    throw new Error('头像数据不能超过 512KB');
  }
  return avatarUrl;
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

function assertAccountPassword(password: string): void {
  if (password.length < 8) throw new Error('登录密码至少需要 8 位');
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
    accountType: row.account_type === 'personal' ? 'personal' : 'enterprise',
    employeeId: row.employee_id,
    username: row.username,
    phone: row.phone,
    feishuOpenId: row.feishu_open_id,
    name: row.name,
    role: row.role,
    department: row.department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    avatarUrl: row.avatar_url,
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
  accountType?: 'personal' | 'enterprise';
  username: string;
  password: string;
  name: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  employeeId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}): AccountView {
  const organizationId = input.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const username = normalizeUsername(input.username);
  const name = input.name.trim();
  if (!username || !name || !input.password) throw new Error('username, password and name required');
  assertAccountPassword(input.password);
  const status = input.status ?? 'active';
  if (status !== 'active' && status !== 'disabled') {
    throw new Error('账号状态必须是 active 或 disabled');
  }
  const database = getDB();
  const accountType = input.accountType ?? 'enterprise';
  const assignment = resolveAssignmentIdentity(database, organizationId, {
    department: input.department,
    departmentId: input.departmentId,
    positionId: input.positionId,
    positionTitle: input.positionTitle,
  });
  const id = `acc_${randomUUID()}`;
  let employeeId = input.employeeId || null;
  database.exec('SAVEPOINT create_account');
  try {
    if (accountType === 'enterprise' && !employeeId) {
      employeeId = `emp_${randomUUID()}`;
      createEmployee({
        id: employeeId,
        organizationId,
        name,
        role: input.role?.trim() || undefined,
        department: assignment.department || undefined,
        departmentId: assignment.departmentId || undefined,
        positionId: assignment.positionId || undefined,
        positionTitle: assignment.positionTitle || undefined,
      });
    }
    database.prepare(
    `INSERT INTO accounts
       (id, organization_id, account_type, employee_id, username, phone, feishu_open_id, password_hash,
        name, role, department, department_id, position_id, position_title, avatar_url, is_admin, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      organizationId,
      accountType,
      employeeId,
      username,
      normalizeOptionalPhone(input.phone),
      normalizeOptionalFeishuOpenId(input.feishuOpenId),
      passwordHash(input.password),
      name,
      input.role?.trim() || null,
      assignment.department,
      assignment.departmentId,
      assignment.positionId,
      assignment.positionTitle,
      normalizeOptionalAvatarUrl(input.avatarUrl),
      input.isAdmin ? 1 : 0,
      status,
    );
    replaceAccountTags(id, organizationId, input.tags ?? []);
    logAudit('account_create', employeeId, `Preset account ${username} created`, organizationId);
    const created = getAccount(id, organizationId);
    if (!created) throw new Error('账号创建失败');
    database.exec('RELEASE SAVEPOINT create_account');
    return created;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT create_account');
    database.exec('RELEASE SAVEPOINT create_account');
    if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
      throw new Error('手机号已绑定其他账号');
    }
    throw error;
  }
}

/**
 * 平台开户的唯一写入口：企业、首位管理员和首个 7 天邀请要么全部成功，
 * 要么全部回滚，避免账号冲突或邀请失败后留下不可管理的孤儿企业。
 */
export function provisionOrganization(input: {
  name: string;
  slug?: string;
  admin: {
    username: string;
    password: string;
    name: string;
    phone?: string | null;
  };
  now?: number;
}): {
  organization: OrganizationView;
  admin: AccountView;
  invite: OrganizationInviteView;
} {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = createOrganization({
      name: input.name,
      slug: input.slug,
      now: input.now,
    });
    const admin = createAccount({
      organizationId: organization.id,
      username: input.admin.username,
      password: input.admin.password,
      name: input.admin.name,
      phone: input.admin.phone,
      role: '企业管理员',
      tags: ['企业管理员'],
      isAdmin: true,
    });
    const invite = issueOrganizationInvite(organization.id, input.now ?? Date.now(), admin.id);
    database.exec('COMMIT');
    return { organization, admin, invite };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getAccount(id: string, organizationId?: string): AccountView | null {
  const row = (organizationId
    ? getDB().prepare(
      'SELECT * FROM accounts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    ).get(id, organizationId)
    : getDB().prepare('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL').get(id)
  ) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function listAccounts(organizationId = DEFAULT_ORGANIZATION_ID): AccountView[] {
  return (getDB().prepare(
    'SELECT * FROM accounts WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name, username',
  ).all(organizationId) as AccountRow[])
    .map(toAccountView);
}

export interface DirectMessageView {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface AtoaInboxMessageView extends DirectMessageView {
  peerAccountId: string;
}

interface DirectMessageRow {
  id: string;
  sender_account_id: string;
  recipient_account_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
}

function toDirectMessageView(row: DirectMessageRow): DirectMessageView {
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    recipientAccountId: row.recipient_account_id,
    content: row.content,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function sendDirectMessage(input: {
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
}): DirectMessageView {
  const content = input.content.trim();
  if (!content || content.length > 4000) throw new Error('消息内容长度必须为 1 到 4000 个字符');
  if (input.senderAccountId === input.recipientAccountId) throw new Error('不能给自己发送消息');
  const recipient = getAccount(input.recipientAccountId, input.organizationId);
  if (!recipient || recipient.status !== 'active') throw new Error('接收成员不存在或已停用');
  const id = randomUUID();
  getDB().prepare(
    `INSERT INTO direct_messages
      (id, organization_id, sender_account_id, recipient_account_id, content)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.organizationId, input.senderAccountId, input.recipientAccountId, content);
  const row = getDB().prepare('SELECT * FROM direct_messages WHERE id = ?').get(id) as DirectMessageRow;
  return toDirectMessageView(row);
}

export function listDirectMessages(input: {
  organizationId: string;
  accountId: string;
  peerAccountId: string;
  limit?: number;
}): DirectMessageView[] {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 100)));
  getDB().prepare(
    `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE organization_id = ? AND sender_account_id = ? AND recipient_account_id = ?`,
  ).run(input.organizationId, input.peerAccountId, input.accountId);
  return (getDB().prepare(
    `SELECT * FROM direct_messages
     WHERE organization_id = ? AND (
       (sender_account_id = ? AND recipient_account_id = ?) OR
       (sender_account_id = ? AND recipient_account_id = ?)
     ) ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(
    input.organizationId,
    input.accountId,
    input.peerAccountId,
    input.peerAccountId,
    input.accountId,
    limit,
  ) as DirectMessageRow[]).reverse().map(toDirectMessageView);
}

export function listPendingAtoaRequests(input: {
  organizationId: string;
  accountId: string;
  requestPrefix: string;
  responsePrefix: string;
  limit?: number;
}): AtoaInboxMessageView[] {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const requests = getDB().prepare(
    `SELECT * FROM direct_messages
     WHERE organization_id = ?
       AND recipient_account_id = ?
       AND content LIKE ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  ).all(
    input.organizationId,
    input.accountId,
    `${input.requestPrefix}%`,
    limit,
  ) as DirectMessageRow[];
  const responses = getDB().prepare(
    `SELECT sender_account_id, recipient_account_id, content FROM direct_messages
     WHERE organization_id = ?
       AND sender_account_id = ?
       AND content LIKE ?
     ORDER BY created_at DESC, id DESC
     LIMIT 300`,
  ).all(
    input.organizationId,
    input.accountId,
    `${input.responsePrefix}%`,
  ) as Array<{
    sender_account_id: string;
    recipient_account_id: string;
    content: string;
  }>;
  return requests
    .filter((request) => !responses.some((response) => (
      response.sender_account_id === input.accountId &&
      response.recipient_account_id === request.sender_account_id &&
      parseAtoaResponseRequestId(response.content, input.responsePrefix) === request.id
    )))
    .reverse()
    .map((request) => ({
      ...toDirectMessageView(request),
      peerAccountId: request.sender_account_id,
    }));
}

const ATOA_RESPONSE_SOURCES = new Set([
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
]);

function isAtoaResponseText(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function parseAtoaResponseRequestId(
  content: string,
  responsePrefix: string,
): string | null {
  if (!content.startsWith(responsePrefix)) return null;
  try {
    const parsed = JSON.parse(content.slice(responsePrefix.length)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const response = parsed as Record<string, unknown>;
    const mode = response.mode === undefined ? 'answer' : response.mode;
    const sources = response.grantedSources === undefined
      ? []
      : response.grantedSources;
    if (
      response.v !== 1 ||
      !isAtoaResponseText(response.requestId, 200) ||
      !isAtoaResponseText(response.question, 1200) ||
      !isAtoaResponseText(response.answer, 2400) ||
      !isAtoaResponseText(response.createdAt, 64) ||
      !Number.isFinite(Date.parse(response.createdAt)) ||
      (mode !== 'answer' && mode !== 'consult') ||
      !Array.isArray(sources) ||
      sources.length > ATOA_RESPONSE_SOURCES.size ||
      sources.some(
        (source) =>
          typeof source !== 'string' || !ATOA_RESPONSE_SOURCES.has(source),
      )
    ) {
      return null;
    }
    return response.requestId;
  } catch {
    return null;
  }
}

export function authenticateAccount(identifier: string, password: string): AccountView | null {
  const normalized = normalizeUsername(identifier);
  let row = getDB().prepare(
    'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL',
  ).get(normalized) as AccountRow | undefined;
  if (!row) {
    try {
      row = getDB().prepare(
        'SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL',
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
    'SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL',
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
  department?: string | null;
  departmentId?: string | null;
  role?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  organizationInviteId?: string | null;
}): AccountView {
  const normalized = normalizePhone(input.phone);
  const existing = findAccountByPhone(normalized);
  if (existing) throw new Error('该手机号已注册，请直接登录');

  const digits = normalized.slice(3);
  const database = getDB();
  database.exec('SAVEPOINT create_self_registered_account');
  try {
    const employeeId = `emp_${randomUUID()}`;
    createEmployee({
      id: employeeId,
      organizationId: input.organizationId,
      name: input.name,
      role: input.role?.trim() || '成员',
      department: input.department?.trim() || undefined,
      departmentId: input.departmentId?.trim() || undefined,
      positionId: input.positionId?.trim() || undefined,
      positionTitle: input.positionTitle?.trim() || undefined,
    });
    const account = createAccount({
      organizationId: input.organizationId,
      accountType: 'enterprise',
      employeeId,
      username: `otto_${digits.slice(-4)}_${randomBytes(4).toString('hex')}`,
      password: input.password,
      name: input.name,
      phone: normalized,
      role: input.role?.trim() || '成员',
      department: input.department?.trim() || null,
      departmentId: input.departmentId?.trim() || null,
      positionId: input.positionId?.trim() || null,
      positionTitle: input.positionTitle?.trim() || null,
      tags: ['普通成员'],
      isAdmin: false,
    });
    if (input.organizationInviteId) {
      const reserved = database.prepare(
        `UPDATE organization_invites
         SET used_count = used_count + 1
         WHERE id = ? AND organization_id = ?
           AND revoked_at_ms IS NULL AND expires_at_ms > ?
           AND (max_uses IS NULL OR used_count < max_uses)`,
      ).run(input.organizationInviteId, input.organizationId, Date.now());
      if (Number(reserved.changes) !== 1) {
        throw new Error('企业邀请码可用名额已用完，请联系管理员重新生成');
      }
    }
    database.exec('RELEASE SAVEPOINT create_self_registered_account');
    return account;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT create_self_registered_account');
    database.exec('RELEASE SAVEPOINT create_self_registered_account');
    // 两个有效验证码并发完成时，手机号唯一索引只允许一个账号落库。
    if (findAccountByPhone(normalized)) throw new Error('该手机号已注册，请直接登录');
    throw error;
  }
}

/**
 * 普通注册创建独立个人空间。企业邀请码注册继续走 createSelfRegisteredAccount，
 * 两条路径不能共用默认企业，否则互不认识的个人用户会看到彼此数据。
 */
export function createPersonalRegisteredAccount(input: {
  phone: string;
  name: string;
  password: string;
}): AccountView {
  const normalized = normalizePhone(input.phone);
  if (findAccountByPhone(normalized)) throw new Error('该手机号已注册，请直接登录');
  const name = input.name.trim();
  if (!name) throw new Error('name required');
  const digits = normalized.slice(3);
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = createOrganization({
      name: `${name.slice(0, 60)}的个人空间`,
      slug: `personal-${randomBytes(8).toString('hex')}`,
    });
    const account = createAccount({
      organizationId: organization.id,
      accountType: 'personal',
      username: `otto_${digits.slice(-4)}_${randomBytes(4).toString('hex')}`,
      password: input.password,
      name,
      phone: normalized,
      role: '个人用户',
      tags: [],
      isAdmin: false,
    });
    database.exec('COMMIT');
    return account;
  } catch (error) {
    database.exec('ROLLBACK');
    if (findAccountByPhone(normalized)) throw new Error('该手机号已注册，请直接登录');
    throw error;
  }
}

/**
 * 将已登录的个人账号原子升级为邀请码所属企业成员。
 * 旧个人 organization 及其数据保留为隔离容器；只迁移账号身份，
 * 并且邀请名额、员工目录和会话租户要么全部成功，要么全部回滚。
 */
export function joinOrganizationWithInvite(
  accountId: string,
  inviteCode: string,
  now = Date.now(),
): AccountView {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getAccount(accountId);
    if (!current) throw new Error('账号不存在或已失效');
    if (current.accountType !== 'personal') {
      throw new Error('只有个人版账号可加入企业');
    }
    const invite = resolveOrganizationInviteWithDefaults(inviteCode, now);
    if (!invite) throw new Error('企业邀请码无效、已过期或名额已用完');

    const employeeId = `emp_${randomUUID()}`;
    createEmployee({
      id: employeeId,
      organizationId: invite.organization.id,
      name: current.name,
      role: invite.defaultRole || '成员',
      department: invite.defaultDepartment || undefined,
      departmentId: invite.departmentId || undefined,
      positionId: invite.positionId || undefined,
      positionTitle: invite.positionTitle || undefined,
      invite_code: normalizeOrganizationInviteCode(inviteCode),
    });

    const reserved = database.prepare(
      `UPDATE organization_invites
       SET used_count = used_count + 1
       WHERE id = ? AND organization_id = ?
         AND revoked_at_ms IS NULL AND expires_at_ms > ?
         AND (max_uses IS NULL OR used_count < max_uses)`,
    ).run(invite.inviteId, invite.organization.id, now);
    if (Number(reserved.changes) !== 1) {
      throw new Error('企业邀请码无效、已过期或名额已用完');
    }

    const moved = database.prepare(
      `UPDATE accounts
       SET organization_id = ?, account_type = 'enterprise', employee_id = ?,
           role = ?, department = ?, department_id = ?, position_id = ?, position_title = ?,
           is_admin = 0, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ? AND account_type = 'personal'
         AND deleted_at IS NULL AND status = 'active'`,
    ).run(
      invite.organization.id,
      employeeId,
      invite.defaultRole || '成员',
      invite.defaultDepartment,
      invite.departmentId,
      invite.positionId,
      invite.positionTitle,
      current.id,
      current.organizationId,
    );
    if (Number(moved.changes) !== 1) throw new Error('只有个人版账号可加入企业');

    database.prepare(
      'UPDATE auth_sessions SET organization_id = ? WHERE account_id = ? AND revoked_at IS NULL',
    ).run(invite.organization.id, current.id);
    // 标签是企业内身份，不得把旧个人空间标签带进新租户；
    // account_tags 的历史主键也不含 organization_id，需先清理再建立企业标签。
    database.prepare('DELETE FROM account_tags WHERE account_id = ?').run(current.id);
    replaceAccountTags(current.id, invite.organization.id, ['普通成员']);
    logAudit(
      'personal_account_join_organization',
      employeeId,
      `Personal account ${current.username} joined by organization invite`,
      invite.organization.id,
    );
    const upgraded = getAccount(current.id, invite.organization.id);
    if (!upgraded) throw new Error('企业账号升级失败');
    database.exec('COMMIT');
    return upgraded;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function updateAccount(id: string, patch: {
  username?: string;
  password?: string;
  name?: string;
  phone?: string | null;
  feishuOpenId?: string | null;
  role?: string | null;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  avatarUrl?: string | null;
  tags?: string[];
  isAdmin?: boolean;
  status?: 'active' | 'disabled';
}, organizationId?: string): AccountView {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getAccount(id, organizationId);
    if (!current) throw new Error('Account not found');

    const removesActiveAdmin = current.isAdmin && current.status === 'active'
      && (patch.isAdmin === false || patch.status === 'disabled');
    if (removesActiveAdmin) {
      const other = database.prepare(
        `SELECT 1 FROM accounts
         WHERE organization_id = ? AND id <> ? AND is_admin = 1 AND status = 'active'
         LIMIT 1`,
      ).get(current.organizationId, current.id);
      if (!other) throw new Error('企业至少需要保留一名可登录管理员');
    }

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
    if (patch.feishuOpenId !== undefined) {
      set('feishu_open_id', normalizeOptionalFeishuOpenId(patch.feishuOpenId));
    }
    if (patch.password !== undefined) {
      assertAccountPassword(patch.password);
      set('password_hash', passwordHash(patch.password));
    }
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error('name required');
      set('name', name);
    }
    if (patch.role !== undefined) set('role', patch.role?.trim() || null);
    const assignmentChanged = [
      patch.department,
      patch.departmentId,
      patch.positionId,
      patch.positionTitle,
    ].some((value) => value !== undefined);
    if (assignmentChanged) {
      const assignment = resolveAssignmentIdentity(database, current.organizationId, {
        department: patch.department !== undefined ? patch.department : current.department,
        departmentId: patch.departmentId !== undefined ? patch.departmentId : undefined,
        positionTitle: patch.positionTitle !== undefined
          ? patch.positionTitle
          : current.positionTitle,
        positionId: patch.positionId !== undefined ? patch.positionId : undefined,
      });
      set('department', assignment.department);
      set('department_id', assignment.departmentId);
      set('position_id', assignment.positionId);
      set('position_title', assignment.positionTitle);
    }
    if (patch.avatarUrl !== undefined) set('avatar_url', normalizeOptionalAvatarUrl(patch.avatarUrl));
    if (patch.isAdmin !== undefined) set('is_admin', patch.isAdmin ? 1 : 0);
    if (patch.status !== undefined) set('status', patch.status);
    if (assignments.length > 0) {
      assignments.push("updated_at = datetime('now')");
      try {
        const sql = organizationId
          ? `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ? AND organization_id = ?`
          : `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`;
        database.prepare(sql).run(...values, id, ...(organizationId ? [organizationId] : []));
      } catch (error) {
        if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
          throw new Error('手机号已绑定其他账号');
        }
        throw error;
      }
    }
    if (patch.tags !== undefined) replaceAccountTags(id, current.organizationId, patch.tags);

    const shouldRevokeSessions = patch.password !== undefined
      || (patch.status !== undefined && patch.status !== current.status)
      || (patch.isAdmin !== undefined && patch.isAdmin !== current.isAdmin);
    if (shouldRevokeSessions) {
      database.prepare(
        "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL",
      ).run(id);
    }

    const updated = getAccount(id, organizationId)!;
    if (current.employeeId && [
      patch.name,
      patch.role,
      patch.department,
      patch.departmentId,
      patch.positionId,
      patch.positionTitle,
    ].some((value) => value !== undefined)) {
      database.prepare(
        `UPDATE employees
         SET name = ?, role = ?, department = ?, department_id = ?, position_id = ?, position_title = ?
         WHERE id = ? AND organization_id = ?`,
      ).run(
        updated.name,
        updated.role,
        updated.department,
        updated.departmentId,
        updated.positionId,
        updated.positionTitle,
        current.employeeId,
        current.organizationId,
      );
    }

    logAudit(
      'account_update',
      current.employeeId,
      `Preset account ${current.username} updated`,
      current.organizationId,
    );
    database.exec('COMMIT');
    return updated;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 账号使用逻辑删除：保留工单/用量/审计引用，清除可登录凭据和直接身份字段。
 * 这样既满足管理端“删除账号”，也不会因历史外键导致删除一半后失败。
 */
export function deleteAccount(
  id: string,
  organizationId: string,
  actorAccountId: string,
): { id: string; deleted: true } {
  if (id === actorAccountId) throw new Error('不能删除当前登录账号');
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getAccount(id, organizationId);
    if (!current) throw new Error('Account not found');
    if (current.isAdmin && current.status === 'active') {
      const other = database.prepare(
        `SELECT 1 FROM accounts
         WHERE organization_id = ? AND id <> ? AND is_admin = 1
           AND status = 'active' AND deleted_at IS NULL
         LIMIT 1`,
      ).get(organizationId, id);
      if (!other) throw new Error('企业至少需要保留一名可登录管理员');
    }

    database.prepare(
      `UPDATE accounts SET
         employee_id = NULL,
         username = ?,
         phone = NULL,
         password_hash = ?,
         name = '已删除账号',
         role = NULL,
         department = NULL,
         department_id = NULL,
         position_id = NULL,
         position_title = NULL,
         avatar_url = NULL,
         is_admin = 0,
         status = 'disabled',
         deleted_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    ).run(
      `deleted_${id}`,
      passwordHash(randomBytes(32).toString('base64url')),
      id,
      organizationId,
    );
    database.prepare(
      'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
    ).run(id, organizationId);
    database.prepare(
      "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL",
    ).run(id);
    if (current.employeeId) {
      database.prepare(
        `UPDATE employees SET status = 'offboarded', offboarded_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      ).run(current.employeeId, organizationId);
    }
    logAudit(
      'account_delete',
      current.employeeId,
      `Account ${current.username} deleted by ${actorAccountId}`,
      organizationId,
    );
    database.exec('COMMIT');
    return { id, deleted: true };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
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
       AND a.status = 'active' AND a.deleted_at IS NULL AND o.status = 'active'`,
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
  options: {
    now?: number;
    department?: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    role?: string | null;
    organizationInviteId?: string | null;
  } = {},
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
  const department = options.department?.trim() || null;
  const departmentId = options.departmentId?.trim() || null;
  const positionId = options.positionId?.trim() || null;
  const positionTitle = options.positionTitle?.trim() || null;
  const role = options.role?.trim() || null;
  const organizationInviteId = options.organizationInviteId?.trim() || null;
  if (department && department.length > 80) throw new Error('部门名称不能超过 80 个字符');
  if (positionTitle && positionTitle.length > 80) throw new Error('职位名称不能超过 80 个字符');
  if (role && role.length > 80) throw new Error('角色不能超过 80 个字符');
  getDB().prepare(
    `INSERT INTO sms_registration_challenges
       (id, organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
        organization_invite_id, department, department_id, position_id, position_title, role, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    challengeId,
    organizationId,
    normalized,
    passwordHash(code),
    expiresAtMs,
    SMS_CHALLENGE_MAX_ATTEMPTS,
    organizationInviteId,
    department,
    departmentId,
    positionId,
    positionTitle,
    role,
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
  | {
      ok: true;
      phone: string;
      organizationId: string;
      organizationInviteId: string | null;
      department: string | null;
      departmentId: string | null;
      positionId: string | null;
      positionTitle: string | null;
      role: string | null;
    }
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
    `SELECT organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
            organization_invite_id, department, department_id, position_id, position_title, role, consumed_at_ms
     FROM sms_registration_challenges WHERE id = ?`,
  ).get(challengeId) as {
    organization_id: string;
    phone: string;
    code_hash: string;
    expires_at_ms: number;
    attempts_remaining: number;
    organization_invite_id: string | null;
    department: string | null;
    department_id: string | null;
    position_id: string | null;
    position_title: string | null;
    role: string | null;
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
  return {
    ok: true,
    phone: row.phone,
    organizationId: row.organization_id,
    organizationInviteId: row.organization_invite_id,
    department: row.department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    role: row.role,
  };
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
  serviceId: string;
  title: string;
  description: string;
  formData: Record<string, string>;
  targetTags: string[];
  status: string;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contactPhone: string | null;
  responseType: string | null;
  responseText: string | null;
  responseAt: string | null;
  createdAt: string;
  updatedAt: string;
  creator: Pick<AccountView, 'id' | 'name' | 'username'>;
  recipientCount: number;
  recipients: Array<Pick<AccountView, 'id' | 'name'>>;
  deliveryStatus?: string;
  readAt?: string | null;
  isCreator?: boolean;
  isRecipient?: boolean;
  notifications: Array<{
    channel: 'otto' | 'sms' | 'feishu';
    event: string;
    status: 'sent' | 'failed' | 'skipped';
    detail: string | null;
    createdAt: string;
  }>;
}

interface TicketRow {
  id: string;
  organization_id: string;
  created_by_account_id: string;
  service_id: string | null;
  title: string;
  description: string;
  target_tags: string;
  form_data: string | null;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contact_phone: string | null;
  response_type: string | null;
  response_text: string | null;
  response_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function ticketView(id: string, viewerAccountId?: string): TicketView {
  const row = getDB().prepare('SELECT * FROM it_tickets WHERE id = ?').get(id) as TicketRow | undefined;
  if (!row) throw new Error('Ticket not found');
  const creator = getAccount(row.created_by_account_id, row.organization_id);
  if (!creator) throw new Error('Ticket creator not found');
  const deliveries = getDB().prepare(
    `SELECT account_id, status, read_at FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? ORDER BY delivered_at`,
  ).all(id, row.organization_id) as Array<{ account_id: string; status: string; read_at: string | null }>;
  const recipientAccounts = deliveries
    .map((delivery) => getAccount(delivery.account_id, row.organization_id))
    .filter((account): account is AccountView => account !== null);
  const viewer = viewerAccountId ? getAccount(viewerAccountId, row.organization_id) : null;
  const canSeeRecipients = viewer?.isAdmin || viewerAccountId === creator.id;
  const viewerDelivery = viewerAccountId
    ? deliveries.find((delivery) => delivery.account_id === viewerAccountId)
    : undefined;
  const notifications = viewer?.isAdmin ? getDB().prepare(
    `SELECT channel, event, status, detail, created_at FROM ticket_notifications
     WHERE ticket_id = ? ORDER BY created_at`,
  ).all(id) as Array<{
    channel: 'otto' | 'sms' | 'feishu'; event: string;
    status: 'sent' | 'failed' | 'skipped'; detail: string | null; created_at: string;
  }> : [];
  let formData: Record<string, string> = {};
  try {
    const parsed = row.form_data ? JSON.parse(row.form_data) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      formData = Object.fromEntries(Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ));
    }
  } catch {
    formData = {};
  }
  return {
    id: row.id,
    serviceId: row.service_id || 'repair',
    title: row.title,
    description: row.description,
    formData,
    targetTags: JSON.parse(row.target_tags) as string[],
    status: row.status,
    category: row.category,
    location: row.location,
    urgency: row.urgency,
    contact: row.contact,
    contactPhone: row.contact_phone,
    responseType: row.response_type,
    responseText: row.response_text,
    responseAt: row.response_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: {
      id: creator.id,
      name: creator.name,
      username: creator.username,
    },
    recipientCount: recipientAccounts.length,
    recipients: canSeeRecipients
      ? recipientAccounts.map((recipient) => ({ id: recipient.id, name: recipient.name }))
      : [],
    deliveryStatus: viewerDelivery?.status,
    readAt: viewerDelivery?.read_at,
    isCreator: viewerAccountId === creator.id,
    isRecipient: Boolean(viewerDelivery),
    notifications: notifications.map((notification) => ({
      channel: notification.channel,
      event: notification.event,
      status: notification.status,
      detail: notification.detail,
      createdAt: notification.created_at,
    })),
  };
}

export function getTicketForAccount(id: string, accountId: string): TicketView | null {
  const account = getAccount(accountId);
  if (!account) return null;
  const row = getDB().prepare(
    'SELECT organization_id, created_by_account_id FROM it_tickets WHERE id = ?',
  ).get(id) as { organization_id: string; created_by_account_id: string } | undefined;
  if (!row || row.organization_id !== account.organizationId) return null;
  const delivery = getDB().prepare(
    'SELECT 1 FROM ticket_deliveries WHERE ticket_id = ? AND account_id = ?',
  ).get(id, accountId);
  if (!account.isAdmin && row.created_by_account_id !== accountId && !delivery) return null;
  return ticketView(id, accountId);
}

export function createTicket(input: {
  createdByAccountId: string;
  serviceId?: string;
  title: string;
  description: string;
  targetTags?: string[];
  formData?: Record<string, string>;
  category?: string;
  location?: string;
  urgency?: string;
  contact?: string;
  contactPhone?: string;
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
       (id, organization_id, created_by_account_id, service_id, title, description, target_tags, form_data,
        category, location, urgency, contact, contact_phone, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待接单')`,
  ).run(
    id, creator.organizationId, creator.id, input.serviceId?.trim() || 'repair',
    title, description, JSON.stringify(targetTags), JSON.stringify(input.formData ?? {}),
    input.category?.trim() || null, input.location?.trim() || null,
    input.urgency?.trim() || null, input.contact?.trim() || null,
    input.contactPhone?.trim() || null,
  );
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
  return ticketView(id, creator.id);
}

/** 通知只能在服务端使用完整账号资料，绝不把手机号或飞书 open_id 返回给普通客户端。 */
export function getTicketNotificationRecipients(ticketId: string): AccountView[] {
  const row = getDB().prepare(
    'SELECT organization_id FROM it_tickets WHERE id = ?',
  ).get(ticketId) as { organization_id: string } | undefined;
  if (!row) return [];
  const deliveries = getDB().prepare(
    `SELECT account_id FROM ticket_deliveries
     WHERE ticket_id = ? AND organization_id = ? ORDER BY delivered_at`,
  ).all(ticketId, row.organization_id) as Array<{ account_id: string }>;
  return deliveries
    .map(({ account_id: accountId }) => getAccount(accountId, row.organization_id))
    .filter((account): account is AccountView => account !== null);
}

export function listTicketInbox(accountId: string): TicketView[] {
  const ids = getDB().prepare(
    `SELECT t.id FROM ticket_deliveries d
     JOIN it_tickets t ON t.id = d.ticket_id
     WHERE d.account_id = ? AND d.organization_id = t.organization_id
     ORDER BY t.updated_at DESC, t.created_at DESC`,
  ).all(accountId) as Array<{ id: string }>;
  return ids.map(({ id }) => ticketView(id, accountId));
}

export function listTicketsForAccount(accountId: string): TicketView[] {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const ids = (account.isAdmin
    ? getDB().prepare(
      `SELECT id FROM it_tickets WHERE organization_id = ? ORDER BY updated_at DESC, created_at DESC`,
    ).all(account.organizationId)
    : getDB().prepare(
      `SELECT DISTINCT t.id FROM it_tickets t
       LEFT JOIN ticket_deliveries d ON d.ticket_id = t.id AND d.account_id = ?
       WHERE t.organization_id = ? AND (t.created_by_account_id = ? OR d.account_id = ?)
       ORDER BY t.updated_at DESC, t.created_at DESC`,
    ).all(account.id, account.organizationId, account.id, account.id)) as Array<{ id: string }>;
  return ids.map(({ id }) => ticketView(id, account.id));
}

export function markTicketRead(ticketId: string, accountId: string): TicketView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const changed = getDB().prepare(
    `UPDATE ticket_deliveries SET status = 'read', read_at = COALESCE(read_at, datetime('now'))
     WHERE ticket_id = ? AND account_id = ? AND organization_id = ?`,
  ).run(ticketId, account.id, account.organizationId);
  if (changed.changes === 0) throw new Error('Ticket delivery not found');
  return ticketView(ticketId, accountId);
}

export function updateTicket(input: {
  ticketId: string;
  accountId: string;
  action: 'respond' | 'accept' | 'complete' | 'confirm';
  responseType?: string;
  responseText?: string;
}): TicketView {
  const account = getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  const current = ticketView(input.ticketId, input.accountId);
  const isRecipient = Boolean(current.isRecipient);
  if (input.action === 'confirm') {
    if (!current.isCreator) throw new Error('Only ticket creator can confirm');
    if (current.status !== '待验收') throw new Error('Ticket is not awaiting acceptance');
    getDB().prepare(
      `UPDATE it_tickets SET status = '已完成', closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(input.ticketId, account.organizationId);
  } else {
    if (!isRecipient) throw new Error('Only assigned repair workers can update');
    if (input.action === 'respond') {
      const responseType = input.responseType?.trim() || '';
      const responseText = input.responseText?.trim() || '';
      if (!responseType || !responseText) throw new Error('responseType and responseText required');
      if (responseType.length > 50 || responseText.length > 2000) throw new Error('Repair response is too long');
      const nextStatus = responseType === '已完成维修' ? '待验收' : current.status;
      getDB().prepare(
        `UPDATE it_tickets SET response_type = ?, response_text = ?, response_at = datetime('now'),
          status = ?, completed_at = CASE WHEN ? = '待验收' THEN datetime('now') ELSE completed_at END,
          updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
      ).run(responseType, responseText, nextStatus, nextStatus, input.ticketId, account.organizationId);
    } else if (input.action === 'accept') {
      if (!['待接单', '待派单'].includes(current.status)) throw new Error('Ticket cannot be accepted');
      const acceptedStatus = current.serviceId === 'repair' ? '维修中' : '处理中';
      getDB().prepare(
        `UPDATE it_tickets SET status = ?, accepted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      ).run(acceptedStatus, input.ticketId, account.organizationId);
    } else if (input.action === 'complete') {
      if (!['维修中', '处理中'].includes(current.status)) throw new Error('Ticket is not being processed');
      getDB().prepare(
        `UPDATE it_tickets SET status = '待验收', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
      ).run(input.ticketId, account.organizationId);
    }
  }
  logAudit(
    `ticket_${input.action}`,
    account.employeeId,
    `Ticket ${input.ticketId} ${input.action}`,
    account.organizationId,
  );
  return ticketView(input.ticketId, input.accountId);
}

export function recordTicketNotification(input: {
  ticketId: string;
  recipientAccountId: string;
  channel: 'otto' | 'sms' | 'feishu';
  event: string;
  status: 'sent' | 'failed' | 'skipped';
  detail?: string | null;
}): void {
  const ticket = getDB().prepare(
    'SELECT organization_id FROM it_tickets WHERE id = ?',
  ).get(input.ticketId) as { organization_id: string } | undefined;
  if (!ticket) throw new Error('Ticket not found');
  getDB().prepare(
    `INSERT INTO ticket_notifications
      (id, organization_id, ticket_id, recipient_account_id, channel, event, status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `ticket_notice_${randomUUID()}`,
    ticket.organization_id,
    input.ticketId,
    input.recipientAccountId,
    input.channel,
    input.event,
    input.status,
    input.detail ?? null,
  );
}

export interface ParkPublicationView {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
  responseData: Record<string, string> | null;
}

export interface ParkSurveyResultView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  submittedCount: number;
  responses: Array<{
    accountId: string;
    accountName: string;
    submittedAt: string;
    responseData: Record<string, string>;
  }>;
}

interface ParkPublicationRow {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  submitted_at: string | null;
  response_data: string | null;
}

function publicationView(row: ParkPublicationRow): ParkPublicationView {
  let responseData: Record<string, string> | null = null;
  try {
    const value = row.response_data ? JSON.parse(row.response_data) as unknown : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      responseData = Object.fromEntries(Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ));
    }
  } catch {
    responseData = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
    submittedAt: row.submitted_at,
    responseData,
  };
}

export function createParkPublication(input: {
  createdByAccountId: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  recipientAccountId?: string | null;
}): { publication: ParkPublicationView; recipientCount: number } {
  const creator = getAccount(input.createdByAccountId);
  if (!creator?.isAdmin) throw new Error('Only enterprise administrators can publish park content');
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new Error('title and body required');
  const recipients = input.recipientAccountId
    ? [getAccount(input.recipientAccountId, creator.organizationId)].filter(
      (account): account is AccountView => account !== null && account.status === 'active',
    )
    : (getDB().prepare(
      `SELECT * FROM accounts
       WHERE organization_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY name, username`,
    ).all(creator.organizationId) as AccountRow[]).map(toAccountView);
  if (recipients.length === 0) throw new Error('No active recipients');
  const id = `park_publication_${randomUUID()}`;
  getDB().prepare(
    `INSERT INTO park_publications
      (id, organization_id, kind, title, body, created_by_account_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, creator.organizationId, input.kind, title, body, creator.id);
  const insertRecipient = getDB().prepare(
    `INSERT INTO park_publication_recipients
      (organization_id, publication_id, account_id) VALUES (?, ?, ?)`,
  );
  for (const recipient of recipients) {
    insertRecipient.run(creator.organizationId, id, recipient.id);
  }
  logAudit(
    'park_publication_create',
    creator.employeeId,
    `${input.kind} ${id} delivered to ${recipients.length} account(s)`,
    creator.organizationId,
  );
  return {
    publication: listParkPublications(creator.id).find((item) => item.id === id)
      ?? { id, kind: input.kind, title, body, createdAt: new Date().toISOString(), readAt: null, submittedAt: null, responseData: null },
    recipientCount: recipients.length,
  };
}

export function listParkPublications(accountId: string): ParkPublicationView[] {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const rows = getDB().prepare(
    `SELECT p.id, p.kind, p.title, p.body, p.created_at,
            r.read_at, r.submitted_at, r.response_data
     FROM park_publication_recipients r
     JOIN park_publications p ON p.id = r.publication_id
     WHERE r.account_id = ? AND r.organization_id = ? AND p.organization_id = ?
     ORDER BY p.created_at DESC`,
  ).all(account.id, account.organizationId, account.organizationId) as ParkPublicationRow[];
  return rows.map(publicationView);
}

/** 管理员查看本企业问卷回收情况；实名由账号表提供，不信任客户端自填姓名。 */
export function listParkSurveyResults(accountId: string): ParkSurveyResultView[] {
  const account = getAccount(accountId);
  if (!account?.isAdmin) throw new Error('Only enterprise administrators can view survey results');
  const publications = getDB().prepare(
    `SELECT p.id, p.title, p.body, p.created_at,
            COUNT(r.account_id) AS recipient_count,
            SUM(CASE WHEN r.submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted_count
     FROM park_publications p
     LEFT JOIN park_publication_recipients r
       ON r.publication_id = p.id AND r.organization_id = p.organization_id
     WHERE p.organization_id = ? AND p.kind = 'satisfaction'
     GROUP BY p.id, p.title, p.body, p.created_at
     ORDER BY p.created_at DESC`,
  ).all(account.organizationId) as Array<{
    id: string; title: string; body: string; created_at: string;
    recipient_count: number; submitted_count: number;
  }>;
  const responseRows = getDB().prepare(
    `SELECT r.account_id, a.name AS account_name, r.submitted_at, r.response_data
     FROM park_publication_recipients r
     JOIN accounts a ON a.id = r.account_id AND a.organization_id = r.organization_id
     WHERE r.publication_id = ? AND r.organization_id = ? AND r.submitted_at IS NOT NULL
     ORDER BY r.submitted_at DESC`,
  );
  return publications.map((publication) => {
    const rows = responseRows.all(publication.id, account.organizationId) as Array<{
      account_id: string; account_name: string; submitted_at: string; response_data: string | null;
    }>;
    return {
      id: publication.id,
      title: publication.title,
      body: publication.body,
      createdAt: publication.created_at,
      recipientCount: Number(publication.recipient_count) || 0,
      submittedCount: Number(publication.submitted_count) || 0,
      responses: rows.map((row) => {
        let responseData: Record<string, string> = {};
        try {
          const value = row.response_data ? JSON.parse(row.response_data) as unknown : null;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            responseData = Object.fromEntries(Object.entries(value).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ));
          }
        } catch {
          responseData = {};
        }
        responseData.submittedBy = row.account_name;
        return {
          accountId: row.account_id,
          accountName: row.account_name,
          submittedAt: row.submitted_at,
          responseData,
        };
      }),
    };
  });
}

export function markParkPublicationRead(id: string, accountId: string): ParkPublicationView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const changed = getDB().prepare(
    `UPDATE park_publication_recipients
     SET read_at = COALESCE(read_at, datetime('now'))
     WHERE publication_id = ? AND account_id = ? AND organization_id = ?`,
  ).run(id, account.id, account.organizationId);
  if (changed.changes === 0) throw new Error('Publication not found or not assigned');
  const publication = listParkPublications(account.id).find((item) => item.id === id);
  if (!publication) throw new Error('Publication not found');
  return publication;
}

export function submitParkSurvey(
  id: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkPublicationView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const publication = getDB().prepare(
    'SELECT kind FROM park_publications WHERE id = ? AND organization_id = ?',
  ).get(id, account.organizationId) as { kind: string } | undefined;
  if (publication?.kind !== 'satisfaction') throw new Error('Survey not found');
  const normalized = Object.fromEntries(Object.entries(responseData)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => [key.slice(0, 50), value.trim().slice(0, 2000)]));
  normalized.submittedBy = account.name;
  const changed = getDB().prepare(
    `UPDATE park_publication_recipients
     SET read_at = COALESCE(read_at, datetime('now')), submitted_at = datetime('now'), response_data = ?
     WHERE publication_id = ? AND account_id = ? AND organization_id = ? AND submitted_at IS NULL`,
  ).run(JSON.stringify(normalized), id, account.id, account.organizationId);
  if (changed.changes === 0) throw new Error('问卷不存在或已经提交，不能重复修改');
  const result = listParkPublications(account.id).find((item) => item.id === id);
  if (!result) throw new Error('Survey not found');
  logAudit('park_survey_submit', account.employeeId, `Survey ${id} submitted`, account.organizationId);
  return result;
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

function sqliteUtcToIso(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const timestamp = Date.parse(withZone);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
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
  const duplicate = getDB().prepare(
    'SELECT 1 AS found FROM account_token_usage WHERE account_id = ? AND message_id = ?',
  ).get(account.id, messageId) as { found?: number } | undefined;
  if (duplicate?.found === 1) return false;
  const recentCount = getDB().prepare(
    `SELECT COUNT(*) AS count
     FROM account_token_usage
     WHERE account_id = ? AND datetime(created_at) >= datetime('now', '-1 day')`,
  ).get(account.id) as { count?: number } | undefined;
  if (Number(recentCount?.count ?? 0) >= USAGE_DAILY_RECORD_LIMIT) {
    throw new Error('账号今日 Token 用量记录已达上限');
  }
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
      AND datetime(u.created_at) >= datetime(?)
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
    lastUsedAt: sqliteUtcToIso(row.last_used_at),
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
  departmentId?: string; positionId?: string; positionTitle?: string;
  organizationId?: string;
}): void {
  const organizationId = emp.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const database = getDB();
  const assignment = resolveAssignmentIdentity(database, organizationId, {
    department: emp.department,
    departmentId: emp.departmentId,
    positionId: emp.positionId,
    positionTitle: emp.positionTitle,
  });
  database.prepare(
    `INSERT INTO employees
       (id, organization_id, name, role, department, department_id, position_id, position_title,
        invite_code, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    emp.id,
    organizationId,
    emp.name,
    emp.role || null,
    assignment.department,
    assignment.departmentId,
    assignment.positionId,
    assignment.positionTitle,
    emp.invite_code || null,
    emp.personality || null,
  );
  logAudit(
    'onboard',
    emp.id,
    `Employee ${emp.name} onboarded to ${assignment.department || 'unassigned'}`,
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
  sourceId?: string;
}): boolean {
  const organizationId = k.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId)) throw new Error('Organization not found');
  const result = getDB().prepare(
    `INSERT INTO knowledge
       (organization_id, source_id, department, category, content, contributor, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
  ).run(
    organizationId,
    k.sourceId || null,
    k.department || null,
    k.category,
    k.content,
    k.contributor || null,
    k.confidence ?? 0.5,
  ) as { changes?: number | bigint };
  return Number(result.changes ?? 0) > 0;
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

/**
 * 普通成员的知识可见域：本企业中未绑定部门的全局知识，加上本人当前部门知识。
 * 调用方不能传入任意目标部门；无部门成员只能读取全局知识。
 */
export function getMemberKnowledge(
  memberDepartment: string | null | undefined,
  query = '',
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  const department = memberDepartment?.trim() || null;
  const cleanQuery = query.trim();
  let sql = 'SELECT * FROM knowledge WHERE organization_id = ?';
  const params: any[] = [organizationId];
  if (department) {
    sql += ' AND (department IS NULL OR department = ?)';
    params.push(department);
  } else {
    sql += ' AND department IS NULL';
  }
  if (cleanQuery) {
    sql += ' AND (content LIKE ? OR category LIKE ?)';
    params.push(`%${cleanQuery}%`, `%${cleanQuery}%`);
    sql += ' ORDER BY confidence DESC LIMIT 20';
  } else {
    sql += ' ORDER BY created_at DESC';
  }
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
  // 原子操作：WHERE used_count < max_uses 防止并发超用
  const result = getDB().prepare(
    'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
  ).run(code);
  if (result.changes === 0) return { valid: false, error: 'Invite code already used' };
  return { valid: true, department: row.department, organizationId: row.organization_id };
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
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
