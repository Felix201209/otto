/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 脱敏诊断包生成器（NSI-10）。
 *
 * 诊断包与「个人数据导出」（exportAccountDataFromRepository）不同：
 *  - 不含聊天原文（消息正文一律不进入诊断包，只保留数量与归档统计）；
 *  - 不含可识别个人信息（username / name / phone / feishu_open_id 等一律脱敏为计数）；
 *  - 聚焦于「结构健康 + 部署配置 + 处理目录」的诊断视图；
 *  - 附带 redaction 清单，说明为何脱敏以及管理员如何获取脱敏后的副本。
 */

import type { Database } from '../data_platform/index.js';
import {
  CURRENT_LEGAL_DOCUMENTS,
  dataGovernanceConfiguration,
  dataProcessingInventory,
  legalDocumentHash,
} from './legalDocuments.js';
import type { DataGovernanceRepositoryStore } from './dataGovernanceRepository.js';

/**
 * 诊断包的顶层结构。所有可识别内容均为「计数」或「已脱敏」标记，
 * 不携带任何聊天原文或个人可识别字段值。
 */
export interface RedactedDiagnosticPackage {
  schemaVersion: 1;
  generatedAt: string;
  /** 部署与数据治理配置（来自 dataGovernanceConfiguration，无个人数据）。 */
  configuration: ReturnType<typeof dataGovernanceConfiguration>;
  /** 数据处理活动目录（处理目的 / 存储位置 / 保留期限），无个人数据。 */
  processingActivities: ReturnType<typeof dataProcessingInventory>;
  /** 法律文档清单与哈希，便于确认诊断包对应版本。 */
  legalDocuments: Array<{ id: string; version: string; hash: string }>;
  /** 结构健康快照：各实体计数 + 若干可诊断指标。 */
  health: {
    counts: Record<string, number>;
    indicators: Record<string, string | number | boolean>;
  };
  /** 脱敏清单：说明本包默认不包含哪些数据、为什么，以及如何获取全量副本。 */
  redaction: {
    applied: boolean;
    excluded: Array<{ data: string; reason: string }>;
    note: string;
  };
}

function countIf(database: Database, table: string, where = ''): number {
  try {
    database.prepare(`SELECT 1 FROM ${table} LIMIT 1`);
  } catch {
    return 0;
  }
  const row = database.prepare(
    `SELECT COUNT(*) AS total FROM ${table}${where ? ` ${where}` : ''}`,
  ).get() as { total: number };
  return Number(row?.total ?? 0);
}

function rowCount(database: Database, sql: string, ...params: unknown[]): number {
  const row = database.prepare(sql).get(...params) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/**
 * 构建默认脱敏的诊断包。
 * 不要求 account（可无上下文运行），也不向磁盘写任何东西——纯内存快照。
 */
export function buildRedactedDiagnosticPackage(store: DataGovernanceRepositoryStore): RedactedDiagnosticPackage {
  const database = store.db();
  const now = store.now();

  const counts: Record<string, number> = {
    organizations: countIf(database, 'organizations'),
    accounts: countIf(database, 'accounts'),
    employees: countIf(database, 'employees'),
    activeAccounts: rowCount(
      database,
      "SELECT COUNT(*) AS total FROM accounts WHERE status = 'active'",
    ),
    admins: rowCount(
      database,
      'SELECT COUNT(*) AS total FROM accounts WHERE is_admin = 1',
    ),
    directMessages: countIf(database, 'direct_messages'),
    messageAttachments: countIf(database, 'direct_message_attachments'),
    itTickets: countIf(database, 'it_tickets'),
    openTickets: rowCount(
      database,
      "SELECT COUNT(*) AS total FROM it_tickets WHERE status NOT IN ('closed', 'cancelled')",
    ),
    enterpriseSkills: countIf(database, 'enterprise_skills'),
    knowledge: countIf(database, 'knowledge'),
    legalConsents: countIf(database, 'legal_consents'),
    privacyRequests: countIf(database, 'privacy_requests'),
    tokenUsageRecords: countIf(database, 'account_token_usage'),
    taskLogs: countIf(database, 'task_logs'),
    auditLogs: countIf(database, 'audit_logs'),
  };

  // 消息相关：只给数量与「存在性」，绝不取 content。
  let messageSizeBytes = 0;
  try {
    const row = database.prepare(
      `SELECT COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM direct_messages`,
    ).get() as { bytes: number };
    messageSizeBytes = Number(row?.bytes ?? 0);
  } catch {
    messageSizeBytes = 0;
  }

  const storageVolumeEncrypted = process.env.OTTO_STORAGE_VOLUME_ENCRYPTED === 'true';
  const hasFieldCipher = Boolean(store.fieldCipher);
  const hasAttachmentStore = Boolean(store.attachmentObjectStore);

  const indicators: Record<string, string | number | boolean> = {
    messagePayloadBytes: messageSizeBytes,
    storageVolumeEncrypted,
    messageFieldsEncrypted: hasFieldCipher,
    attachmentObjectsEncrypted: hasAttachmentStore,
    dataResidency: process.env.OTTO_DATA_RESIDENCY?.trim() || 'customer_server',
    crossBorderEnabled: process.env.OTTO_CROSS_BORDER_DATA_ENABLED === 'true',
    retentionAuditDays: storeRetentionDays(),
    // 诊断包本身的脱敏说明：默认不含聊天原文。
    containsChatContent: false,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    configuration: dataGovernanceConfiguration(),
    processingActivities: dataProcessingInventory(),
    legalDocuments: CURRENT_LEGAL_DOCUMENTS.map((document) => ({
      id: document.id,
      version: document.version,
      hash: legalDocumentHash(document),
    })),
    health: {
      counts,
      indicators,
    },
    redaction: {
      applied: true,
      excluded: [
        { data: 'direct_messages.content', reason: '聊天原文不得进入默认诊断包' },
        { data: 'direct_message_attachments object bytes', reason: '附件对象内容不属于结构诊断' },
        { data: 'accounts.username / name / phone / feishu_open_id', reason: '可识别个人信息默认脱敏' },
        { data: 'employees.name / invite_code / personality', reason: '可识别个人信息默认脱敏' },
        { data: 'it_tickets.contact / contact_phone / description / form_data', reason: '工单可能含个人或敏感信息，默认脱敏' },
        { data: 'audit_logs.detail / employee_id', reason: '审计详情可能含上下文，默认脱敏' },
      ],
      note: '诊断包默认不含聊天原文与个人可识别内容。如需对单账号进行受法律约束的完整导出，请使用企业隐私界面中的「导出本人数据」；该导出需要账号权限并受访问控制保护。',
    },
  };
}

function storeRetentionDays(): number {
  const configured = Number(process.env.OTTO_TELEMETRY_RETENTION_DAYS || 90);
  return Number.isFinite(configured) ? Math.max(1, Math.min(3650, Math.floor(configured))) : 90;
}
