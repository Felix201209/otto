/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise SQLite database - all data stored on admin/owner device.
 * Zero cloud dependency. All data is local.
 * 存储层通过 data_platform 使用 Node 内置 node:sqlite，无原生依赖。
 */

import { Database } from '../modules/data_platform/index.js';
import { createOrganizationFeatureAccessFacade } from '../modules/authorization/index.js';
import {
  createAccountPresenceFacade,
  createDirectMessageFacade,
  type AccountPresenceView as CollaborationAccountPresenceView,
} from '../modules/collaboration/index.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  exportDeploymentDiagnostics as exportDeploymentDiagnosticsFromRepository,
  getDeploymentId as getDeploymentIdFromRepository,
  getDeploymentLicense as getDeploymentLicenseFromRepository,
  getMachineFingerprint as getMachineFingerprintFromRepository,
  getModuleUpdateManifestFromStore,
  getPrivateDeploymentStatus as getPrivateDeploymentStatusFromRepository,
  getTelemetryQueueSummary as getTelemetryQueueSummaryFromRepository,
  getTelemetrySettings as getTelemetrySettingsFromRepository,
  importDeploymentLicense as importDeploymentLicenseIntoRepository,
  isLicenseRestricted as isLicenseRestrictedInRepository,
  isLicenseUsableForOrganizationFeature as isLicenseUsableForOrganizationFeatureInRepository,
  recordTelemetryEvent as recordTelemetryEventInRepository,
  updateModuleUpdateDescriptorInStore,
  updateTelemetrySettings as updateTelemetrySettingsInRepository,
  type ModuleUpdateDescriptor,
  type ModuleUpdateManifest,
  type ModuleUpdateRollout,
  type DeploymentLicenseView,
  type DeploymentTelemetrySettings,
  type PrivateDeploymentStatus,
} from '../modules/commercial_control/index.js';
import { buildCreditsTablesSql } from './creditsSchema.js';
import { getAuditLogs, logAudit } from './auditRepository.js';
import { getKnowledge as getKnowledgeFromRepository } from './knowledgeRepository.js';
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
import {
  getParkTenantProfile as getParkTenantProfileFromRepository,
  issueParkInvite as issueParkInviteFromRepository,
  joinOrganizationToPark as joinOrganizationToParkInRepository,
  updateParkTenantProfile as updateParkTenantProfileInRepository,
} from './parkInviteRepository.js';
import {
  listParkServices as listParkServicesFromRepository,
  listParkServiceSpecialists as listParkServiceSpecialistsFromRepository,
  removeParkServiceSpecialist as removeParkServiceSpecialistFromRepository,
  setParkServiceSpecialist as setParkServiceSpecialistInRepository,
  updateParkService as updateParkServiceInRepository,
} from './parkServiceRepository.js';
import {
  createAccountDirectoryFacade,
  createAccountLifecycleFacade,
  createAccountRegistrationFacade,
  createAuthSessionFacade,
  createMemberDirectoryFacade,
  createSmsChallengeFacade,
  createOrganizationDirectoryFacade,
  createOrganizationFeatureFacade,
  createOrganizationInviteFacade,
  createOrganizationProvisioningFacade,
  createOrganizationStructureFacade,
  normalizeAssignmentName,
  normalizeOrganizationSlug,
  replaceAccountTagsInRepository,
  stableAssignmentId,
  toOrganizationDirectoryView,
  assertAccountPassword as assertIdentityAccountPassword,
  hashIdentitySecret,
  identitySecretMatches,
  isAcceptableAccountPassword as isAcceptableIdentityAccountPassword,
  type OrganizationDepartmentView as IdentityOrganizationDepartmentView,
  type OrganizationDirectoryRow,
  type OrganizationDirectoryView,
  type OrganizationInviteView,
  type OrganizationFeatures as IdentityOrganizationFeatures,
  type OrganizationPositionRoleMapping as IdentityOrganizationPositionRoleMapping,
  type OrganizationPositionView as IdentityOrganizationPositionView,
  type SmsChallengeIssueResult as IdentitySmsChallengeIssueResult,
  type SmsChallengeVerifyResult as IdentitySmsChallengeVerifyResult,
  type SmsRegistrationVerifyResult as IdentitySmsRegistrationVerifyResult,
} from '../modules/identity_organization/index.js';
import type {
  ParkInviteView,
  ParkTenantProfileView,
} from './parkInviteTypes.js';
import type {
  ParkServiceSpecialistView,
  ParkServiceView,
} from './parkServiceTypes.js';
import type {
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
} from './parkStatisticsTypes.js';
export type {
  ModuleUpdateDescriptor,
  ModuleUpdateManifest,
  ModuleUpdateRollout,
  DeploymentLicenseStatus,
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
} from '../modules/commercial_control/index.js';
export type {
  OrganizationInviteInspection,
  OrganizationInviteIssueInput,
  OrganizationInviteResolution,
  OrganizationInviteStatus,
  OrganizationInviteView,
} from '../modules/identity_organization/index.js';
export type {
  AtoaInboxMessageView,
  DirectMessageAttachmentDownload,
  DirectMessageAttachmentInput,
  DirectMessageAttachmentView,
  DirectMessageView,
  UnreadDirectMessageNotification,
} from '../modules/collaboration/index.js';
export type {
  ParkDataStatisticsAssignmentStatus,
  ParkDataStatisticsAssignmentView,
  ParkDataStatisticsTaskView,
} from './parkStatisticsTypes.js';
export type {
  ParkInviteView,
  ParkTenantProfileView,
} from './parkInviteTypes.js';
export type {
  ParkServiceSpecialistView,
  ParkServiceView,
} from './parkServiceTypes.js';
export { getParkServiceStatistics } from './parkUsageStatisticsRepository.js';
export type {
  ParkServiceStatisticsView,
  ParkServiceUsageCount,
  ParkTenantServiceStatistics,
} from './parkUsageStatisticsRepository.js';
export {
  createTicket,
  getTicketCreatorForAccount,
  getTicketForAccount,
  getTicketNotificationRecipients,
  getTicketTransferredNotificationRecipients,
  isTicketFeatureEnabledForAccount,
  listTicketInbox,
  listTicketsForAccount,
  markTicketRead,
  normalizeParkServiceFormData,
  recordTicketNotification,
  updateTicket,
} from './ticketRepository.js';
export type {
  TicketHistoryAction,
  TicketHistoryEntry,
  TicketView,
} from './ticketRepository.js';

const DATA_DIR =
  process.env.OTTO_ENTERPRISE_DIR ||
  path.join(os.homedir(), '.otto-enterprise');
const DB_PATH = path.join(DATA_DIR, 'data.db');
const ACCOUNT_SYNC_KEY_PATH = path.join(DATA_DIR, 'account-sync.key');

export const DEFAULT_ORGANIZATION_ID = 'org_default';
export const ENTERPRISE_SCHEMA_VERSION = 11;
export const ORGANIZATION_INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const ORGANIZATION_INVITE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INVITE_CODE_RAW_LENGTH = 12;

function tokensMatch(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}
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
let accountSyncEncryptionKey: Buffer | null = null;

/** 释放当前企业数据库连接；服务关闭或隔离测试清理时调用。 */
export function closeEnterpriseDatabase(): void {
  if (!db) return;
  const database = db;
  db = null;
  accountSyncEncryptionKey = null;
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
    migrateLegacyTicketEvents(database);
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

/** v11 adds the auditable property-repair transfer action without losing existing history. */
function migrateLegacyTicketEvents(d: Database): void {
  const table = d
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_events'")
    .get() as { sql?: string } | undefined;
  if (!table?.sql || table.sql.includes("'transfer'")) return;

  const columns = new Set((d.prepare('PRAGMA table_info(ticket_events)').all() as Array<{ name: string }>)
    .map((column) => column.name));
  const requiredColumns = [
    'id', 'organization_id', 'ticket_id', 'actor_account_id', 'action', 'status_before',
    'status_after', 'response_type', 'response_text', 'created_at',
  ];
  if (!requiredColumns.every((column) => columns.has(column))) return;

  d.exec('PRAGMA foreign_keys = OFF');
  d.exec('BEGIN IMMEDIATE');
  try {
    d.exec(`
      ALTER TABLE ticket_events RENAME TO ticket_events_legacy_v10;
      CREATE TABLE ticket_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        actor_account_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('created', 'accept', 'respond', 'complete', 'confirm', 'transfer')),
        status_before TEXT,
        status_after TEXT NOT NULL,
        response_type TEXT,
        response_text TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
        FOREIGN KEY (actor_account_id) REFERENCES accounts(id)
      );
      INSERT INTO ticket_events
        (id, organization_id, ticket_id, actor_account_id, action, status_before,
         status_after, response_type, response_text, created_at)
      SELECT id, organization_id, ticket_id, actor_account_id, action, status_before,
             status_after, response_type, response_text, created_at
      FROM ticket_events_legacy_v10;
      DROP TABLE ticket_events_legacy_v10;
      COMMIT;
    `);
  } catch (error) {
    try { d.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
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
    CREATE TABLE IF NOT EXISTS account_sync_snapshots (
      account_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('personal_memory', 'worklog', 'auto_skills')),
      version INTEGER NOT NULL,
      payload_ciphertext TEXT NOT NULL,
      payload_iv TEXT NOT NULL,
      payload_auth_tag TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      device_id TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_id, scope),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS direct_message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
      content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_direct_message_attachments_message
      ON direct_message_attachments(message_id, ordinal);

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

    CREATE TABLE IF NOT EXISTS ticket_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      actor_account_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('created', 'accept', 'respond', 'complete', 'confirm', 'transfer')),
      status_before TEXT,
      status_after TEXT NOT NULL,
      response_type TEXT,
      response_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_account_id) REFERENCES accounts(id)
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

    CREATE TABLE IF NOT EXISTS park_meeting_bookings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      booked_ticket_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (meeting_room_id) REFERENCES park_meeting_rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (booked_ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS park_meeting_slot_overrides (
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, meeting_room_id, use_date, slot_key),
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
    ${buildCreditsTablesSql(DEFAULT_ORGANIZATION_ID).join(';\n')};
    CREATE INDEX IF NOT EXISTS idx_ticket_deliveries_account ON ticket_deliveries(account_id, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_notifications_ticket
      ON ticket_notifications(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
      ON ticket_events(ticket_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_it_tickets_park_org_service_created
      ON it_tickets(park_id, organization_id, service_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_park_meeting_slots_booked_ticket
      ON park_meeting_slots(booked_ticket_id) WHERE booked_ticket_id IS NOT NULL;
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
    CREATE INDEX IF NOT EXISTS idx_park_meeting_bookings_org_date
      ON park_meeting_bookings(organization_id, use_date, meeting_room_id, start_time, end_time);
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
    CREATE INDEX IF NOT EXISTS idx_account_sync_snapshots_org_updated
      ON account_sync_snapshots(organization_id, updated_at_ms);
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

export const ACCOUNT_SYNC_SCOPES = [
  'personal_memory',
  'worklog',
  'auto_skills',
] as const;

export type AccountSyncScope = (typeof ACCOUNT_SYNC_SCOPES)[number];

export interface AccountSyncFile {
  path: string;
  content: string;
  modifiedAtMs: number;
  sha256: string;
}

export interface AccountSyncPayload {
  schemaVersion: 1;
  generatedAt: string;
  files: AccountSyncFile[];
  truncated?: boolean;
}

export interface AccountSyncSnapshotView {
  scope: AccountSyncScope;
  version: number;
  payload: AccountSyncPayload;
  payloadHash: string;
  deviceId: string | null;
  updatedAtMs: number;
}

export class AccountSyncConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('account sync snapshot changed on another device');
    this.name = 'AccountSyncConflictError';
  }
}

const ACCOUNT_SYNC_MAX_FILES = 1_000;
const ACCOUNT_SYNC_MAX_FILE_BYTES = 1024 * 1024;
const ACCOUNT_SYNC_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const ACCOUNT_SYNC_SCOPE_SET = new Set<string>(ACCOUNT_SYNC_SCOPES);

interface AccountSyncSnapshotRow {
  account_id: string;
  organization_id: string;
  scope: AccountSyncScope;
  version: number;
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
  payload_hash: string;
  device_id: string | null;
  updated_at_ms: number;
}

function normalizeAccountSyncPath(
  scope: AccountSyncScope,
  value: string,
): string {
  if (scope !== 'personal_memory') return value;
  if (value === 'global.md') return 'memory/global.md';
  if (value.startsWith('sessions/')) return `memory/${value}`;
  return value;
}

function isAccountSyncPathAllowed(scope: AccountSyncScope, value: string): boolean {
  if (
    !value ||
    value.length > 260 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false;
  }
  if (scope === 'personal_memory') {
    return value === 'memory/global.md'
      || /^memory\/sessions\/[^/]{1,160}\.md$/u.test(value)
      || value === 'knowledge/entries.jsonl';
  }
  if (scope === 'worklog') {
    return /\.(?:jsonl|json|md)$/iu.test(value);
  }
  return /^auto-[^/]{1,160}\/(?:SKILL\.md|profile\.json)$/u.test(value);
}

function normalizeAccountSyncPayload(
  scope: AccountSyncScope,
  value: unknown,
): AccountSyncPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('account sync payload must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.files)) {
    throw new Error('account sync payload schema is unsupported');
  }
  if (raw.files.length > ACCOUNT_SYNC_MAX_FILES) {
    throw new Error('account sync payload contains too many files');
  }
  const generatedAtMs = Date.parse(String(raw.generatedAt ?? ''));
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error('account sync generatedAt is invalid');
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const files = raw.files.map((candidate): AccountSyncFile => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('account sync file entry is invalid');
    }
    const file = candidate as Record<string, unknown>;
    const relativePath = normalizeAccountSyncPath(scope, typeof file.path === 'string' ? file.path : '');
    const content = typeof file.content === 'string' ? file.content : '';
    if (!isAccountSyncPathAllowed(scope, relativePath)) {
      throw new Error('account sync file path is not allowed');
    }
    if (seen.has(relativePath)) {
      throw new Error('account sync payload contains a duplicate path');
    }
    seen.add(relativePath);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > ACCOUNT_SYNC_MAX_FILE_BYTES) {
      throw new Error('account sync file exceeds the size limit');
    }
    totalBytes += contentBytes + Buffer.byteLength(relativePath, 'utf8');
    if (totalBytes > ACCOUNT_SYNC_MAX_PAYLOAD_BYTES) {
      throw new Error('account sync payload exceeds the size limit');
    }
    const modifiedAtMs = Number(file.modifiedAtMs);
    if (!Number.isFinite(modifiedAtMs) || modifiedAtMs < 0) {
      throw new Error('account sync file timestamp is invalid');
    }
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    if (typeof file.sha256 !== 'string' || !tokensMatch(digest, file.sha256.toLowerCase())) {
      throw new Error('account sync file checksum mismatch');
    }
    return {
      path: relativePath,
      content,
      modifiedAtMs: Math.floor(modifiedAtMs),
      sha256: digest,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    files,
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}

function getAccountSyncEncryptionKey(): Buffer {
  if (accountSyncEncryptionKey) return accountSyncEncryptionKey;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let key: Buffer;
  try {
    key = fs.readFileSync(ACCOUNT_SYNC_KEY_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const generated = randomBytes(32);
    try {
      fs.writeFileSync(ACCOUNT_SYNC_KEY_PATH, generated, {
        flag: 'wx',
        mode: 0o600,
      });
      key = generated;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      key = fs.readFileSync(ACCOUNT_SYNC_KEY_PATH);
    }
  }
  if (key.length !== 32) {
    throw new Error('account sync encryption key is invalid');
  }
  try {
    fs.chmodSync(ACCOUNT_SYNC_KEY_PATH, 0o600);
  } catch {
    // Windows may not support POSIX modes; ACLs still protect the data directory.
  }
  accountSyncEncryptionKey = key;
  return key;
}

function accountSyncAad(row: Pick<
  AccountSyncSnapshotRow,
  'account_id' | 'organization_id' | 'scope' | 'version'
>): Buffer {
  return Buffer.from(
    [row.account_id, row.organization_id, row.scope, String(row.version)].join('\0'),
    'utf8',
  );
}

function encryptAccountSyncPayload(input: {
  accountId: string;
  organizationId: string;
  scope: AccountSyncScope;
  version: number;
  payload: AccountSyncPayload;
}): {
  ciphertext: string;
  iv: string;
  authTag: string;
  payloadHash: string;
} {
  const raw = JSON.stringify(input.payload);
  const payloadHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getAccountSyncEncryptionKey(), iv);
  cipher.setAAD(accountSyncAad({
    account_id: input.accountId,
    organization_id: input.organizationId,
    scope: input.scope,
    version: input.version,
  }));
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(raw, 'utf8'))),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    payloadHash,
  };
}

function decryptAccountSyncPayload(row: AccountSyncSnapshotRow): AccountSyncPayload {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    getAccountSyncEncryptionKey(),
    Buffer.from(row.payload_iv, 'base64'),
  );
  decipher.setAAD(accountSyncAad(row));
  decipher.setAuthTag(Buffer.from(row.payload_auth_tag, 'base64'));
  const compressed = Buffer.concat([
    decipher.update(Buffer.from(row.payload_ciphertext, 'base64')),
    decipher.final(),
  ]);
  const raw = gunzipSync(compressed).toString('utf8');
  const payloadHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (!tokensMatch(payloadHash, row.payload_hash)) {
    throw new Error('account sync snapshot integrity check failed');
  }
  return normalizeAccountSyncPayload(row.scope, JSON.parse(raw) as unknown);
}

function accountSyncSnapshotView(row: AccountSyncSnapshotRow): AccountSyncSnapshotView {
  return {
    scope: row.scope,
    version: row.version,
    payload: decryptAccountSyncPayload(row),
    payloadHash: row.payload_hash,
    deviceId: row.device_id,
    updatedAtMs: row.updated_at_ms,
  };
}

function activeAccountOrganization(accountId: string): string {
  const account = getDB()
    .prepare("SELECT organization_id FROM accounts WHERE id = ? AND status = 'active' AND deleted_at IS NULL")
    .get(accountId) as { organization_id: string } | undefined;
  if (!account) throw new Error('account not found');
  return account.organization_id;
}

export function listAccountSyncSnapshots(accountId: string): AccountSyncSnapshotView[] {
  activeAccountOrganization(accountId);
  const rows = getDB()
    .prepare('SELECT * FROM account_sync_snapshots WHERE account_id = ? ORDER BY scope')
    .all(accountId) as AccountSyncSnapshotRow[];
  return rows.map(accountSyncSnapshotView);
}

export function putAccountSyncSnapshot(input: {
  accountId: string;
  scope: AccountSyncScope;
  expectedVersion: number;
  payload: unknown;
  deviceId?: string | null;
}): AccountSyncSnapshotView {
  if (!ACCOUNT_SYNC_SCOPE_SET.has(input.scope)) {
    throw new Error('account sync scope is invalid');
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new Error('account sync expectedVersion is invalid');
  }
  const organizationId = activeAccountOrganization(input.accountId);
  const payload = normalizeAccountSyncPayload(input.scope, input.payload);
  const existing = getDB()
    .prepare('SELECT version FROM account_sync_snapshots WHERE account_id = ? AND scope = ?')
    .get(input.accountId, input.scope) as { version: number } | undefined;
  const currentVersion = existing?.version ?? 0;
  if (currentVersion !== input.expectedVersion) {
    throw new AccountSyncConflictError(currentVersion);
  }

  const version = currentVersion + 1;
  const encrypted = encryptAccountSyncPayload({
    accountId: input.accountId,
    organizationId,
    scope: input.scope,
    version,
    payload,
  });
  const updatedAtMs = Date.now();
  const deviceId = typeof input.deviceId === 'string'
    ? input.deviceId.trim().slice(0, 160) || null
    : null;

  if (existing) {
    const result = getDB()
      .prepare(
        'UPDATE account_sync_snapshots SET organization_id = ?, version = ?, '
        + 'payload_ciphertext = ?, payload_iv = ?, payload_auth_tag = ?, payload_hash = ?, '
        + 'device_id = ?, updated_at_ms = ? '
        + 'WHERE account_id = ? AND scope = ? AND version = ?',
      )
      .run(
        organizationId,
        version,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.payloadHash,
        deviceId,
        updatedAtMs,
        input.accountId,
        input.scope,
        currentVersion,
      ) as { changes?: number | bigint };
    if (Number(result.changes ?? 0) !== 1) {
      const latest = getDB()
        .prepare('SELECT version FROM account_sync_snapshots WHERE account_id = ? AND scope = ?')
        .get(input.accountId, input.scope) as { version?: number } | undefined;
      throw new AccountSyncConflictError(Number(latest?.version ?? currentVersion));
    }
  } else {
    try {
      getDB()
        .prepare(
          'INSERT INTO account_sync_snapshots '
          + '(account_id, organization_id, scope, version, payload_ciphertext, '
          + 'payload_iv, payload_auth_tag, payload_hash, device_id, updated_at_ms) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.accountId,
          organizationId,
          input.scope,
          version,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.payloadHash,
          deviceId,
          updatedAtMs,
        );
    } catch (error) {
      const latest = getDB()
        .prepare('SELECT version FROM account_sync_snapshots WHERE account_id = ? AND scope = ?')
        .get(input.accountId, input.scope) as { version?: number } | undefined;
      if (latest) throw new AccountSyncConflictError(Number(latest.version));
      throw error;
    }
  }

  return {
    scope: input.scope,
    version,
    payload,
    payloadHash: encrypted.payloadHash,
    deviceId,
    updatedAtMs,
  };
}
export type OrganizationView = OrganizationDirectoryView;

const organizationDirectoryStore = { db: getDB };

export const {
  getOrganization,
  listOrganizations,
  getEnterpriseOrganization,
  listEnterpriseOrganizations,
} = createOrganizationDirectoryFacade(organizationDirectoryStore);

export type OrganizationPositionRoleMapping =
  IdentityOrganizationPositionRoleMapping;
export type OrganizationPositionView = IdentityOrganizationPositionView;
export type OrganizationDepartmentView = IdentityOrganizationDepartmentView;

const organizationStructureStore = {
  db: getDB,
  logAudit: (
    event: string,
    employeeId: string | null,
    detail: string,
  organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export const {
  listOrganizationStructure,
  createOrganizationDepartment,
  updateOrganizationDepartment,
  deleteOrganizationDepartment,
  createOrganizationPosition,
  updateOrganizationPosition,
  deleteOrganizationPosition,
} = createOrganizationStructureFacade(organizationStructureStore);

export type OrganizationFeatures = IdentityOrganizationFeatures;

const organizationFeatureConfiguration = createOrganizationFeatureFacade({
  db: getDB,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
});

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
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
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
  }) =>
    logAudit(
      input.event,
      input.employeeId,
      input.message,
      input.organizationId,
    ),
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
  return isLicenseUsableForOrganizationFeatureInRepository(
    deploymentStore,
    feature,
  );
}

export function isLicenseRestricted(): boolean {
  return isLicenseRestrictedInRepository(deploymentStore);
}

const organizationFeatureAccess = createOrganizationFeatureAccessFacade({
  configuration: organizationFeatureConfiguration,
  isLicenseUsable: isLicenseUsableForOrganizationFeature,
});

export const {
  getOrganizationFeatures,
  updateOrganizationFeatures,
  isOrganizationFeatureEnabled,
  requireOrganizationFeature,
} = organizationFeatureAccess;

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

const memberDirectoryStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationExists: (organizationId: string) =>
    getOrganization(organizationId) !== null,
  resolveAssignmentIdentity,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export const { createEmployee, getEmployee, listEmployees, offboardEmployee } =
  createMemberDirectoryFacade(memberDirectoryStore);

const organizationInviteStore = {
  db: getDB,
  inviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  inviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  inviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  toOrganizationView: toOrganizationDirectoryView,
  resolveAssignmentIdentity,
  normalizeOptionalText,
  logAudit,
};

export const {
  normalizeOrganizationInviteCode,
  inspectOrganizationInvite,
  issueOrganizationInvite,
  getOrganizationInvite,
  resolveOrganizationInviteWithDefaults,
  resolveOrganizationInvite,
} = createOrganizationInviteFacade(organizationInviteStore);

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

const passwordHash = hashIdentitySecret;
const passwordMatches = identitySecretMatches;
const assertAccountPassword = assertIdentityAccountPassword;
export const isAcceptableAccountPassword =
  isAcceptableIdentityAccountPassword;

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

const accountDirectoryStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  normalizeIdentifier: normalizeUsername,
  normalizePhone,
  passwordMatches,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  toAccountView,
};

export const {
  getAccount,
  listAccounts,
  authenticateAccount,
  findAccountByPhone,
  findActiveAccountByPhone,
} = createAccountDirectoryFacade<AccountView, AccountRow>(accountDirectoryStore);

const accountLifecycleStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  normalizeUsername,
  normalizeOptionalPhone,
  normalizeOptionalFeishuOpenId,
  normalizeOptionalAvatarUrl,
  normalizeTags,
  assertPassword: assertAccountPassword,
  hashPassword: passwordHash,
  createId: (prefix: 'acc' | 'emp') => `${prefix}_${randomUUID()}`,
  createDeletionPasswordHash: () =>
    passwordHash(randomBytes(32).toString('base64url')),
  resolveAssignment(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
    },
  ) {
    const assignment = resolveAssignmentIdentity(
      database,
      organizationId,
      input,
    );
    const positionMapping = assignment.positionId
      ? (database
          .prepare(
            `SELECT role_mapping FROM organization_positions
             WHERE id = ? AND organization_id = ?`,
          )
          .get(assignment.positionId, organizationId) as
          | { role_mapping: OrganizationPositionRoleMapping }
          | undefined)
      : undefined;
    return {
      ...assignment,
      roleMapping: positionMapping?.role_mapping ?? null,
    };
  },
  createEmployee,
  getAccount,
  logAudit,
};

export const { createAccount, updateAccount, deleteAccount } =
  createAccountLifecycleFacade<AccountView>(accountLifecycleStore);

const organizationProvisioningStore = {
  db: getDB,
  now: Date.now,
  createOrganizationId: () => `org_${randomUUID()}`,
  createInviteSecret: () => randomBytes(32).toString('hex'),
  createDefaultSlugSuffix: () => randomBytes(5).toString('hex'),
  getOrganization,
  createAccount,
  issueOrganizationInvite,
  logAudit,
};

/** 企业、首位管理员和首个 7 天邀请要么全部成功，要么全部回滚。 */
export const { createOrganization, provisionOrganization } =
  createOrganizationProvisioningFacade<
    OrganizationView,
    AccountView,
    OrganizationInviteView
  >(organizationProvisioningStore);

const accountRegistrationStore = {
  db: getDB,
  now: Date.now,
  normalizePhone,
  findAccountByPhone,
  createId: (_prefix: 'emp') => `emp_${randomUUID()}`,
  createUsernameSuffix: () => randomBytes(4).toString('hex'),
  createPersonalSlugSuffix: () => randomBytes(8).toString('hex'),
  resolveAssignmentIdentity,
  createEmployee(input: {
    id: string;
    organizationId: string;
    name: string;
    role?: string;
    department?: string;
    departmentId?: string;
    positionId?: string;
    positionTitle?: string;
    inviteCode?: string;
  }) {
    const { inviteCode, ...employee } = input;
    return createEmployee({
      ...employee,
      invite_code: inviteCode,
    });
  },
  createAccount,
  createOrganization,
  getAccount,
  resolveOrganizationInviteWithDefaults,
  normalizeOrganizationInviteCode,
  replaceMigratedAccountTags(
    accountId: string,
    organizationId: string,
    tags: string[],
  ) {
    getDB()
      .prepare('DELETE FROM account_tags WHERE account_id = ?')
      .run(accountId);
    replaceAccountTagsInRepository(
      accountLifecycleStore,
      accountId,
      organizationId,
      tags,
    );
  },
  logAudit,
};

export const {
  createSelfRegisteredAccount,
  createPersonalRegisteredAccount,
  joinOrganizationWithInvite,
} = createAccountRegistrationFacade<AccountView, OrganizationView>(
  accountRegistrationStore,
);

const directMessageStore = {
  db: getDB,
  createId: randomUUID,
  getActiveAccountInOrganization: (
    accountId: string,
    organizationId: string,
  ) => {
    const account = getAccount(accountId, organizationId);
    return account?.status === 'active'
      ? { id: account.id, name: account.name }
      : null;
  },
};

export const {
  getDirectMessageAttachment,
  listDirectMessages,
  listPendingAtoaRequests,
  listUnreadDirectMessageNotifications,
  markAtoaRequestReadFromResponse,
  sendDirectMessage,
} = createDirectMessageFacade(directMessageStore);

export type AccountPresenceView = CollaborationAccountPresenceView;

const accountPresenceStore = {
  db: getDB,
  now: Date.now,
  isActiveAccountInOrganization: (accountId: string, organizationId: string) =>
    getAccount(accountId, organizationId)?.status === 'active',
};

export const { touchAccountPresence, listAccountPresence } =
  createAccountPresenceFacade(accountPresenceStore);

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

const authSessionStore = {
  db: getDB,
  now: Date.now,
  getAccount,
  isOrganizationActive: (organizationId: string) =>
    getOrganization(organizationId)?.status === 'active',
  toAccountView,
};

export const {
  createAuthSession,
  getAccountBySession,
  revokeAuthSession,
} = createAuthSessionFacade<AccountView, AccountRow>(authSessionStore);

const smsChallengeStore = {
  db: getDB,
  defaultOrganizationId: DEFAULT_ORGANIZATION_ID,
  getAccount,
  organizationExists: (organizationId: string) =>
    Boolean(getOrganization(organizationId)),
  normalizePhone,
  hashSecret: hashIdentitySecret,
  secretMatches: identitySecretMatches,
  createChallengeId: (kind: 'login' | 'registration') =>
    `${kind === 'login' ? 'sms' : 'smsreg'}_${randomUUID()}`,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
};

export type SmsChallengeIssueResult = IdentitySmsChallengeIssueResult;
export type SmsRegistrationVerifyResult = IdentitySmsRegistrationVerifyResult;
export type SmsChallengeVerifyResult =
  IdentitySmsChallengeVerifyResult<AccountView>;

export const {
  createSmsLoginChallenge,
  discardSmsLoginChallenge,
  verifySmsLoginChallenge,
  createSmsRegistrationChallenge,
  discardSmsRegistrationChallenge,
  verifySmsRegistrationChallenge,
} = createSmsChallengeFacade<AccountView>(smsChallengeStore);

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

const parkServiceStore = {
  db: getDB,
  getAccount,
  getPark,
  normalizeOptionalText,
};

export function listParkServices(parkId: string): ParkServiceView[] {
  return listParkServicesFromRepository(parkServiceStore, parkId);
}

export function updateParkService(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, string>;
}): ParkServiceView {
  return updateParkServiceInRepository(parkServiceStore, input);
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
      .all(park.id, park.adminOrganizationId) as OrganizationDirectoryRow[]
  ).map(toOrganizationDirectoryView);
}

const parkInviteStore = {
  db: getDB,
  getAccount,
  getPark,
  getParkForOrganization,
  inviteValidityMs: ORGANIZATION_INVITE_VALIDITY_MS,
  inviteAlphabet: ORGANIZATION_INVITE_ALPHABET,
  inviteCodeRawLength: INVITE_CODE_RAW_LENGTH,
  normalizeInviteCode: normalizeOrganizationInviteCode,
  normalizeOptionalText,
};

export function getParkTenantProfile(
  organizationId: string,
): ParkTenantProfileView | null {
  return getParkTenantProfileFromRepository(parkInviteStore, organizationId);
}

export function updateParkTenantProfile(input: {
  organizationId: string;
  actorAccountId: string;
  address: string;
  roomNumber: string;
}): ParkTenantProfileView {
  return updateParkTenantProfileInRepository(parkInviteStore, input);
}

const parkStatisticsStore = {
  db: getDB,
  getAccount,
  getPark,
  getParkForOrganization,
  getOrganizationFeatures,
  listAccounts,
  listParkTenantOrganizations,
  audit: (
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ) => logAudit(event, employeeId, detail, organizationId),
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

export function listParkDataStatisticsTasks(
  accountId: string,
): ParkDataStatisticsTaskView[] {
  return listParkDataStatisticsTasksFromRepository(
    parkStatisticsStore,
    accountId,
  );
}

export function markParkDataStatisticsRead(
  taskId: string,
  accountId: string,
): ParkDataStatisticsAssignmentView {
  return markParkDataStatisticsReadInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
  );
}

export function getParkDataStatisticsTemplate(
  taskId: string,
  accountId: string,
): {
  name: string;
  data: string;
} {
  return getParkDataStatisticsTemplateFromRepository(
    parkStatisticsStore,
    taskId,
    accountId,
  );
}

export function delegateParkDataStatistics(
  taskId: string,
  accountId: string,
  assigneeAccountId: string,
): ParkDataStatisticsAssignmentView {
  return delegateParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    assigneeAccountId,
  );
}

export function submitParkDataStatisticsDraft(
  taskId: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkDataStatisticsAssignmentView {
  return submitParkDataStatisticsDraftInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    responseData,
  );
}

export function reviewParkDataStatistics(
  taskId: string,
  accountId: string,
  approved: boolean,
  reason?: string,
): ParkDataStatisticsAssignmentView {
  return reviewParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    accountId,
    approved,
    reason,
  );
}

export function remindParkDataStatistics(
  taskId: string,
  adminAccountId: string,
): ParkDataStatisticsTaskView {
  return remindParkDataStatisticsInRepository(
    parkStatisticsStore,
    taskId,
    adminAccountId,
  );
}

export function returnParkDataStatistics(
  taskId: string,
  adminAccountId: string,
  organizationId: string,
  reason: string,
): ParkDataStatisticsAssignmentView {
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

export function issueParkInvite(input: {
  parkId: string;
  actorAccountId: string;
  maxUses?: number | null;
  now?: number;
}): ParkInviteView {
  return issueParkInviteFromRepository(parkInviteStore, input);
}

export function joinOrganizationToPark(input: {
  organizationId: string;
  actorAccountId: string;
  code: string;
  address: string;
  roomNumber: string;
  now?: number;
}): ParkView {
  return joinOrganizationToParkInRepository(parkInviteStore, input);
}

export function listParkServiceSpecialists(
  parkId: string,
): ParkServiceSpecialistView[] {
  return listParkServiceSpecialistsFromRepository(parkServiceStore, parkId);
}

export function setParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): ParkServiceSpecialistView {
  return setParkServiceSpecialistInRepository(parkServiceStore, input);
}

export function removeParkServiceSpecialist(input: {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}): void {
  removeParkServiceSpecialistFromRepository(parkServiceStore, input);
}

export {
  PARK_MEETING_CLOSE_MINUTES,
  PARK_MEETING_OPEN_MINUTES,
  PARK_MEETING_SLOT_MINUTES,
  PARK_MEETING_TIME_SLOTS,
  createParkMeetingRoom,
  deleteParkMeetingRoom,
  getParkSettings,
  listParkMeetingRooms,
  listParkMeetingSlots,
  reserveParkMeetingPeriod,
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
  listParkAnnouncementResults,
  listParkPublications,
  listParkSurveyResults,
  markParkPublicationRead,
  submitParkSurvey,
} from './parkPublicationRepository.js';
export type {
  ParkAnnouncementResultView,
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
// Task logging and reports
// ============================================================
export { getReport, getTaskHistory, logTask } from './taskReportRepository.js';

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
export { getAuditLogs, logAudit } from './auditRepository.js';

// ============================================================
// Export all (for backup)
// ============================================================
export function exportAll(organizationId = DEFAULT_ORGANIZATION_ID) {
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
