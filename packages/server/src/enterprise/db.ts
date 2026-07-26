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
import {
  LICENSE_MODULE_FEATURES,
  licenseModuleCatalog,
  type ModuleUpdateDescriptor,
  type ModuleUpdateManifest,
  type ModuleUpdateRollout,
} from './moduleUpdateManifest.js';
import {
  getModuleUpdateManifestFromStore,
  updateModuleUpdateDescriptorInStore,
} from './moduleUpdateRepository.js';
import { getAuditLogs, logAudit } from './auditRepository.js';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  offboardEmployee,
} from './employeeRepository.js';
import { getKnowledge as getKnowledgeFromRepository } from './knowledgeRepository.js';
import {
  exportDeploymentDiagnostics as exportDeploymentDiagnosticsFromRepository,
  getDeploymentId as getDeploymentIdFromRepository,
  getDeploymentLicense as getDeploymentLicenseFromRepository,
  getMachineFingerprint as getMachineFingerprintFromRepository,
  getPrivateDeploymentStatus as getPrivateDeploymentStatusFromRepository,
  getTelemetryQueueSummary as getTelemetryQueueSummaryFromRepository,
  getTelemetrySettings as getTelemetrySettingsFromRepository,
  importDeploymentLicense as importDeploymentLicenseIntoRepository,
  isLicenseRestricted as isLicenseRestrictedInRepository,
  isLicenseUsableForOrganizationFeature as isLicenseUsableForOrganizationFeatureInRepository,
  recordTelemetryEvent as recordTelemetryEventInRepository,
  updateTelemetrySettings as updateTelemetrySettingsInRepository,
} from './deploymentRepository.js';
import {
  createParkDataStatisticsTask as createParkDataStatisticsTaskInRepository,
  delegateParkDataStatistics as delegateParkDataStatisticsInRepository,
  getParkDataStatisticsTemplate as getParkDataStatisticsTemplateFromRepository,
  listParkDataStatisticsTasks as listParkDataStatisticsTasksFromRepository,
  markParkDataStatisticsRead as markParkDataStatisticsReadInRepository,
  remindParkDataStatistics as remindParkDataStatisticsInRepository,
  returnParkDataStatistics as returnParkDataStatisticsInRepository,
  reviewParkDataStatistics as reviewParkDataStatisticsInRepository,
  submitParkDataStatisticsDraft as submitParkDataStatisticsDraftInRepository,
} from './parkStatisticsRepository.js';
import type {
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
} from './deploymentTypes.js';
import type {
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
} from './parkStatisticsTypes.js';
export type {
  ModuleUpdateDescriptor,
  ModuleUpdateManifest,
  ModuleUpdateRollout,
} from './moduleUpdateManifest.js';
export type {
  DeploymentLicenseStatus,
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
} from './deploymentTypes.js';
export type {
  ParkDataStatisticsAssignmentStatus,
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
} from './parkStatisticsTypes.js';
export {
  listDirectMessages,
  listPendingAtoaRequests,
  listUnreadDirectMessageNotifications,
  markAtoaRequestReadFromResponse,
  sendDirectMessage,
} from './directMessageRepository.js';
export type {
  AtoaInboxMessageView,
  DirectMessageView,
  UnreadDirectMessageNotification,
} from './directMessageRepository.js';
export {
  createTicket,
  getTicketCreatorForAccount,
  getTicketForAccount,
  getTicketNotificationRecipients,
  isTicketFeatureEnabledForAccount,
  listTicketInbox,
  listTicketsForAccount,
  markTicketRead,
  recordTicketNotification,
  updateTicket,
} from './ticketRepository.js';
export type {
  TicketView,
} from './ticketRepository.js';

const DATA_DIR =
  process.env.OTTO_ENTERPRISE_DIR ||
  path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');

export const DEFAULT_ORGANIZATION_ID = 'org_default';
export const ENTERPRISE_SCHEMA_VERSION = 8;
export const ORGANIZATION_INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const ORGANIZATION_INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INVITE_CODE_RAW_LENGTH = 12;

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
      { user_version?: number } | undefined;
    const existingSchemaVersion = Number(existingSchema?.user_version ?? 0);
    if (
      Number.isInteger(existingSchemaVersion) &&
      existingSchemaVersion > ENTERPRISE_SCHEMA_VERSION
    ) {
      throw new Error(
        `Enterprise database schema version ${existingSchemaVersion} is newer than ` +
          `current version ${ENTERPRISE_SCHEMA_VERSION}; refusing downgrade`,
      );
    }
    database.pragma('journal_mode = WAL');
    migrateLegacyAuthSessions(database);
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

function migrateLegacyAuthSessions(d: Database): void {
  const table = d
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions'",
    )
    .get() as { name?: string } | undefined;
  if (!table) return;
  const columns = d.prepare('PRAGMA table_info(auth_sessions)').all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has('token_hash') && names.has('id')) return;
  if (
    !names.has('token') ||
    !names.has('account_id') ||
    !names.has('expires_at')
  )
    return;

  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('BEGIN IMMEDIATE');
  try {
    d.exec('ALTER TABLE auth_sessions RENAME TO auth_sessions_legacy_v195');
    d.exec(`
      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
        account_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      )
    `);
    const legacyColumns = d
      .prepare('PRAGMA table_info(auth_sessions_legacy_v195)')
      .all() as Array<{ name: string }>;
    const legacyNames = new Set(legacyColumns.map((column) => column.name));
    const organizationExpr = legacyNames.has('organization_id')
      ? 'COALESCE(organization_id, ?)'
      : '? AS organization_id';
    const rows = d
      .prepare(
        `SELECT token, account_id, expires_at, created_at, ${organizationExpr}
       FROM auth_sessions_legacy_v195
       WHERE token IS NOT NULL AND token <> ''`,
      )
      .all(DEFAULT_ORGANIZATION_ID) as Array<{
      token: string;
      account_id: string;
      expires_at: string;
      created_at: string | null;
      organization_id: string | null;
    }>;
    const insert = d.prepare(
      `INSERT OR IGNORE INTO auth_sessions
       (id, organization_id, account_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
    );
    for (const row of rows) {
      const hashed = createHash('sha256').update(row.token).digest('hex');
      insert.run(
        `session_legacy_${hashed.slice(0, 24)}`,
        row.organization_id || DEFAULT_ORGANIZATION_ID,
        row.account_id,
        hashed,
        row.expires_at,
        row.created_at,
      );
    }
    d.exec('DROP TABLE auth_sessions_legacy_v195');
    d.exec('COMMIT');
  } catch (error) {
    d.exec('ROLLBACK');
    throw error;
  } finally {
    d.exec('PRAGMA foreign_keys = ON');
  }
}

/** 执行真实读查询，供 HTTP readiness 判断数据库与 schema 是否可用。 */
export function getDatabaseReadiness(): { ready: true; schemaVersion: number } {
  const database = getDB();
  const probe = database.prepare('SELECT 1 AS ready').get() as
    { ready?: number } | undefined;
  if (probe?.ready !== 1)
    throw new Error('Enterprise database readiness probe failed');
  const schema = database.prepare('PRAGMA user_version').get() as
    { user_version?: number } | undefined;
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
      park_id TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS organization_departments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(organization_id, name),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS organization_positions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      department_id TEXT NOT NULL,
      title TEXT NOT NULL COLLATE NOCASE,
      role_mapping TEXT NOT NULL DEFAULT 'member'
        CHECK(role_mapping IN ('member', 'department_admin', 'enterprise_admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(organization_id, department_id, title),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (department_id) REFERENCES organization_departments(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS organization_features (
      organization_id TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, feature_key),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployment_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deployment_license (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      organization_id TEXT,
      customer_name TEXT NOT NULL,
      plan TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      seat_limit INTEGER NOT NULL,
      modules_json TEXT NOT NULL,
      offline INTEGER NOT NULL DEFAULT 0 CHECK(offline IN (0, 1)),
      telemetry_allowed INTEGER NOT NULL DEFAULT 1 CHECK(telemetry_allowed IN (0, 1)),
      issued_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      signature TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      organization_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sent', 'failed', 'discarded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS parks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
      invite_secret TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL UNIQUE,
      brand_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (admin_organization_id) REFERENCES organizations(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS park_invites (
      id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      created_by_account_id TEXT NOT NULL,
      max_uses INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_services (
      park_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, id),
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_tenant_profiles (
      organization_id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      address TEXT NOT NULL,
      room_number TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_service_specialists (
      park_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, service_id, account_id),
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS account_presence (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      last_seen_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, account_id, client_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
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
      park_id TEXT,
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
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (park_id) REFERENCES parks(id)
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

    -- 园区数据统计：任务归园区所有，企业级分派与填报状态单独隔离。
    -- template_data 仅保存受限大小的原始模板，真正的字段定义保存在 fields_json，
    -- 这样既能保留管理员上传的 Excel，又不把企业填报数据混入公告/问卷表。
    CREATE TABLE IF NOT EXISTS park_data_statistics_tasks (
      id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      deadline TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '[]',
      template_name TEXT,
      template_data TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
      FOREIGN KEY (admin_organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS park_data_statistics_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      park_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      ceo_account_id TEXT NOT NULL,
      assignee_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN (
        'pending', 'delegated', 'in_progress', 'pending_review', 'submitted', 'returned', 'overdue'
      )),
      response_data TEXT,
      return_reason TEXT,
      read_at TEXT,
      submitted_at TEXT,
      reviewed_at TEXT,
      last_reminded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, organization_id),
      FOREIGN KEY (task_id) REFERENCES park_data_statistics_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (ceo_account_id) REFERENCES accounts(id),
      FOREIGN KEY (assignee_account_id) REFERENCES accounts(id)
    );
    CREATE TABLE IF NOT EXISTS park_settings (
      organization_id TEXT PRIMARY KEY,
      parking_total INTEGER NOT NULL DEFAULT 0,
      parking_note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_meeting_rooms (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      equipment TEXT NOT NULL,
      image_url TEXT,
      opening_hours TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_meeting_slots (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      slot_key TEXT NOT NULL CHECK(slot_key IN ('morning', 'afternoon')),
      enabled INTEGER NOT NULL DEFAULT 1,
      booked_ticket_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (organization_id, meeting_room_id, use_date, slot_key),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (meeting_room_id) REFERENCES park_meeting_rooms(id) ON DELETE CASCADE
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
    CREATE INDEX IF NOT EXISTS idx_organization_departments_org
      ON organization_departments(organization_id, name);
    CREATE INDEX IF NOT EXISTS idx_organization_positions_org
      ON organization_positions(organization_id, department_id, title);
    CREATE INDEX IF NOT EXISTS idx_park_invites_active
      ON park_invites(park_id, expires_at_ms, revoked_at_ms);
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
    CREATE INDEX IF NOT EXISTS idx_park_statistics_tasks_park
      ON park_data_statistics_tasks(park_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_park_statistics_assignments_account
      ON park_data_statistics_assignments(ceo_account_id, assignee_account_id, status);
    CREATE INDEX IF NOT EXISTS idx_park_statistics_assignments_org
      ON park_data_statistics_assignments(organization_id, task_id, status);
    CREATE INDEX IF NOT EXISTS idx_park_meeting_rooms_org_enabled
      ON park_meeting_rooms(organization_id, enabled, created_at);
    CREATE INDEX IF NOT EXISTS idx_park_meeting_slots_org_date
      ON park_meeting_slots(organization_id, use_date, meeting_room_id);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_org_created
      ON account_token_usage(organization_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_account_token_usage_account_created
      ON account_token_usage(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_account_presence_org_seen
      ON account_presence(organization_id, last_seen_at_ms);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_status_created
      ON telemetry_events(status, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_telemetry_events_deployment_created
      ON telemetry_events(deployment_id, created_at_ms);
  `);

  const organizationColumns = d
    .prepare('PRAGMA table_info(organizations)')
    .all() as Array<{ name: string }>;
  if (!organizationColumns.some((column) => column.name === 'credit_balance')) {
    d.exec(
      'ALTER TABLE organizations ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0',
    );
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
  const accountColumns = d
    .prepare('PRAGMA table_info(accounts)')
    .all() as Array<{ name: string }>;
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
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
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
    'account_presence',
  ])
    ensureOrganizationColumn(table);

  const ticketColumns = d
    .prepare('PRAGMA table_info(it_tickets)')
    .all() as Array<{ name: string }>;
  const ensureTicketColumn = (name: string, definition = 'TEXT'): void => {
    if (!ticketColumns.some((column) => column.name === name)) {
      d.exec(`ALTER TABLE it_tickets ADD COLUMN ${name} ${definition}`);
    }
  };
  for (const name of [
    'service_id',
    'form_data',
    'category',
    'location',
    'urgency',
    'contact',
    'contact_phone',
    'response_type',
    'response_text',
    'response_at',
    'accepted_at',
    'completed_at',
    'closed_at',
  ])
    ensureTicketColumn(name);
  d.exec(
    "UPDATE it_tickets SET service_id = 'repair' WHERE service_id IS NULL OR service_id = ''",
  );
  d.exec("UPDATE it_tickets SET status = '待接单' WHERE status = 'open'");

  // 自动知识捕获需要跨进程重试幂等。必须在旧库补 organization_id 之后建组织级索引，
  // 否则最早期的单组织 knowledge 表会因缺少该列而无法启动迁移。
  const knowledgeColumns = d
    .prepare('PRAGMA table_info(knowledge)')
    .all() as Array<{ name: string }>;
  if (!knowledgeColumns.some((column) => column.name === 'source_id')) {
    d.exec('ALTER TABLE knowledge ADD COLUMN source_id TEXT');
  }
  const ensureTextColumn = (table: string, column: string): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
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
  ensureTextColumn('accounts', 'employee_id');
  ensureTextColumn('accounts', 'position_id');
  ensureTextColumn('accounts', 'position_title');
  ensureTextColumn('accounts', 'department_id');
  ensureTextColumn('accounts', 'avatar_url');
  ensureTextColumn('employees', 'department_id');
  ensureTextColumn('employees', 'position_id');
  ensureTextColumn('employees', 'position_title');
  ensureTextColumn('accounts', 'account_type');
  ensureTextColumn('accounts', 'deleted_at');
  ensureTextColumn('organizations', 'park_id');
  ensureTextColumn('it_tickets', 'park_id');
  d.exec(
    "UPDATE accounts SET account_type = 'enterprise' WHERE account_type IS NULL",
  );
  backfillEnterpriseAccountEmployees(d);
  backfillOrganizationStructure(d);
  const ensureIntegerColumn = (
    table: string,
    column: string,
    ddl: string,
  ): void => {
    const columns = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  ensureIntegerColumn('organization_invites', 'max_uses', 'INTEGER');
  ensureIntegerColumn(
    'organization_invites',
    'used_count',
    'INTEGER NOT NULL DEFAULT 0',
  );
  d.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_source_unique
      ON knowledge(organization_id, source_id) WHERE source_id IS NOT NULL;
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_accounts_organization ON accounts(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_organizations_park ON organizations(park_id);
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

  const accounts = d
    .prepare(
      `SELECT id, organization_id, employee_id, name, role, department, department_id,
            position_id, position_title, status, created_at
     FROM accounts
     WHERE account_type = 'enterprise' AND deleted_at IS NULL`,
    )
    .all() as MigrationAccountRow[];
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
      const departmentId =
        account.department_id ??
        (account.department
          ? stableAssignmentId(
              'dept',
              account.organization_id,
              normalizeAssignmentName(account.department),
            )
          : null);
      const positionId =
        account.position_id ??
        (account.position_title
          ? stableAssignmentId(
              'pos',
              account.organization_id,
              departmentId,
              normalizeAssignmentName(account.position_title),
            )
          : null);
      if (
        departmentId !== account.department_id ||
        positionId !== account.position_id
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
        ? (findEmployee.get(account.employee_id) as
            MigrationEmployeeRow | undefined)
        : undefined;
      let employeeId =
        linked?.organization_id === account.organization_id ? linked.id : null;
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

/** 把 v4 以前只存在于账号/员工字段里的节点补成可独立管理的组织目录。 */
function backfillOrganizationStructure(d: Database): void {
  const departments = d
    .prepare(
      `SELECT organization_id, department_id, department FROM accounts
       WHERE deleted_at IS NULL AND department IS NOT NULL AND trim(department) <> ''
     UNION
     SELECT organization_id, department_id, department FROM employees
       WHERE department IS NOT NULL AND trim(department) <> ''`,
    )
    .all() as Array<{
    organization_id: string;
    department_id: string | null;
    department: string;
  }>;
  const insertDepartment = d.prepare(
    `INSERT OR IGNORE INTO organization_departments (id, organization_id, name)
     VALUES (?, ?, ?)`,
  );
  for (const row of departments) {
    const id =
      row.department_id ??
      stableAssignmentId(
        'dept',
        row.organization_id,
        normalizeAssignmentName(row.department),
      );
    insertDepartment.run(id, row.organization_id, row.department.trim());
    d.prepare(
      `UPDATE accounts SET department_id = ?
       WHERE organization_id = ? AND department_id IS NULL AND department = ?`,
    ).run(id, row.organization_id, row.department);
    d.prepare(
      `UPDATE employees SET department_id = ?
       WHERE organization_id = ? AND department_id IS NULL AND department = ?`,
    ).run(id, row.organization_id, row.department);
  }

  const positions = d
    .prepare(
      `SELECT organization_id, department_id, position_id, position_title FROM accounts
       WHERE deleted_at IS NULL AND department_id IS NOT NULL
         AND position_title IS NOT NULL AND trim(position_title) <> ''
     UNION
     SELECT organization_id, department_id, position_id, position_title FROM employees
       WHERE department_id IS NOT NULL
         AND position_title IS NOT NULL AND trim(position_title) <> ''`,
    )
    .all() as Array<{
    organization_id: string;
    department_id: string;
    position_id: string | null;
    position_title: string;
  }>;
  const insertPosition = d.prepare(
    `INSERT OR IGNORE INTO organization_positions
      (id, organization_id, department_id, title, role_mapping)
     VALUES (?, ?, ?, ?, 'member')`,
  );
  for (const row of positions) {
    const id =
      row.position_id ??
      stableAssignmentId(
        'pos',
        row.organization_id,
        row.department_id,
        normalizeAssignmentName(row.position_title),
      );
    insertPosition.run(
      id,
      row.organization_id,
      row.department_id,
      row.position_title.trim(),
    );
    d.prepare(
      `UPDATE accounts SET position_id = ?
       WHERE organization_id = ? AND position_id IS NULL
         AND department_id = ? AND position_title = ?`,
    ).run(id, row.organization_id, row.department_id, row.position_title);
    d.prepare(
      `UPDATE employees SET position_id = ?
       WHERE organization_id = ? AND position_id IS NULL
         AND department_id = ? AND position_title = ?`,
    ).run(id, row.organization_id, row.department_id, row.position_title);
  }
}

// ============================================================
// Organizations and time-boxed registration invites
// ============================================================

export interface OrganizationView {
  id: string;
  name: string;
  slug: string;
  parkId: string | null;
  parkAddress?: string | null;
  parkRoomNumber?: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  park_id?: string | null;
  park_address?: string | null;
  park_room_number?: string | null;
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
    parkId: row.park_id ?? null,
    parkAddress: row.park_address ?? null,
    parkRoomNumber: row.park_room_number ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeOrganizationSlug(input: string): string {
  const slug = input
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 48)
    throw new Error('企业标识只能使用字母、数字和连字符');
  return slug;
}

export function createOrganization(input: {
  name: string;
  slug?: string;
  now?: number;
}): OrganizationView {
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new Error('企业名称不能为空且不能超过 80 个字符');
  const slug = normalizeOrganizationSlug(
    input.slug || `company-${randomBytes(5).toString('hex')}`,
  );
  const id = `org_${randomUUID()}`;
  getDB()
    .prepare(
      `INSERT INTO organizations (id, name, slug, invite_secret)
     VALUES (?, ?, ?, ?)`,
    )
    .run(id, name, slug, randomBytes(32).toString('hex'));
  logAudit('organization_create', null, `Organization ${slug} created`, id);
  return getOrganization(id)!;
}

export function getOrganization(id: string): OrganizationView | null {
  const row = getDB()
    .prepare('SELECT * FROM organizations WHERE id = ?')
    .get(id) as OrganizationRow | undefined;
  return row ? toOrganizationView(row) : null;
}

export function listOrganizations(): OrganizationView[] {
  return (
    getDB()
      .prepare('SELECT * FROM organizations ORDER BY name, slug')
      .all() as OrganizationRow[]
  ).map(toOrganizationView);
}

/**
 * 平台管理只列出真实企业租户。普通注册也会创建 organization 作为个人数据
 * 隔离容器，不能把这些个人空间混入平台企业清单。
 */
export function listEnterpriseOrganizations(): OrganizationView[] {
  return (
    getDB()
      .prepare(
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
      )
      .all() as OrganizationRow[]
  ).map(toOrganizationView);
}

export type OrganizationPositionRoleMapping =
  'member' | 'department_admin' | 'enterprise_admin';

export interface OrganizationPositionView {
  id: string;
  organizationId: string;
  departmentId: string;
  title: string;
  roleMapping: OrganizationPositionRoleMapping;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDepartmentView {
  id: string;
  organizationId: string;
  name: string;
  memberCount: number;
  positions: OrganizationPositionView[];
  createdAt: string;
  updatedAt: string;
}

interface OrganizationDepartmentRow {
  id: string;
  organization_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface OrganizationPositionRow {
  id: string;
  organization_id: string;
  department_id: string;
  title: string;
  role_mapping: OrganizationPositionRoleMapping;
  created_at: string;
  updated_at: string;
}

function toOrganizationPositionView(
  row: OrganizationPositionRow,
): OrganizationPositionView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    departmentId: row.department_id,
    title: row.title,
    roleMapping: row.role_mapping,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listOrganizationStructure(
  organizationId: string,
): OrganizationDepartmentView[] {
  const database = getDB();
  const departments = database
    .prepare(
      `SELECT * FROM organization_departments
     WHERE organization_id = ? ORDER BY name COLLATE NOCASE, id`,
    )
    .all(organizationId) as OrganizationDepartmentRow[];
  const positions = database
    .prepare(
      `SELECT * FROM organization_positions
     WHERE organization_id = ? ORDER BY title COLLATE NOCASE, id`,
    )
    .all(organizationId) as OrganizationPositionRow[];
  const counts = database
    .prepare(
      `SELECT department_id, COUNT(*) AS count FROM accounts
     WHERE organization_id = ? AND deleted_at IS NULL AND status = 'active'
       AND department_id IS NOT NULL
     GROUP BY department_id`,
    )
    .all(organizationId) as Array<{ department_id: string; count: number }>;
  const countByDepartment = new Map(
    counts.map((row) => [row.department_id, Number(row.count)]),
  );
  return departments.map((department) => ({
    id: department.id,
    organizationId: department.organization_id,
    name: department.name,
    memberCount: countByDepartment.get(department.id) ?? 0,
    positions: positions
      .filter((position) => position.department_id === department.id)
      .map(toOrganizationPositionView),
    createdAt: department.created_at,
    updatedAt: department.updated_at,
  }));
}

export function createOrganizationDepartment(input: {
  organizationId: string;
  name: string;
}): OrganizationDepartmentView {
  if (!getOrganization(input.organizationId)) throw new Error('企业不存在');
  const name = normalizeOptionalText(input.name, '部门名称');
  if (!name) throw new Error('部门名称不能为空');
  const id = stableAssignmentId(
    'dept',
    input.organizationId,
    normalizeAssignmentName(name),
  );
  try {
    getDB()
      .prepare(
        `INSERT INTO organization_departments (id, organization_id, name)
       VALUES (?, ?, ?)`,
      )
      .run(id, input.organizationId, name);
  } catch {
    throw new Error('部门名称已存在');
  }
  return listOrganizationStructure(input.organizationId).find(
    (department) => department.id === id,
  )!;
}

export function updateOrganizationDepartment(input: {
  organizationId: string;
  departmentId: string;
  name: string;
}): OrganizationDepartmentView {
  const name = normalizeOptionalText(input.name, '部门名称');
  if (!name) throw new Error('部门名称不能为空');
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const changed = database
      .prepare(
        `UPDATE organization_departments SET name = ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
      )
      .run(name, input.departmentId, input.organizationId);
    if (Number(changed.changes) !== 1) throw new Error('部门不存在');
    database
      .prepare(
        `UPDATE accounts SET department = ?, updated_at = datetime('now')
       WHERE organization_id = ? AND department_id = ?`,
      )
      .run(name, input.organizationId, input.departmentId);
    database
      .prepare(
        `UPDATE employees SET department = ?
       WHERE organization_id = ? AND department_id = ?`,
      )
      .run(name, input.organizationId, input.departmentId);
    database
      .prepare(
        `UPDATE organization_invites SET default_department = ?
       WHERE organization_id = ? AND department_id = ?`,
      )
      .run(name, input.organizationId, input.departmentId);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    if (error instanceof Error && error.message === '部门不存在') throw error;
    throw new Error('部门名称已存在');
  }
  return listOrganizationStructure(input.organizationId).find(
    (department) => department.id === input.departmentId,
  )!;
}

export function deleteOrganizationDepartment(input: {
  organizationId: string;
  departmentId: string;
}): void {
  const database = getDB();
  const positions = database
    .prepare(
      'SELECT COUNT(*) AS count FROM organization_positions WHERE organization_id = ? AND department_id = ?',
    )
    .get(input.organizationId, input.departmentId) as { count: number };
  if (Number(positions.count) > 0) throw new Error('部门仍有岗位，不能删除');
  const members = database
    .prepare(
      `SELECT COUNT(*) AS count FROM accounts
     WHERE organization_id = ? AND department_id = ? AND deleted_at IS NULL`,
    )
    .get(input.organizationId, input.departmentId) as { count: number };
  if (Number(members.count) > 0) throw new Error('部门仍有成员，不能删除');
  const changed = database
    .prepare(
      'DELETE FROM organization_departments WHERE id = ? AND organization_id = ?',
    )
    .run(input.departmentId, input.organizationId);
  if (Number(changed.changes) !== 1) throw new Error('部门不存在');
}

export function createOrganizationPosition(input: {
  organizationId: string;
  departmentId: string;
  title: string;
  roleMapping?: OrganizationPositionRoleMapping;
}): OrganizationPositionView {
  const title = normalizeOptionalText(input.title, '职位名称');
  if (!title) throw new Error('职位名称不能为空');
  const department = getDB()
    .prepare(
      'SELECT id FROM organization_departments WHERE id = ? AND organization_id = ?',
    )
    .get(input.departmentId, input.organizationId);
  if (!department) throw new Error('部门不存在');
  const roleMapping = input.roleMapping ?? 'member';
  const id = stableAssignmentId(
    'pos',
    input.organizationId,
    input.departmentId,
    normalizeAssignmentName(title),
  );
  try {
    getDB()
      .prepare(
        `INSERT INTO organization_positions
        (id, organization_id, department_id, title, role_mapping)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.organizationId, input.departmentId, title, roleMapping);
  } catch {
    throw new Error('该部门下职位名称已存在');
  }
  return listOrganizationStructure(input.organizationId)
    .flatMap((item) => item.positions)
    .find((position) => position.id === id)!;
}

export function updateOrganizationPosition(input: {
  organizationId: string;
  positionId: string;
  title?: string;
  roleMapping?: OrganizationPositionRoleMapping;
}): OrganizationPositionView {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    // 最后管理员检查与批量降权必须处于同一写事务，
    // 否则两个并发职位更新都可能读到对方仍是管理员。
    const current = database
      .prepare(
        'SELECT * FROM organization_positions WHERE id = ? AND organization_id = ?',
      )
      .get(input.positionId, input.organizationId) as
      OrganizationPositionRow | undefined;
    if (!current) throw new Error('职位不存在');
    const title =
      input.title === undefined
        ? current.title
        : normalizeOptionalText(input.title, '职位名称');
    if (!title) throw new Error('职位名称不能为空');
    const roleMapping = input.roleMapping ?? current.role_mapping;
    if (roleMapping !== 'enterprise_admin') {
      const activeMappedAdmins = database
        .prepare(
          `SELECT COUNT(*) AS count FROM accounts
         WHERE organization_id = ? AND position_id = ? AND is_admin = 1
           AND status = 'active' AND deleted_at IS NULL`,
        )
        .get(input.organizationId, input.positionId) as { count: number };
      if (Number(activeMappedAdmins.count) > 0) {
        const otherActiveAdmin = database
          .prepare(
            `SELECT 1 FROM accounts
           WHERE organization_id = ? AND (position_id IS NULL OR position_id <> ?) AND is_admin = 1
             AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
          )
          .get(input.organizationId, input.positionId);
        if (!otherActiveAdmin)
          throw new Error('企业至少需要保留一名可登录管理员');
      }
    }
    const mappedRole =
      roleMapping === 'enterprise_admin'
        ? '企业管理员'
        : roleMapping === 'department_admin'
          ? '部门管理员'
          : '成员';
    database
      .prepare(
        `UPDATE organization_positions
       SET title = ?, role_mapping = ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
      )
      .run(title, roleMapping, input.positionId, input.organizationId);
    database
      .prepare(
        `UPDATE accounts SET position_title = ?,
         role = ?, is_admin = CASE WHEN ? = 'enterprise_admin' THEN 1 ELSE 0 END,
         updated_at = datetime('now')
       WHERE organization_id = ? AND position_id = ?`,
      )
      .run(
        title,
        mappedRole,
        roleMapping,
        input.organizationId,
        input.positionId,
      );
    database
      .prepare(
        `UPDATE employees SET position_title = ?, role = ?
       WHERE organization_id = ? AND position_id = ?`,
      )
      .run(title, mappedRole, input.organizationId, input.positionId);
    database
      .prepare(
        `UPDATE organization_invites SET position_title = ?, default_role = ?
       WHERE organization_id = ? AND position_id = ?`,
      )
      .run(title, mappedRole, input.organizationId, input.positionId);
    database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, datetime('now'))
       WHERE account_id IN (
         SELECT id FROM accounts WHERE organization_id = ? AND position_id = ?
       )`,
      )
      .run(input.organizationId, input.positionId);
    logAudit(
      'organization_position_update',
      null,
      `Position ${input.positionId} mapped to ${roleMapping}`,
      input.organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return listOrganizationStructure(input.organizationId)
    .flatMap((item) => item.positions)
    .find((position) => position.id === input.positionId)!;
}

export function deleteOrganizationPosition(input: {
  organizationId: string;
  positionId: string;
}): void {
  const member = getDB()
    .prepare(
      `SELECT 1 FROM accounts WHERE organization_id = ? AND position_id = ?
     AND deleted_at IS NULL LIMIT 1`,
    )
    .get(input.organizationId, input.positionId);
  if (member) throw new Error('职位仍有成员，不能删除');
  const changed = getDB()
    .prepare(
      'DELETE FROM organization_positions WHERE id = ? AND organization_id = ?',
    )
    .run(input.positionId, input.organizationId);
  if (Number(changed.changes) !== 1) throw new Error('职位不存在');
}

export interface OrganizationFeatures {
  enterprise_tree: boolean;
  park_service: boolean;
  feishu_auto_reply: boolean;
  direct_messages: boolean;
  atoa: boolean;
  knowledge: boolean;
  tui_sync: boolean;
}

const DEFAULT_ORGANIZATION_FEATURES: OrganizationFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  tui_sync: true,
};

function licenseEnforcementEnabled(): boolean {
  return process.env.OTTO_LICENSE_ENFORCE === 'true';
}

function licenseSigningSecret(): string {
  return process.env.OTTO_LICENSE_SIGNING_SECRET || '';
}

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function settingValue(key: string): string | null {
  const row = getDB()
    .prepare('SELECT value FROM deployment_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function setSettingValue(key: string, value: string): void {
  getDB()
    .prepare(
      `INSERT INTO deployment_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value);
}

const deploymentStore = {
  db: getDB,
  readSetting: settingValue,
  writeSetting: setSettingValue,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  licenseEnforcementEnabled: () => process.env.OTTO_LICENSE_ENFORCE === 'true',
  licenseSigningSecret: () => process.env.OTTO_LICENSE_SIGNING_SECRET || '',
  telemetryEndpoint: () => process.env.OTTO_TELEMETRY_ENDPOINT || null,
  databaseReadiness: getDatabaseReadiness,
  audit: (event: string, employeeId: string | null, detail: string, organizationId: string) =>
    logAudit(event, employeeId, detail, organizationId),
};

export function getModuleUpdateManifest(): ModuleUpdateManifest {
  return getModuleUpdateManifestFromStore(moduleUpdateStore);
}

export function updateModuleUpdateDescriptor(input: {
  module: string;
  version?: string;
  rollout?: ModuleUpdateRollout;
  notes?: string | null;
  minAppVersion?: string | null;
  manifestUrl?: string | null;
  sha256?: string | null;
  publishedAt?: string | null;
  actorAccountId?: string | null;
  organizationId?: string;
}): ModuleUpdateDescriptor {
  return updateModuleUpdateDescriptorInStore(moduleUpdateStore, {
    ...input,
    organizationId: input.organizationId ?? DEFAULT_ORGANIZATION_ID,
  });
}

const moduleUpdateStore = {
  readSetting: settingValue,
  writeSetting: setSettingValue,
  deploymentId: getDeploymentId,
  audit: (input: {
    event: string;
    employeeId: string | null;
    message: string;
    organizationId: string;
  }) => logAudit(input.event, input.employeeId, input.message, input.organizationId),
};

export function getDeploymentId(): string {
  return getDeploymentIdFromRepository(deploymentStore);
}

export function getMachineFingerprint(): string {
  return getMachineFingerprintFromRepository();
}

export function getDeploymentLicense(): DeploymentLicenseView {
  return getDeploymentLicenseFromRepository(deploymentStore);
}

export function importDeploymentLicense(raw: unknown): DeploymentLicenseView {
  return importDeploymentLicenseIntoRepository(deploymentStore, raw);
}

export function getTelemetrySettings(): DeploymentTelemetrySettings {
  return getTelemetrySettingsFromRepository(deploymentStore);
}

export function updateTelemetrySettings(
  patch: Partial<DeploymentTelemetrySettings>,
): DeploymentTelemetrySettings {
  return updateTelemetrySettingsInRepository(deploymentStore, patch);
}

export function recordTelemetryEvent(input: {
  organizationId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}): void {
  recordTelemetryEventInRepository(deploymentStore, input);
}

export function getTelemetryQueueSummary(): {
  queued: number;
  failed: number;
  sent: number;
  lastQueuedAt: string | null;
} {
  return getTelemetryQueueSummaryFromRepository(deploymentStore);
}

export function getPrivateDeploymentStatus(): PrivateDeploymentStatus {
  return getPrivateDeploymentStatusFromRepository(deploymentStore);
}

export function exportDeploymentDiagnostics(
  input: { includeRedactedSamples?: boolean } = {},
): Record<string, unknown> {
  return exportDeploymentDiagnosticsFromRepository(deploymentStore, input);
}

export function isLicenseUsableForOrganizationFeature(
  feature: keyof OrganizationFeatures,
): boolean {
  return isLicenseUsableForOrganizationFeatureInRepository(deploymentStore, feature);
}

export function isLicenseRestricted(): boolean {
  return isLicenseRestrictedInRepository(deploymentStore);
}
export function getOrganizationFeatures(
  organizationId: string,
): OrganizationFeatures {
  if (!getOrganization(organizationId)) throw new Error('企业不存在');
  const result = { ...DEFAULT_ORGANIZATION_FEATURES };
  const rows = getDB()
    .prepare(
      'SELECT feature_key, enabled FROM organization_features WHERE organization_id = ?',
    )
    .all(organizationId) as Array<{
    feature_key: keyof OrganizationFeatures;
    enabled: number;
  }>;
  for (const row of rows) {
    if (row.feature_key in result) result[row.feature_key] = row.enabled === 1;
  }
  for (const key of Object.keys(result) as Array<keyof OrganizationFeatures>) {
    if (!isLicenseUsableForOrganizationFeature(key)) result[key] = false;
  }
  return result;
}

export function updateOrganizationFeatures(
  organizationId: string,
  patch: Partial<OrganizationFeatures>,
): OrganizationFeatures {
  const allowed = new Set(Object.keys(DEFAULT_ORGANIZATION_FEATURES));
  const entries = Object.entries(patch).filter(
    (entry): entry is [keyof OrganizationFeatures, boolean] =>
      allowed.has(entry[0]) && typeof entry[1] === 'boolean',
  );
  if (entries.length === 0) throw new Error('至少需要一个有效功能开关');
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = database
      .prepare('SELECT 1 FROM organizations WHERE id = ?')
      .get(organizationId);
    if (!organization) throw new Error('企业不存在');
    const statement = database.prepare(
      `INSERT INTO organization_features (organization_id, feature_key, enabled, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(organization_id, feature_key)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
    for (const [key, enabled] of entries)
      statement.run(organizationId, key, enabled ? 1 : 0);
    logAudit(
      'organization_features_update',
      null,
      `Feature switches updated: ${entries.map(([key, enabled]) => `${key}=${enabled}`).join(', ')}`,
      organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getOrganizationFeatures(organizationId);
}

/** 平台企业面板只能访问企业租户，个人空间按不存在处理。 */
export function getEnterpriseOrganization(id: string): OrganizationView | null {
  const row = getDB()
    .prepare(
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
    )
    .get(id) as OrganizationRow | undefined;
  return row ? toOrganizationView(row) : null;
}

function normalizeOrganizationInviteCode(code: string): string {
  const compact = code.trim().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Za-km-z2-9]+$/.test(compact) ? compact : '';
}

function deriveOrganizationInviteCode(
  organization: OrganizationRow,
  nonce: string,
): string {
  const digest = createHmac('sha256', organization.invite_secret)
    .update(`${organization.id}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < INVITE_CODE_RAW_LENGTH; index += 1) {
    code +=
      ORGANIZATION_INVITE_ALPHABET[
        digest[index]! % ORGANIZATION_INVITE_ALPHABET.length
      ];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function toOrganizationInviteView(
  row: OrganizationInviteRow,
  organization: OrganizationRow,
  now: number,
): OrganizationInviteView {
  const status =
    row.revoked_at_ms != null
      ? 'revoked'
      : now >= row.expires_at_ms
        ? 'expired'
        : 'active';
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

export type OrganizationInviteStatus =
  'active' | 'expired' | 'revoked' | 'invalid';

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
  if (normalized.length !== INVITE_CODE_RAW_LENGTH)
    return { status: 'invalid', organizationId: null };

  // 邀请码由 nonce 动态派生，库中没有可直接索引的明文 code；必须保留已撤销/
  // 已过期记录，公开落地页才能正确区分 404 与 410。先在 SQL 层排除已停用企业，
  // 再恒定时间比对候选 code，不能引用 organization_invites 中不存在的 status 列。
  const rows = getDB()
    .prepare(
      `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE o.status = 'active'
     ORDER BY i.issued_at_ms DESC`,
    )
    .all() as Array<OrganizationInviteRow & Omit<OrganizationRow, 'id'>>;
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
    return (
      expected.length === normalized.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    );
  });
  if (matches.length !== 1) return { status: 'invalid', organizationId: null };

  const match = matches[0]!;
  if (match.status !== 'active')
    return { status: 'invalid', organizationId: null };
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

function normalizeOptionalText(
  value: string | null | undefined,
  label: string,
  maxLength = 80,
): string | null {
  const clean = value?.trim() || null;
  if (clean && clean.length > maxLength)
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return clean;
}

function normalizeAssignmentName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');
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

export interface AssignmentIdentity {
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
export function resolveAssignmentIdentity(
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
  const requestedDepartmentId = normalizeOptionalText(
    input.departmentId,
    '部门 ID',
    120,
  );
  const positionTitle = normalizeOptionalText(input.positionTitle, '职位名称');
  const requestedPositionId = normalizeOptionalText(
    input.positionId,
    '职位 ID',
    120,
  );
  if (!department && requestedDepartmentId)
    throw new Error('设置部门 ID 时必须同时提供部门名称');
  if (!positionTitle && requestedPositionId)
    throw new Error('设置职位 ID 时必须同时提供职位名称');

  const departmentRows = database
    .prepare(
      `SELECT id, name FROM organization_departments WHERE organization_id = ?
     UNION ALL
     SELECT department_id AS id, department AS name FROM accounts
       WHERE organization_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT department_id AS id, department AS name FROM employees
       WHERE organization_id = ?
     UNION ALL
     SELECT department_id AS id, default_department AS name FROM organization_invites
       WHERE organization_id = ?`,
    )
    .all(
      organizationId,
      organizationId,
      organizationId,
      organizationId,
    ) as Array<{
    id: string | null;
    name: string | null;
  }>;
  const normalizedDepartment = department
    ? normalizeAssignmentName(department)
    : null;
  const existingDepartment = normalizedDepartment
    ? departmentRows.find(
        (row) =>
          row.id &&
          row.name &&
          normalizeAssignmentName(row.name) === normalizedDepartment,
      )
    : undefined;
  if (
    requestedDepartmentId &&
    existingDepartment?.id &&
    existingDepartment.id !== requestedDepartmentId
  ) {
    throw new Error('该部门名称已绑定其他部门 ID');
  }
  if (requestedDepartmentId) {
    const conflicting = departmentRows.find(
      (row) =>
        row.id === requestedDepartmentId &&
        row.name &&
        normalizeAssignmentName(row.name) !== normalizedDepartment,
    );
    if (conflicting) throw new Error('该部门 ID 已绑定其他部门名称');
  }
  const departmentId = department
    ? (requestedDepartmentId ??
      existingDepartment?.id ??
      stableAssignmentId('dept', organizationId, normalizedDepartment))
    : null;

  const positionRows = database
    .prepare(
      `SELECT id, title, department_id FROM organization_positions WHERE organization_id = ?
     UNION ALL
     SELECT position_id AS id, position_title AS title, department_id
       FROM accounts WHERE organization_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT position_id AS id, position_title AS title, department_id
       FROM employees WHERE organization_id = ?
     UNION ALL
     SELECT position_id AS id, position_title AS title, department_id
       FROM organization_invites WHERE organization_id = ?`,
    )
    .all(
      organizationId,
      organizationId,
      organizationId,
      organizationId,
    ) as Array<{
    id: string | null;
    title: string | null;
    department_id: string | null;
  }>;
  const normalizedPosition = positionTitle
    ? normalizeAssignmentName(positionTitle)
    : null;
  const existingPosition = normalizedPosition
    ? positionRows.find(
        (row) =>
          row.id &&
          row.title &&
          row.department_id === departmentId &&
          normalizeAssignmentName(row.title) === normalizedPosition,
      )
    : undefined;
  if (
    requestedPositionId &&
    existingPosition?.id &&
    existingPosition.id !== requestedPositionId
  ) {
    throw new Error('该职位名称已绑定其他职位 ID');
  }
  if (requestedPositionId) {
    const conflicting = positionRows.find(
      (row) =>
        row.id === requestedPositionId &&
        (row.department_id !== departmentId ||
          !row.title ||
          normalizeAssignmentName(row.title) !== normalizedPosition),
    );
    if (conflicting) throw new Error('该职位 ID 已绑定其他部门或职位名称');
  }
  const positionId = positionTitle
    ? (requestedPositionId ??
      existingPosition?.id ??
      stableAssignmentId(
        'pos',
        organizationId,
        departmentId,
        normalizedPosition,
      ))
    : null;

  // 任意管理员输入的部门/职位都落入同一份持久化目录，组织树与邀请不会再依赖
  // “恰好已有成员”才能看到节点。旧调用方无需迁移即可自动补齐目录。
  if (department && departmentId) {
    database
      .prepare(
        `INSERT OR IGNORE INTO organization_departments (id, organization_id, name)
       VALUES (?, ?, ?)`,
      )
      .run(departmentId, organizationId, department);
  }
  if (positionTitle && positionId && departmentId) {
    database
      .prepare(
        `INSERT OR IGNORE INTO organization_positions
        (id, organization_id, department_id, title, role_mapping)
       VALUES (?, ?, ?, ?, 'member')`,
      )
      .run(positionId, organizationId, departmentId, positionTitle);
  }

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
    const organization = database
      .prepare('SELECT * FROM organizations WHERE id = ? AND status = ?')
      .get(organizationId, 'active') as OrganizationRow | undefined;
    if (!organization) throw new Error('Organization not found');
    const id = `orginvite_${randomUUID()}`;
    const nonce = randomBytes(24).toString('base64url');
    const expiresAtMs = now + ORGANIZATION_INVITE_VALIDITY_MS;
    const options =
      typeof input === 'string' ? { defaultDepartment: input } : (input ?? {});
    const assignment = resolveAssignmentIdentity(database, organizationId, {
      department: options.defaultDepartment,
      departmentId: options.departmentId,
      positionId: options.positionId,
      positionTitle: options.positionTitle,
    });
    const defaultRole = normalizeOptionalText(options.defaultRole, '角色');
    const maxUses =
      options.maxUses == null ? null : Math.floor(Number(options.maxUses));
    if (
      maxUses != null &&
      (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 10_000)
    ) {
      throw new Error('邀请码可注册人数必须在 1 到 10000 之间');
    }
    database
      .prepare(
        `INSERT INTO organization_invites
         (id, organization_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id,
          default_department, department_id, position_id, position_title, default_role, max_uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    database
      .prepare(
        `UPDATE organization_invites SET revoked_at_ms = ?
       WHERE organization_id = ? AND id <> ? AND revoked_at_ms IS NULL`,
      )
      .run(now, organizationId, id);
    logAudit(
      'organization_invite_issue',
      null,
      [assignment.department, assignment.positionTitle, defaultRole].filter(
        Boolean,
      ).length
        ? `Position invite issued for ${[
            assignment.department,
            assignment.positionTitle,
            defaultRole,
          ]
            .filter(Boolean)
            .join(' / ')}`
        : 'Registration invite issued for 7 days',
      organizationId,
    );
    const row = database
      .prepare('SELECT * FROM organization_invites WHERE id = ?')
      .get(id) as OrganizationInviteRow;
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
  const organization = getDB()
    .prepare('SELECT * FROM organizations WHERE id = ?')
    .get(organizationId) as OrganizationRow | undefined;
  if (!organization) return null;
  const row = getDB()
    .prepare(
      `SELECT * FROM organization_invites
     WHERE organization_id = ? ORDER BY issued_at_ms DESC LIMIT 1`,
    )
    .get(organizationId) as OrganizationInviteRow | undefined;
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
  if (normalized.length !== INVITE_CODE_RAW_LENGTH) return null;
  const rows = getDB()
    .prepare(
      `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.revoked_at_ms IS NULL AND i.expires_at_ms > ? AND o.status = 'active'`,
    )
    .all(now) as Array<OrganizationInviteRow & Omit<OrganizationRow, 'id'>>;
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
    return (
      expected.length === normalized.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    );
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

export function resolveOrganizationInvite(
  code: string,
  now = Date.now(),
): OrganizationView | null {
  return resolveOrganizationInviteWithDefaults(code, now)?.organization ?? null;
}

interface CurrentInvitationAssignment {
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  role: string;
  isAdmin: boolean;
}

/**
 * 邀请码只保存签发时快照；真正入企时必须在当前事务内重新读取组织目录。
 * 这样已删除或被移到其他部门的职位不能被旧邀请码复活，职位权限映射也始终
 * 是账号与员工档案的唯一权限真值。
 */
function resolveCurrentInvitationAssignment(
  database: Database,
  organizationId: string,
  input: {
    departmentId: string | null;
    positionId: string | null;
    defaultRole: string | null;
  },
): CurrentInvitationAssignment {
  const organization = database
    .prepare(`SELECT 1 FROM organizations WHERE id = ? AND status = 'active'`)
    .get(organizationId);
  if (!organization) throw new Error('企业不存在或已停用');

  const department = input.departmentId
    ? (database
        .prepare(
          `SELECT * FROM organization_departments WHERE id = ? AND organization_id = ?`,
        )
        .get(input.departmentId, organizationId) as
        OrganizationDepartmentRow | undefined)
    : undefined;
  if (input.departmentId && !department) throw new Error('部门不存在');
  if (input.positionId && !department) throw new Error('职位必须属于有效部门');

  const position = input.positionId
    ? (database
        .prepare(
          `SELECT * FROM organization_positions WHERE id = ? AND organization_id = ?`,
        )
        .get(input.positionId, organizationId) as
        OrganizationPositionRow | undefined)
    : undefined;
  if (input.positionId && !position) throw new Error('职位不存在');
  if (position && position.department_id !== department!.id) {
    throw new Error('职位与部门不一致');
  }

  const role =
    position?.role_mapping === 'enterprise_admin'
      ? '企业管理员'
      : position?.role_mapping === 'department_admin'
        ? '部门管理员'
        : position
          ? '成员'
          : input.defaultRole?.trim() || '成员';
  return {
    department: department?.name ?? null,
    departmentId: department?.id ?? null,
    positionId: position?.id ?? null,
    positionTitle: position?.title ?? null,
    role,
    isAdmin: position?.role_mapping === 'enterprise_admin',
  };
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

export interface AccountRow {
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
  else if (digits.startsWith('86') && digits.length === 13)
    digits = digits.slice(2);
  if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error('手机号格式不正确');
  return `+86${digits}`;
}

function normalizeOptionalPhone(
  phone: string | null | undefined,
): string | null {
  if (phone == null || !phone.trim()) return null;
  return normalizePhone(phone);
}

function normalizeOptionalFeishuOpenId(
  value: string | null | undefined,
): string | null {
  if (value == null || !value.trim()) return null;
  const openId = value.trim();
  if (!/^ou_[A-Za-z0-9_-]+$/.test(openId))
    throw new Error('飞书 open_id 格式不正确');
  return openId;
}

function normalizeOptionalAvatarUrl(
  value: string | null | undefined,
): string | null {
  if (value == null || !value.trim()) return null;
  const avatarUrl = value.trim();
  if (/^https:\/\//i.test(avatarUrl)) {
    if (avatarUrl.length > 2_000)
      throw new Error('头像地址不能超过 2000 个字符');
    try {
      if (new URL(avatarUrl).protocol !== 'https:') throw new Error();
    } catch {
      throw new Error('头像地址格式不正确');
    }
    return avatarUrl;
  }
  const match =
    /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
      avatarUrl,
    );
  if (!match)
    throw new Error(
      '头像仅支持 HTTPS 或 PNG、JPEG、WebP、GIF 格式的 data:image',
    );
  if (
    avatarUrl.length > 700_000 ||
    Buffer.from(match[2]!, 'base64').byteLength > 512 * 1024
  ) {
    throw new Error('头像数据不能超过 512KB');
  }
  return avatarUrl;
}

export function normalizeTags(tags: string[] | undefined): string[] {
  return [
    ...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, 'zh-CN'));
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
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

function assertAccountPassword(password: string): void {
  if (password.length < 8) throw new Error('登录密码至少需要 8 位');
  if (password.length > 128) throw new Error('登录密码不能超过 128 位');
  if (/[^\x20-\x7E]/.test(password)) throw new Error('登录密码不能包含控制字符或不可见字符');
  const lower = password.toLocaleLowerCase('en-US');
  if (['password', 'password1', '12345678', '123456789', 'qwerty123'].includes(lower)) {
    throw new Error('登录密码过于常见，请更换更安全的密码');
  }
  if (/^\d+$/.test(password) || /^[a-z]+$/i.test(password)) {
    throw new Error('登录密码不能只包含数字或字母');
  }
  if (/^(.)\1{7,}$/.test(password)) {
    throw new Error('登录密码不能使用连续重复字符');
  }
}

export function isAcceptableAccountPassword(password: string): boolean {
  try {
    assertAccountPassword(password);
    return true;
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tagsForAccount(accountId: string, organizationId: string): string[] {
  return (
    getDB()
      .prepare(
        'SELECT tag FROM account_tags WHERE account_id = ? AND organization_id = ? ORDER BY tag',
      )
      .all(accountId, organizationId) as Array<{ tag: string }>
  ).map((row) => row.tag);
}

export function toAccountView(row: AccountRow): AccountView {
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

function replaceAccountTags(
  accountId: string,
  organizationId: string,
  tags: string[],
): void {
  const database = getDB();
  database
    .prepare(
      'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
    )
    .run(accountId, organizationId);
  const insert = database.prepare(
    'INSERT INTO account_tags (organization_id, account_id, tag) VALUES (?, ?, ?)',
  );
  for (const tag of normalizeTags(tags))
    insert.run(organizationId, accountId, tag);
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
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const username = normalizeUsername(input.username);
  const name = input.name.trim();
  if (!username || !name || !input.password)
    throw new Error('username, password and name required');
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
  const positionMapping = assignment.positionId
    ? (database
        .prepare(
          `SELECT role_mapping FROM organization_positions
     WHERE id = ? AND organization_id = ?`,
        )
        .get(assignment.positionId, organizationId) as
        | {
            role_mapping: OrganizationPositionRoleMapping;
          }
        | undefined)
    : undefined;
  const mappedRole =
    positionMapping?.role_mapping === 'enterprise_admin'
      ? '企业管理员'
      : positionMapping?.role_mapping === 'department_admin'
        ? '部门管理员'
        : positionMapping
          ? '成员'
          : null;
  const effectiveRole = positionMapping
    ? mappedRole
    : input.role?.trim() || null;
  const effectiveIsAdmin = positionMapping
    ? positionMapping.role_mapping === 'enterprise_admin'
    : (input.isAdmin ?? false);
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
        role: effectiveRole || undefined,
        department: assignment.department || undefined,
        departmentId: assignment.departmentId || undefined,
        positionId: assignment.positionId || undefined,
        positionTitle: assignment.positionTitle || undefined,
      });
    }
    database
      .prepare(
        `INSERT INTO accounts
       (id, organization_id, account_type, employee_id, username, phone, feishu_open_id, password_hash,
        name, role, department, department_id, position_id, position_title, avatar_url, is_admin, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        organizationId,
        accountType,
        employeeId,
        username,
        normalizeOptionalPhone(input.phone),
        normalizeOptionalFeishuOpenId(input.feishuOpenId),
        passwordHash(input.password),
        name,
        effectiveRole,
        assignment.department,
        assignment.departmentId,
        assignment.positionId,
        assignment.positionTitle,
        normalizeOptionalAvatarUrl(input.avatarUrl),
        effectiveIsAdmin ? 1 : 0,
        status,
      );
    replaceAccountTags(id, organizationId, input.tags ?? []);
    logAudit(
      'account_create',
      employeeId,
      `Preset account ${username} created`,
      organizationId,
    );
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
    const invite = issueOrganizationInvite(
      organization.id,
      input.now ?? Date.now(),
      admin.id,
    );
    database.exec('COMMIT');
    return { organization, admin, invite };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function getAccount(
  id: string,
  organizationId?: string,
): AccountView | null {
  const row = (
    organizationId
      ? getDB()
          .prepare(
            'SELECT * FROM accounts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
          )
          .get(id, organizationId)
      : getDB()
          .prepare('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL')
          .get(id)
  ) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function listAccounts(
  organizationId = DEFAULT_ORGANIZATION_ID,
): AccountView[] {
  return (
    getDB()
      .prepare(
        'SELECT * FROM accounts WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name, username',
      )
      .all(organizationId) as AccountRow[]
  ).map(toAccountView);
}

export interface AccountPresenceView {
  accountId: string;
  online: boolean;
  lastSeenAt: string | null;
}

interface AccountPresenceRow {
  account_id: string;
  last_seen_at_ms: number;
}

export function touchAccountPresence(input: {
  organizationId: string;
  accountId: string;
  clientId?: string | null;
  nowMs?: number;
}): AccountPresenceView {
  const nowMs = Number.isFinite(input.nowMs)
    ? Math.floor(input.nowMs!)
    : Date.now();
  const clientId =
    (input.clientId || 'default').trim().slice(0, 120) || 'default';
  getDB()
    .prepare(
      `INSERT INTO account_presence
      (organization_id, account_id, client_id, last_seen_at_ms, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(organization_id, account_id, client_id)
     DO UPDATE SET last_seen_at_ms = excluded.last_seen_at_ms, updated_at = datetime('now')`,
    )
    .run(input.organizationId, input.accountId, clientId, nowMs);
  return {
    accountId: input.accountId,
    online: true,
    lastSeenAt: new Date(nowMs).toISOString(),
  };
}

export function listAccountPresence(
  organizationId: string,
  onlineWindowMs = 60_000,
  nowMs = Date.now(),
): AccountPresenceView[] {
  const rows = getDB()
    .prepare(
      `SELECT account_id, MAX(last_seen_at_ms) AS last_seen_at_ms
     FROM account_presence
     WHERE organization_id = ?
     GROUP BY account_id`,
    )
    .all(organizationId) as AccountPresenceRow[];
  return rows.map((row) => ({
    accountId: row.account_id,
    online: nowMs - Number(row.last_seen_at_ms) <= onlineWindowMs,
    lastSeenAt: Number.isFinite(Number(row.last_seen_at_ms))
      ? new Date(Number(row.last_seen_at_ms)).toISOString()
      : null,
  }));
}

export function authenticateAccount(
  identifier: string,
  password: string,
): AccountView | null {
  const normalized = normalizeUsername(identifier);
  let row = getDB()
    .prepare(
      'SELECT * FROM accounts WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL',
    )
    .get(normalized) as AccountRow | undefined;
  if (!row) {
    try {
      row = getDB()
        .prepare(
          'SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL',
        )
        .get(normalizePhone(identifier)) as AccountRow | undefined;
    } catch {
      // 不是手机号时继续按“账号或密码错误”处理，避免泄露账号是否存在。
    }
  }
  if (
    !row ||
    row.status !== 'active' ||
    getOrganization(row.organization_id)?.status !== 'active' ||
    !passwordMatches(password, row.password_hash)
  )
    return null;
  return toAccountView(row);
}

export function findAccountByPhone(phone: string): AccountView | null {
  const normalized = normalizePhone(phone);
  const row = getDB()
    .prepare('SELECT * FROM accounts WHERE phone = ? AND deleted_at IS NULL')
    .get(normalized) as AccountRow | undefined;
  return row ? toAccountView(row) : null;
}

export function findActiveAccountByPhone(phone: string): AccountView | null {
  const account = findAccountByPhone(phone);
  return account?.status === 'active' ? account : null;
}

/** 飞书发送方已绑定企业账号时，按租户开关决定是否允许自动回答。 */
export function isFeishuAutoReplyEnabledForOpenId(openId: string): boolean {
  const normalized = openId.trim();
  if (!normalized) return false;
  const rows = getDB()
    .prepare(
      `SELECT DISTINCT organization_id FROM accounts
     WHERE feishu_open_id = ? AND status = 'active' AND deleted_at IS NULL`,
    )
    .all(normalized) as Array<{ organization_id: string }>;
  // 旧的纯飞书 allowlist 用户尚未绑定企业账号时保持兼容；一旦绑定，所有关联
  // 租户都必须允许自动回答，避免同一 open_id 借另一个租户绕过关闭开关。
  return (
    rows.length === 0 ||
    rows.every(
      (row) => getOrganizationFeatures(row.organization_id).feishu_auto_reply,
    )
  );
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
    let assignment: CurrentInvitationAssignment;
    if (input.organizationInviteId) {
      const invite = database
        .prepare(
          `SELECT department_id, position_id, default_role
         FROM organization_invites
         WHERE id = ? AND organization_id = ?
           AND revoked_at_ms IS NULL AND expires_at_ms > ?
           AND (max_uses IS NULL OR used_count < max_uses)`,
        )
        .get(input.organizationInviteId, input.organizationId, Date.now()) as
        | {
            department_id: string | null;
            position_id: string | null;
            default_role: string | null;
          }
        | undefined;
      if (!invite)
        throw new Error('企业邀请码可用名额已用完，请联系管理员重新生成');
      assignment = resolveCurrentInvitationAssignment(
        database,
        input.organizationId,
        {
          departmentId: invite.department_id,
          positionId: invite.position_id,
          defaultRole: invite.default_role,
        },
      );
    } else {
      const normalized = resolveAssignmentIdentity(
        database,
        input.organizationId,
        {
          department: input.department,
          departmentId: input.departmentId,
          positionId: input.positionId,
          positionTitle: input.positionTitle,
        },
      );
      assignment = resolveCurrentInvitationAssignment(
        database,
        input.organizationId,
        {
          departmentId: normalized.departmentId,
          positionId: normalized.positionId,
          defaultRole: input.role ?? null,
        },
      );
    }
    const employeeId = `emp_${randomUUID()}`;
    createEmployee({
      id: employeeId,
      organizationId: input.organizationId,
      name: input.name,
      role: assignment.role,
      department: assignment.department || undefined,
      departmentId: assignment.departmentId || undefined,
      positionId: assignment.positionId || undefined,
      positionTitle: assignment.positionTitle || undefined,
    });
    const account = createAccount({
      organizationId: input.organizationId,
      accountType: 'enterprise',
      employeeId,
      username: `otto_${digits.slice(-4)}_${randomBytes(4).toString('hex')}`,
      password: input.password,
      name: input.name,
      phone: normalized,
      role: assignment.role,
      department: assignment.department,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      positionTitle: assignment.positionTitle,
      tags: ['普通成员'],
      isAdmin: assignment.isAdmin,
    });
    if (input.organizationInviteId) {
      const reserved = database
        .prepare(
          `UPDATE organization_invites
         SET used_count = used_count + 1
         WHERE id = ? AND organization_id = ?
           AND revoked_at_ms IS NULL AND expires_at_ms > ?
           AND (max_uses IS NULL OR used_count < max_uses)`,
        )
        .run(input.organizationInviteId, input.organizationId, Date.now());
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
    if (findAccountByPhone(normalized))
      throw new Error('该手机号已注册，请直接登录');
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
  if (findAccountByPhone(normalized))
    throw new Error('该手机号已注册，请直接登录');
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
    if (findAccountByPhone(normalized))
      throw new Error('该手机号已注册，请直接登录');
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
    const assignment = resolveCurrentInvitationAssignment(
      database,
      invite.organization.id,
      {
        departmentId: invite.departmentId,
        positionId: invite.positionId,
        defaultRole: invite.defaultRole,
      },
    );

    const employeeId = `emp_${randomUUID()}`;
    createEmployee({
      id: employeeId,
      organizationId: invite.organization.id,
      name: current.name,
      role: assignment.role,
      department: assignment.department || undefined,
      departmentId: assignment.departmentId || undefined,
      positionId: assignment.positionId || undefined,
      positionTitle: assignment.positionTitle || undefined,
      invite_code: normalizeOrganizationInviteCode(inviteCode),
    });

    const reserved = database
      .prepare(
        `UPDATE organization_invites
       SET used_count = used_count + 1
       WHERE id = ? AND organization_id = ?
         AND revoked_at_ms IS NULL AND expires_at_ms > ?
         AND (max_uses IS NULL OR used_count < max_uses)`,
      )
      .run(invite.inviteId, invite.organization.id, now);
    if (Number(reserved.changes) !== 1) {
      throw new Error('企业邀请码无效、已过期或名额已用完');
    }

    const moved = database
      .prepare(
        `UPDATE accounts
       SET organization_id = ?, account_type = 'enterprise', employee_id = ?,
           role = ?, department = ?, department_id = ?, position_id = ?, position_title = ?,
           is_admin = ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ? AND account_type = 'personal'
         AND deleted_at IS NULL AND status = 'active'`,
      )
      .run(
        invite.organization.id,
        employeeId,
        assignment.role,
        assignment.department,
        assignment.departmentId,
        assignment.positionId,
        assignment.positionTitle,
        assignment.isAdmin ? 1 : 0,
        current.id,
        current.organizationId,
      );
    if (Number(moved.changes) !== 1)
      throw new Error('只有个人版账号可加入企业');

    database
      .prepare(
        'UPDATE auth_sessions SET organization_id = ? WHERE account_id = ? AND revoked_at IS NULL',
      )
      .run(invite.organization.id, current.id);
    // 标签是企业内身份，不得把旧个人空间标签带进新租户；
    // account_tags 的历史主键也不含 organization_id，需先清理再建立企业标签。
    database
      .prepare('DELETE FROM account_tags WHERE account_id = ?')
      .run(current.id);
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

export function updateAccount(
  id: string,
  patch: {
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
  },
  organizationId?: string,
): AccountView {
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = getAccount(id, organizationId);
    if (!current) throw new Error('Account not found');

    const assignmentChanged = [
      patch.department,
      patch.departmentId,
      patch.positionId,
      patch.positionTitle,
    ].some((value) => value !== undefined);
    const assignment = assignmentChanged
      ? resolveAssignmentIdentity(database, current.organizationId, {
          department:
            patch.department !== undefined
              ? patch.department
              : current.department,
          departmentId:
            patch.departmentId !== undefined ? patch.departmentId : undefined,
          positionTitle:
            patch.positionTitle !== undefined
              ? patch.positionTitle
              : current.positionTitle,
          positionId:
            patch.positionId !== undefined ? patch.positionId : undefined,
        })
      : null;
    const positionMapping = assignment?.positionId
      ? (database
          .prepare(
            `SELECT role_mapping FROM organization_positions
       WHERE id = ? AND organization_id = ?`,
          )
          .get(assignment.positionId, current.organizationId) as
          | {
              role_mapping: OrganizationPositionRoleMapping;
            }
          | undefined)
      : undefined;
    const mappedRole =
      positionMapping?.role_mapping === 'enterprise_admin'
        ? '企业管理员'
        : positionMapping?.role_mapping === 'department_admin'
          ? '部门管理员'
          : positionMapping
            ? '成员'
            : null;
    // 真实职位 ID 是权限源。只要将成员安排到目录职位，就按
    // role_mapping 双向升/降权，不允许前端同时传 role/isAdmin 绕过映射。
    const nextIsAdmin = positionMapping
      ? positionMapping.role_mapping === 'enterprise_admin'
      : (patch.isAdmin ?? current.isAdmin);
    const nextStatus = patch.status ?? current.status;
    const removesActiveAdmin =
      current.isAdmin &&
      current.status === 'active' &&
      (!nextIsAdmin || nextStatus === 'disabled');
    if (removesActiveAdmin) {
      const other = database
        .prepare(
          `SELECT 1 FROM accounts
         WHERE organization_id = ? AND id <> ? AND is_admin = 1 AND status = 'active'
         LIMIT 1`,
        )
        .get(current.organizationId, current.id);
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
    if (patch.phone !== undefined)
      set('phone', normalizeOptionalPhone(patch.phone));
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
    if (mappedRole !== null) set('role', mappedRole);
    else if (patch.role !== undefined) set('role', patch.role?.trim() || null);
    if (assignment) {
      set('department', assignment.department);
      set('department_id', assignment.departmentId);
      set('position_id', assignment.positionId);
      set('position_title', assignment.positionTitle);
    }
    if (patch.avatarUrl !== undefined)
      set('avatar_url', normalizeOptionalAvatarUrl(patch.avatarUrl));
    if (positionMapping) set('is_admin', nextIsAdmin ? 1 : 0);
    else if (patch.isAdmin !== undefined)
      set('is_admin', patch.isAdmin ? 1 : 0);
    if (patch.status !== undefined) set('status', patch.status);
    if (assignments.length > 0) {
      assignments.push("updated_at = datetime('now')");
      try {
        const sql = organizationId
          ? `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ? AND organization_id = ?`
          : `UPDATE accounts SET ${assignments.join(', ')} WHERE id = ?`;
        database
          .prepare(sql)
          .run(...values, id, ...(organizationId ? [organizationId] : []));
      } catch (error) {
        if (/accounts\.phone|idx_accounts_phone_unique/i.test(String(error))) {
          throw new Error('手机号已绑定其他账号');
        }
        throw error;
      }
    }
    if (patch.tags !== undefined)
      replaceAccountTags(id, current.organizationId, patch.tags);

    const shouldRevokeSessions =
      patch.password !== undefined ||
      (patch.status !== undefined && patch.status !== current.status) ||
      nextIsAdmin !== current.isAdmin ||
      (mappedRole !== null && mappedRole !== current.role) ||
      assignmentChanged;
    if (shouldRevokeSessions) {
      database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL",
        )
        .run(id);
    }

    const updated = getAccount(id, organizationId)!;
    if (
      current.employeeId &&
      [
        patch.name,
        patch.role,
        patch.department,
        patch.departmentId,
        patch.positionId,
        patch.positionTitle,
      ].some((value) => value !== undefined)
    ) {
      database
        .prepare(
          `UPDATE employees
         SET name = ?, role = ?, department = ?, department_id = ?, position_id = ?, position_title = ?
         WHERE id = ? AND organization_id = ?`,
        )
        .run(
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
      const other = database
        .prepare(
          `SELECT 1 FROM accounts
         WHERE organization_id = ? AND id <> ? AND is_admin = 1
           AND status = 'active' AND deleted_at IS NULL
         LIMIT 1`,
        )
        .get(organizationId, id);
      if (!other) throw new Error('企业至少需要保留一名可登录管理员');
    }

    database
      .prepare(
        `UPDATE accounts SET
         employee_id = NULL,
         username = ?,
         phone = NULL,
         feishu_open_id = NULL,
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
      )
      .run(
        `deleted_${id}`,
        passwordHash(randomBytes(32).toString('base64url')),
        id,
        organizationId,
      );
    database
      .prepare(
        'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
      )
      .run(id, organizationId);
    database
      .prepare(
        "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE account_id = ? AND revoked_at IS NULL",
      )
      .run(id);
    if (current.employeeId) {
      database
        .prepare(
          `UPDATE employees SET status = 'offboarded', offboarded_at = datetime('now')
         WHERE id = ? AND organization_id = ?`,
        )
        .run(current.employeeId, organizationId);
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

export function createAuthSession(
  accountId: string,
  ttlMs = 30 * 24 * 60 * 60 * 1000,
): {
  token: string;
  expiresAt: string;
} {
  const account = getAccount(accountId);
  if (
    !account ||
    getOrganization(account.organizationId)?.status !== 'active'
  ) {
    throw new Error('Account not found');
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDB()
    .prepare(
      `INSERT INTO auth_sessions (id, organization_id, account_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `session_${randomUUID()}`,
      account.organizationId,
      accountId,
      tokenHash(token),
      expiresAt,
    );
  return { token, expiresAt };
}

export function getAccountBySession(token: string): AccountView | null {
  if (!token) return null;
  const row = getDB()
    .prepare(
      `SELECT a.* FROM auth_sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN organizations o ON o.id = a.organization_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL
       AND a.status = 'active' AND a.deleted_at IS NULL AND o.status = 'active'`,
    )
    .get(tokenHash(token)) as AccountRow | undefined;
  if (!row) return null;
  const session = getDB()
    .prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash(token)) as { expires_at: string } | undefined;
  if (!session || new Date(session.expires_at).getTime() <= Date.now())
    return null;
  getDB()
    .prepare(
      "UPDATE auth_sessions SET last_used_at = datetime('now') WHERE token_hash = ?",
    )
    .run(tokenHash(token));
  return toAccountView(row);
}

export function revokeAuthSession(token: string): void {
  if (!token) return;
  getDB()
    .prepare(
      "UPDATE auth_sessions SET revoked_at = datetime('now') WHERE token_hash = ?",
    )
    .run(tokenHash(token));
}

const SMS_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SMS_CHALLENGE_COOLDOWN_MS = 60 * 1000;
const SMS_CHALLENGE_HOURLY_LIMIT = 5;
const SMS_CHALLENGE_MAX_ATTEMPTS = 5;

export type SmsChallengeIssueResult =
  | {
      ok: true;
      challengeId: string;
      expiresAt: string;
      retryAfterSeconds: number;
    }
  | {
      ok: false;
      reason: 'cooldown' | 'hourly_limit';
      retryAfterSeconds: number;
    };

export function createSmsLoginChallenge(
  accountId: string,
  code: string,
  options: { now?: number } = {},
): SmsChallengeIssueResult {
  if (!/^\d{6}$/.test(code)) throw new Error('验证码必须是 6 位数字');
  const account = getAccount(accountId);
  if (!account || account.status !== 'active' || !account.phone)
    throw new Error('Account not available for SMS login');

  const now = options.now ?? Date.now();
  const recent = getDB()
    .prepare(
      `SELECT created_at_ms FROM sms_login_challenges
     WHERE account_id = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC`,
    )
    .all(accountId, now - 60 * 60 * 1000) as Array<{ created_at_ms: number }>;
  const latest = recent[0]?.created_at_ms;
  if (latest != null && now - latest < SMS_CHALLENGE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil(
        (latest + SMS_CHALLENGE_COOLDOWN_MS - now) / 1000,
      ),
    };
  }
  if (recent.length >= SMS_CHALLENGE_HOURLY_LIMIT) {
    const oldest = recent[recent.length - 1]!.created_at_ms;
    return {
      ok: false,
      reason: 'hourly_limit',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000),
      ),
    };
  }

  const challengeId = `sms_${randomUUID()}`;
  const expiresAtMs = now + SMS_CHALLENGE_TTL_MS;
  getDB()
    .prepare(
      `INSERT INTO sms_login_challenges
       (id, organization_id, account_id, code_hash, expires_at_ms, attempts_remaining, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  getDB()
    .prepare(
      'DELETE FROM sms_login_challenges WHERE id = ? AND consumed_at_ms IS NULL',
    )
    .run(challengeId);
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
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const now = options.now ?? Date.now();
  const recent = getDB()
    .prepare(
      `SELECT created_at_ms FROM sms_registration_challenges
     WHERE phone = ? AND created_at_ms > ?
     ORDER BY created_at_ms DESC`,
    )
    .all(normalized, now - 60 * 60 * 1000) as Array<{ created_at_ms: number }>;
  const latest = recent[0]?.created_at_ms;
  if (latest != null && now - latest < SMS_CHALLENGE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil(
        (latest + SMS_CHALLENGE_COOLDOWN_MS - now) / 1000,
      ),
    };
  }
  if (recent.length >= SMS_CHALLENGE_HOURLY_LIMIT) {
    const oldest = recent[recent.length - 1]!.created_at_ms;
    return {
      ok: false,
      reason: 'hourly_limit',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000),
      ),
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
  if (department && department.length > 80)
    throw new Error('部门名称不能超过 80 个字符');
  if (positionTitle && positionTitle.length > 80)
    throw new Error('职位名称不能超过 80 个字符');
  if (role && role.length > 80) throw new Error('角色不能超过 80 个字符');
  getDB()
    .prepare(
      `INSERT INTO sms_registration_challenges
       (id, organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
        organization_invite_id, department, department_id, position_id, position_title, role, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  logAudit(
    'sms_registration_code_requested',
    null,
    'SMS registration code requested',
    organizationId,
  );
  return {
    ok: true,
    challengeId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    retryAfterSeconds: SMS_CHALLENGE_COOLDOWN_MS / 1000,
  };
}

export function discardSmsRegistrationChallenge(challengeId: string): void {
  if (!challengeId) return;
  getDB()
    .prepare(
      'DELETE FROM sms_registration_challenges WHERE id = ? AND consumed_at_ms IS NULL',
    )
    .run(challengeId);
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
  const row = getDB()
    .prepare(
      `SELECT organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
            organization_invite_id, department, department_id, position_id, position_title, role, consumed_at_ms
     FROM sms_registration_challenges WHERE id = ?`,
    )
    .get(challengeId) as
    | {
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
      }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (now > row.expires_at_ms) {
    getDB()
      .prepare(
        'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return {
      ok: false,
      reason: 'expired',
      attemptsRemaining: row.attempts_remaining,
    };
  }
  if (!passwordMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    getDB()
      .prepare(
        `UPDATE sms_registration_challenges
       SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
       WHERE id = ?`,
      )
      .run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  getDB()
    .prepare(
      'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
    )
    .run(now, challengeId);
  logAudit(
    'sms_registration_verified',
    null,
    'SMS registration verified',
    row.organization_id,
  );
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
  const row = getDB()
    .prepare(
      `SELECT c.account_id, c.code_hash, c.expires_at_ms, c.attempts_remaining, c.consumed_at_ms,
            a.status AS account_status
     FROM sms_login_challenges c
     JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ?`,
    )
    .get(challengeId) as
    | {
        account_id: string;
        code_hash: string;
        expires_at_ms: number;
        attempts_remaining: number;
        consumed_at_ms: number | null;
        account_status: 'active' | 'disabled';
      }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (row.account_status !== 'active') {
    getDB()
      .prepare(
        'UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return { ok: false, reason: 'used', attemptsRemaining: 0 };
  }
  if (now > row.expires_at_ms) {
    getDB()
      .prepare(
        'UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return {
      ok: false,
      reason: 'expired',
      attemptsRemaining: row.attempts_remaining,
    };
  }
  if (!passwordMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    getDB()
      .prepare(
        `UPDATE sms_login_challenges
       SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
       WHERE id = ?`,
      )
      .run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  getDB()
    .prepare('UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?')
    .run(now, challengeId);
  const account = getAccount(row.account_id);
  if (!account) return { ok: false, reason: 'used', attemptsRemaining: 0 };
  logAudit('sms_login_verified', account.employeeId, 'SMS login verified');
  return { ok: true, account };
}

// ============================================================
// Park tenants, organization membership and service specialists
// ============================================================

export interface ParkView {
  id: string;
  name: string;
  slug: string;
  brandName: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface ParkRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  admin_organization_id: string;
  brand_name: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

const DEFAULT_PARK_SERVICES = [
  ['renovation', '装修管理'],
  ['parking', '停车办理'],
  ['network-phone', '网络与固话'],
  ['meeting-room', '会议室预约'],
  ['electric-card', '电卡服务'],
  ['repair', '物业报修'],
  ['vehicle-visit', '车辆与访客'],
  ['announcement', '园区公告'],
  ['satisfaction', '满意度调查'],
] as const;

export const PARK_SERVICE_IDS = new Set<string>(
  DEFAULT_PARK_SERVICES.map(([serviceId]) => serviceId),
);

export interface ParkServiceView {
  parkId: string;
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  updatedAt: string;
}

interface ParkServiceRow {
  park_id: string;
  id: string;
  name: string;
  enabled: number;
  config_json: string;
  updated_at: string;
}

function toParkServiceView(row: ParkServiceRow): ParkServiceView {
  let config: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
  } catch {
    config = {};
  }
  return {
    parkId: row.park_id,
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    config,
    updatedAt: row.updated_at,
  };
}

export function listParkServices(parkId: string): ParkServiceView[] {
  return (
    getDB()
      .prepare(
        'SELECT * FROM park_services WHERE park_id = ? ORDER BY name, id',
      )
      .all(parkId) as ParkServiceRow[]
  ).map(toParkServiceView);
}

export function updateParkService(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, string>;
}): ParkServiceView {
  const park = getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可配置服务');
  const current = getDB()
    .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
    .get(park.id, input.serviceId) as ParkServiceRow | undefined;
  if (!current) throw new Error('园区服务不存在');
  const name =
    input.name === undefined
      ? current.name
      : normalizeOptionalText(input.name, '园区服务名称');
  if (!name) throw new Error('园区服务名称不能为空');
  const config = input.config ?? toParkServiceView(current).config;
  const normalizedConfig = Object.fromEntries(
    Object.entries(config).filter(
      (entry): entry is [string, string] =>
        entry[0].length <= 64 &&
        typeof entry[1] === 'string' &&
        entry[1].length <= 500,
    ),
  );
  getDB()
    .prepare(
      `UPDATE park_services SET name = ?, enabled = ?, config_json = ?, updated_at = datetime('now')
     WHERE park_id = ? AND id = ?`,
    )
    .run(
      name,
      (input.enabled ?? current.enabled === 1) ? 1 : 0,
      JSON.stringify(normalizedConfig),
      park.id,
      input.serviceId,
    );
  return toParkServiceView(
    getDB()
      .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
      .get(park.id, input.serviceId) as ParkServiceRow,
  );
}

function toParkView(row: ParkRow): ParkView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brandName: row.brand_name,
    adminOrganizationId: row.admin_organization_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getPark(id: string): ParkView | null {
  const row = getDB().prepare('SELECT * FROM parks WHERE id = ?').get(id) as
    ParkRow | undefined;
  return row ? toParkView(row) : null;
}

export function getParkForOrganization(
  organizationId: string,
): ParkView | null {
  const row = getDB()
    .prepare(
      `SELECT p.* FROM organizations o
     JOIN parks p ON p.id = o.park_id
     WHERE o.id = ? AND p.status = 'active'`,
    )
    .get(organizationId) as ParkRow | undefined;
  return row ? toParkView(row) : null;
}

export function listParkTenantOrganizations(
  parkId: string,
): OrganizationView[] {
  const park = getPark(parkId);
  if (!park) throw new Error('Park not found');
  return (
    getDB()
      .prepare(
        `SELECT o.*, profile.address AS park_address, profile.room_number AS park_room_number
         FROM organizations o
         LEFT JOIN park_tenant_profiles profile ON profile.organization_id = o.id AND profile.park_id = o.park_id
         WHERE o.park_id = ? AND o.id <> ?
         ORDER BY o.name COLLATE NOCASE, o.slug`,
      )
      .all(park.id, park.adminOrganizationId) as OrganizationRow[]
  ).map(toOrganizationView);
}

export interface ParkTenantProfileView {
  organizationId: string;
  parkId: string;
  address: string;
  roomNumber: string;
  updatedAt: string;
}

interface ParkTenantProfileRow {
  organization_id: string;
  park_id: string;
  address: string;
  room_number: string;
  updated_at: string;
}

function toParkTenantProfileView(row: ParkTenantProfileRow): ParkTenantProfileView {
  return {
    organizationId: row.organization_id,
    parkId: row.park_id,
    address: row.address,
    roomNumber: row.room_number,
    updatedAt: row.updated_at,
  };
}

export function getParkTenantProfile(organizationId: string): ParkTenantProfileView | null {
  const row = getDB()
    .prepare('SELECT * FROM park_tenant_profiles WHERE organization_id = ?')
    .get(organizationId) as ParkTenantProfileRow | undefined;
  return row ? toParkTenantProfileView(row) : null;
}

export function updateParkTenantProfile(input: {
  organizationId: string;
  actorAccountId: string;
  address: string;
  roomNumber: string;
}): ParkTenantProfileView {
  const actor = getAccount(input.actorAccountId, input.organizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有企业管理员可修改企业入驻资料');
  const park = getParkForOrganization(input.organizationId);
  if (!park || park.adminOrganizationId === input.organizationId)
    throw new Error('当前企业不是产业园入驻企业');
  const address = normalizeOptionalText(input.address, '企业地址', 160);
  const roomNumber = normalizeOptionalText(input.roomNumber, '门牌号', 40);
  if (!address) throw new Error('企业地址不能为空');
  if (!roomNumber) throw new Error('门牌号不能为空');
  getDB().prepare(
    `INSERT INTO park_tenant_profiles (organization_id, park_id, address, room_number)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       park_id = excluded.park_id,
       address = excluded.address,
       room_number = excluded.room_number,
       updated_at = datetime('now')`,
  ).run(input.organizationId, park.id, address, roomNumber);
  return getParkTenantProfile(input.organizationId)!;
}

const parkStatisticsStore = {
  db: getDB,
  getAccount,
  getPark,
  getParkForOrganization,
  getOrganizationFeatures,
  listAccounts,
  listParkTenantOrganizations,
  audit: (event: string, employeeId: string | null, detail: string, organizationId: string) =>
    logAudit(event, employeeId, detail, organizationId),
};

export function createParkDataStatisticsTask(input: {
  createdByAccountId: string;
  title: string;
  description: string;
  deadline: string;
  fields?: string[];
  templateName?: string | null;
  templateData?: string | null;
  organizationIds?: string[];
}): { task: ParkDataStatisticsTaskView; recipientCount: number } {
  return createParkDataStatisticsTaskInRepository(parkStatisticsStore, input);
}

export function listParkDataStatisticsTasks(accountId: string): ParkDataStatisticsTaskView[] {
  return listParkDataStatisticsTasksFromRepository(parkStatisticsStore, accountId);
}

export function markParkDataStatisticsRead(taskId: string, accountId: string): ParkDataStatisticsAssignmentView {
  return markParkDataStatisticsReadInRepository(parkStatisticsStore, taskId, accountId);
}

export function getParkDataStatisticsTemplate(taskId: string, accountId: string): {
  name: string;
  data: string;
} {
  return getParkDataStatisticsTemplateFromRepository(parkStatisticsStore, taskId, accountId);
}

export function delegateParkDataStatistics(taskId: string, accountId: string, assigneeAccountId: string): ParkDataStatisticsAssignmentView {
  return delegateParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    assigneeAccountId,
  );
}

export function submitParkDataStatisticsDraft(taskId: string, accountId: string, responseData: Record<string, string>): ParkDataStatisticsAssignmentView {
  return submitParkDataStatisticsDraftInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    responseData,
  );
}

export function reviewParkDataStatistics(taskId: string, accountId: string, approved: boolean, reason?: string): ParkDataStatisticsAssignmentView {
  return reviewParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    approved,
    reason,
  );
}

export function remindParkDataStatistics(taskId: string, adminAccountId: string): ParkDataStatisticsTaskView {
  return remindParkDataStatisticsInRepository(parkStatisticsStore, taskId, adminAccountId);
}

export function returnParkDataStatistics(taskId: string, adminAccountId: string, organizationId: string, reason: string): ParkDataStatisticsAssignmentView {
  return returnParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    adminAccountId,
    organizationId,
    reason,
  );
}
export function createParkAsPlatform(input: {
  adminOrganizationId: string;
  name?: string;
  slug?: string;
  brandName?: string;
}): ParkView {
  const organization = getEnterpriseOrganization(input.adminOrganizationId);
  if (!organization) throw new Error('Organization not found');
  const admin = listAccounts(input.adminOrganizationId).find(
    (account) => account.isAdmin && account.status === 'active',
  );
  if (!admin)
    throw new Error('Park admin organization requires an active admin account');
  return createPark({
    adminOrganizationId: input.adminOrganizationId,
    actorAccountId: admin.id,
    name: input.name || organization.name,
    slug: input.slug,
    brandName: input.brandName,
  });
}

export function updateParkAsPlatform(input: {
  adminOrganizationId: string;
  name?: string;
  brandName?: string;
}): ParkView {
  const current = getDB()
    .prepare(
      `SELECT * FROM parks
       WHERE admin_organization_id = ? AND status = 'active'`,
    )
    .get(input.adminOrganizationId) as ParkRow | undefined;
  if (!current) throw new Error('Park admin organization not found');

  const name =
    input.name === undefined
      ? current.name
      : normalizeOptionalText(input.name, '产业园名称');
  if (!name) throw new Error('产业园名称不能为空');
  const brandName =
    input.brandName === undefined
      ? current.brand_name
      : normalizeOptionalText(input.brandName, '园区服务名称');
  if (!brandName) throw new Error('园区服务名称不能为空');

  getDB()
    .prepare(
      `UPDATE parks
       SET name = ?, brand_name = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(name, brandName, current.id);
  return getPark(current.id)!;
}

export function createPark(input: {
  adminOrganizationId: string;
  actorAccountId: string;
  name: string;
  slug?: string;
  brandName?: string;
}): ParkView {
  const actor = getAccount(input.actorAccountId, input.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有企业管理员可注册产业园');
  if (getParkForOrganization(input.adminOrganizationId))
    throw new Error('企业已加入产业园');
  const name = normalizeOptionalText(input.name, '产业园名称');
  if (!name) throw new Error('产业园名称不能为空');
  const brandName =
    normalizeOptionalText(input.brandName, '园区服务名称') ?? `${name}服务`;
  const slug = normalizeOrganizationSlug(
    input.slug || `park-${randomBytes(5).toString('hex')}`,
  );
  const id = `park_${randomUUID()}`;
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO parks
        (id, name, slug, invite_secret, admin_organization_id, brand_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        slug,
        randomBytes(32).toString('hex'),
        input.adminOrganizationId,
        brandName,
      );
    database
      .prepare(
        `UPDATE organizations SET park_id = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(id, input.adminOrganizationId);
    const insertService = database.prepare(
      `INSERT INTO park_services (park_id, id, name, enabled, config_json)
       VALUES (?, ?, ?, 1, '{}')`,
    );
    for (const [serviceId, serviceName] of DEFAULT_PARK_SERVICES) {
      insertService.run(id, serviceId, serviceName);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getPark(id)!;
}

interface ParkInviteRow {
  id: string;
  park_id: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  max_uses: number | null;
  used_count: number;
}

export interface ParkInviteView {
  id: string;
  parkId: string;
  code: string;
  status: 'active' | 'expired' | 'revoked';
  usedCount: number;
  maxUses: number | null;
  issuedAt: string;
  expiresAt: string;
}

function deriveParkInviteCode(park: ParkRow, nonce: string): string {
  const digest = createHmac('sha256', park.invite_secret)
    .update(`${park.id}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < INVITE_CODE_RAW_LENGTH; index += 1) {
    code +=
      ORGANIZATION_INVITE_ALPHABET[
        digest[index]! % ORGANIZATION_INVITE_ALPHABET.length
      ];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function toParkInviteView(
  row: ParkInviteRow,
  park: ParkRow,
  now: number,
): ParkInviteView {
  return {
    id: row.id,
    parkId: row.park_id,
    code: deriveParkInviteCode(park, row.nonce),
    status:
      row.revoked_at_ms != null
        ? 'revoked'
        : now >= row.expires_at_ms ||
            (row.max_uses != null && row.used_count >= row.max_uses)
          ? 'expired'
          : 'active',
    usedCount: row.used_count,
    maxUses: row.max_uses,
    issuedAt: new Date(row.issued_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
  };
}

export function issueParkInvite(input: {
  parkId: string;
  actorAccountId: string;
  maxUses?: number | null;
  now?: number;
}): ParkInviteView {
  const parkRow = getDB()
    .prepare('SELECT * FROM parks WHERE id = ?')
    .get(input.parkId) as ParkRow | undefined;
  if (!parkRow || parkRow.status !== 'active')
    throw new Error('产业园不存在或已停用');
  const actor = getAccount(input.actorAccountId, parkRow.admin_organization_id);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理企业管理员可生成邀请码');
  const maxUses = input.maxUses == null ? null : Math.floor(input.maxUses);
  if (maxUses != null && (maxUses < 1 || maxUses > 10_000))
    throw new Error('邀请码使用次数必须为 1 到 10000');
  const now = input.now ?? Date.now();
  const row: ParkInviteRow = {
    id: `park_invite_${randomUUID()}`,
    park_id: parkRow.id,
    nonce: randomBytes(20).toString('hex'),
    issued_at_ms: now,
    expires_at_ms: now + ORGANIZATION_INVITE_VALIDITY_MS,
    revoked_at_ms: null,
    max_uses: maxUses,
    used_count: 0,
  };
  getDB()
    .prepare(
      `INSERT INTO park_invites
      (id, park_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.park_id,
      row.nonce,
      row.issued_at_ms,
      row.expires_at_ms,
      actor.id,
      row.max_uses,
    );
  return toParkInviteView(row, parkRow, now);
}

export function joinOrganizationToPark(input: {
  organizationId: string;
  actorAccountId: string;
  code: string;
  address: string;
  roomNumber: string;
  now?: number;
}): ParkView {
  const actor = getAccount(input.actorAccountId, input.organizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有企业管理员可让企业加入产业园');
  if (getParkForOrganization(input.organizationId))
    throw new Error('企业已加入产业园');
  const address = normalizeOptionalText(input.address, '企业地址', 160);
  const roomNumber = normalizeOptionalText(input.roomNumber, '门牌号', 40);
  if (!address) throw new Error('企业地址不能为空');
  if (!roomNumber) throw new Error('门牌号不能为空');
  const normalized = normalizeOrganizationInviteCode(input.code);
  if (normalized.length !== INVITE_CODE_RAW_LENGTH) throw new Error('产业园邀请码无效或已过期');
  const now = input.now ?? Date.now();
  const rows = getDB()
    .prepare(
      `SELECT i.*, p.name, p.slug, p.invite_secret, p.admin_organization_id,
            p.brand_name, p.status, p.created_at, p.updated_at
     FROM park_invites i JOIN parks p ON p.id = i.park_id
     WHERE i.revoked_at_ms IS NULL AND i.expires_at_ms > ? AND p.status = 'active'
       AND (i.max_uses IS NULL OR i.used_count < i.max_uses)`,
    )
    .all(now) as Array<ParkInviteRow & Omit<ParkRow, 'id'>>;
  const matches = rows.filter((row) => {
    const expected = normalizeOrganizationInviteCode(
      deriveParkInviteCode(
        {
          id: row.park_id,
          name: row.name,
          slug: row.slug,
          invite_secret: row.invite_secret,
          admin_organization_id: row.admin_organization_id,
          brand_name: row.brand_name,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        row.nonce,
      ),
    );
    return (
      expected.length === normalized.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    );
  });
  if (matches.length !== 1) throw new Error('产业园邀请码无效或已过期');
  const invite = matches[0]!;
  const database = getDB();
  database.exec('BEGIN IMMEDIATE');
  try {
    const reserved = database
      .prepare(
        `UPDATE park_invites SET used_count = used_count + 1
       WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
         AND (max_uses IS NULL OR used_count < max_uses)`,
      )
      .run(invite.id, now);
    if (Number(reserved.changes) !== 1)
      throw new Error('产业园邀请码无效或已过期');
    const joined = database
      .prepare(
        `UPDATE organizations SET park_id = ?, updated_at = datetime('now')
       WHERE id = ? AND park_id IS NULL`,
      )
      .run(invite.park_id, input.organizationId);
    if (Number(joined.changes) !== 1) throw new Error('企业已加入产业园');
    database.prepare(
      `INSERT INTO park_tenant_profiles (organization_id, park_id, address, room_number)
       VALUES (?, ?, ?, ?)`,
    ).run(input.organizationId, invite.park_id, address, roomNumber);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getPark(invite.park_id)!;
}

export interface ParkServiceSpecialistView {
  parkId: string;
  serviceId: string;
  accountId: string;
  name: string;
}

export function listParkServiceSpecialists(
  parkId: string,
): ParkServiceSpecialistView[] {
  return (
    getDB()
      .prepare(
        `SELECT s.park_id, s.service_id, a.id AS account_id, a.name
     FROM park_service_specialists s JOIN accounts a ON a.id = s.account_id
     WHERE s.park_id = ? AND a.status = 'active' AND a.deleted_at IS NULL
     ORDER BY s.service_id, a.name, a.id`,
      )
      .all(parkId) as Array<{
      park_id: string;
      service_id: string;
      account_id: string;
      name: string;
    }>
  ).map((row) => ({
    parkId: row.park_id,
    serviceId: row.service_id,
    accountId: row.account_id,
    name: row.name,
  }));
}

export function setParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): ParkServiceSpecialistView {
  const park = getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可设置服务专员');
  const specialist = getAccount(input.accountId, park.adminOrganizationId);
  if (!specialist || specialist.status !== 'active')
    throw new Error('专员必须属于产业园管理企业');
  const serviceId = input.serviceId.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(serviceId))
    throw new Error('服务标识格式不正确');
  const service = getDB()
    .prepare('SELECT enabled FROM park_services WHERE park_id = ? AND id = ?')
    .get(park.id, serviceId) as { enabled: number } | undefined;
  if (!service) throw new Error('园区服务不存在');
  if (service.enabled !== 1) throw new Error('园区服务已停用');
  getDB()
    .prepare(
      `INSERT OR IGNORE INTO park_service_specialists (park_id, service_id, account_id)
     VALUES (?, ?, ?)`,
    )
    .run(park.id, serviceId, specialist.id);
  return listParkServiceSpecialists(park.id).find(
    (item) => item.serviceId === serviceId && item.accountId === specialist.id,
  )!;
}

export function removeParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): void {
  const park = getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可设置服务专员');
  getDB()
    .prepare(
      `DELETE FROM park_service_specialists
     WHERE park_id = ? AND service_id = ? AND account_id = ?`,
    )
    .run(park.id, input.serviceId, input.accountId);
}

export {
  PARK_MEETING_TIME_SLOTS,
  createParkMeetingRoom,
  deleteParkMeetingRoom,
  getParkSettings,
  listParkMeetingRooms,
  listParkMeetingSlots,
  reserveParkMeetingSlot,
  setParkMeetingSlotAvailability,
  updateParkMeetingRoom,
  updateParkSettings,
} from './parkMeetingRepository.js';
export type {
  ParkMeetingRoomView,
  ParkMeetingSlotView,
  ParkSettingsView,
} from './parkMeetingRepository.js';

export {
  createParkPublication,
  listParkPublications,
  listParkSurveyResults,
  markParkPublicationRead,
  submitParkSurvey,
} from './parkPublicationRepository.js';
export type {
  ParkPublicationView,
  ParkSurveyResultView,
} from './parkPublicationRepository.js';

// ============================================================
// Provider-reported Token usage (client_reported, idempotent)
// ============================================================

export {
  getOrganizationUsageSummary,
  recordTokenUsage,
} from './tokenUsageRepository.js';
export type {
  AccountTokenUsageView,
  OrganizationUsageSummary,
} from './tokenUsageRepository.js';

// ============================================================
// Employee operations
// ============================================================
export {
  createEmployee,
  getEmployee,
  listEmployees,
  offboardEmployee,
} from './employeeRepository.js';

// ============================================================
// Task logging and reports
// ============================================================
export {
  getReport,
  getTaskHistory,
  logTask,
} from './taskReportRepository.js';

// ============================================================
// Knowledge operations
// ============================================================
export {
  addKnowledge,
  getKnowledge,
  getMemberKnowledge,
  searchKnowledge,
} from './knowledgeRepository.js';

// ============================================================
// Invite codes
// ============================================================
export {
  createInviteCode,
  validateInviteCode,
} from './inviteCodeRepository.js';

// ============================================================
// Audit
// ============================================================
export {
  getAuditLogs,
  logAudit,
} from './auditRepository.js';

// ============================================================
// Export all (for backup)
// ============================================================
export function exportAll(organizationId = DEFAULT_ORGANIZATION_ID): any {
  return {
    // Full backup must include offboarded employees too, otherwise every
    // offboarding silently erases historical employee records from the
    // export — contradicting the "export ALL data" guarantee.
    employees: getDB()
      .prepare(
        'SELECT * FROM employees WHERE organization_id = ? ORDER BY onboarded_at',
      )
      .all(organizationId),
    taskLogs: getDB()
      .prepare(
        `SELECT * FROM task_logs WHERE organization_id = ?
       ORDER BY created_at DESC LIMIT 1000`,
      )
      .all(organizationId),
    knowledge: getKnowledgeFromRepository(undefined, undefined, organizationId),
    inviteCodes: getDB()
      .prepare('SELECT * FROM invite_codes WHERE organization_id = ?')
      .all(organizationId),
    auditLogs: getAuditLogs(200, organizationId),
    // 账号导出不包含 password_hash / session token 摘要；备份可迁移组织信息，
    // 但不能把登录凭证扩散到普通数据导出文件。
    accounts: listAccounts(organizationId),
    accountTags: getDB()
      .prepare(
        `SELECT account_id, tag, created_at FROM account_tags
       WHERE organization_id = ?`,
      )
      .all(organizationId),
    tickets: getDB()
      .prepare(
        `SELECT * FROM it_tickets WHERE organization_id = ? ORDER BY created_at DESC`,
      )
      .all(organizationId),
    ticketDeliveries: getDB()
      .prepare(
        `SELECT * FROM ticket_deliveries WHERE organization_id = ? ORDER BY delivered_at DESC`,
      )
      .all(organizationId),
  };
}
